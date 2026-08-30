import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toolsForRole } from '../../src/mcp/registry';

/**
 * STRUCTURAL TRIPWIRES.
 *
 * These do not test behaviour. They test that the SHAPE which makes the
 * behaviour hard to get wrong is still in place — so a refactor that quietly
 * removes the shape fails CI rather than review.
 *
 * They live in the node project because they read the source tree, and the
 * workers project runs inside workerd where there is no filesystem.
 */
function walk(dir: string, pred: (path: string, src: string) => boolean): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) hits.push(...walk(p, pred));
    else if (p.endsWith('.ts') && pred(p, readFileSync(p, 'utf8'))) hits.push(p);
  }
  return hits;
}

describe('the enforcement shape is intact', () => {
  it('the D1 binding is referenced in exactly one implementation module', () => {
    const hits = walk('src', (_p, src) => /\benv\.DB\b|\bDB:\s*D1Database\b/.test(src)).sort();
    // types.ts DECLARES the binding; scoped-db.ts USES it. Nothing else may
    // touch it — if this list grows, someone has routed around ScopedDb.
    expect(hits).toEqual(['src/db/scoped-db.ts', 'src/types.ts']);
  });

  it('no module outside ScopedDb builds SQL against the billing tables', () => {
    const hits = walk('src', (p, src) =>
      !p.endsWith('scoped-db.ts') && /\bFROM\s+(invoices|invoice_line_items|usage_records|accounts)\b/i.test(src));
    expect(hits).toEqual([]);
  });

  it('no agent-callable apply-credit path exists anywhere in src', () => {
    const hits = walk('src', (_p, src) =>
      /(function|const|case)\s+['"`]?\w*apply_?[Cc]redit/.test(src));
    expect(hits).toEqual([]);
  });

  it('a customer manifest does not contain propose_credit', () => {
    expect(toolsForRole('customer').map((t) => t.name)).not.toContain('billing_propose_credit');
    expect(toolsForRole('support_engineer').map((t) => t.name)).toContain('billing_propose_credit');
  });

  it('every write tool is registered to internal roles only', () => {
    const customerTools = new Set(toolsForRole('customer').map((t) => t.name));
    const writes = toolsForRole('support_engineer').filter((t) => t.access === 'write');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(customerTools.has(w.name)).toBe(false);
  });

  it('the audit DDL is not loaded into D1', () => {
    // The audit log lives in the Durable Object's own storage. If its DDL
    // reappears in schema.sql there are two tables and only one gets written.
    expect(readFileSync('schema.sql', 'utf8')).not.toMatch(/CREATE TABLE audit_log/);
    expect(readFileSync('src/audit/audit-do.ts', 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS audit_log/);
  });
});
