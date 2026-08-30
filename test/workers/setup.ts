import { env } from 'cloudflare:test';
// Vite `?raw` imports: the worker sandbox has no filesystem, so the SQL is
// inlined at bundle time rather than read with node:fs.
import schemaSql from '../../schema.sql?raw';
import seedSql from '../../seed.sql?raw';

/**
 * Split SQL on statement boundaries while respecting BEGIN ... END blocks.
 * A naive split on ';' corrupts trigger bodies — which is how the first
 * version of this file silently loaded half a schema and then swallowed the
 * errors with a .catch(), producing test failures that pointed nowhere.
 */
function statements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.replace(/--.*$/, '');
    if (!line.trim()) continue;
    // Transaction control is the harness's business, not the fixture's.
    // (Counting `BEGIN TRANSACTION` as a block opener is what made the first
    // version concatenate the entire seed into one 400-statement string and
    // fail with SQLITE_TOOBIG.)
    if (/^\s*(BEGIN\s+TRANSACTION|COMMIT|BEGIN)\s*;\s*$/i.test(line)) continue;

    buf += line + '\n';
    if (/\bBEGIN\b/i.test(line) && !/\bBEGIN\s+TRANSACTION\b/i.test(line)) depth++;
    if (/\bEND\s*;/i.test(line)) depth--;
    if (depth <= 0 && /;\s*$/.test(line.trim())) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt.replace(/;$/, ''));
      buf = '';
      depth = 0;
    }
  }
  if (buf.trim()) out.push(buf.trim().replace(/;$/, ''));
  return out;
}

async function load(label: string, sql: string) {
  const stmts = statements(sql);
  const batch = stmts.map((s) => env.DB.prepare(s));
  try {
    await env.DB.batch(batch);
  } catch (err) {
    // Fail loudly. A half-loaded fixture produces test failures that look like
    // application bugs, and that is a worse outcome than not running at all.
    throw new Error(`${label}: failed to load (${stmts.length} statements): ${(err as Error).message}`);
  }
}

const already = await env.DB
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
  .first();

if (!already) {
  await load('schema.sql', schemaSql);
  await load('seed.sql', seedSql);
}
