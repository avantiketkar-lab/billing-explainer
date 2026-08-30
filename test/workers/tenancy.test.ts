import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ScopedDb } from '../../src/db/scoped-db';
import { ScopeViolation } from '../../src/types';

const NORTHWIND = 'acct_01H8NORTHWIND';
const HARBORLIGHT = 'acct_02H8HARBORLIGHT';

const northwindCustomer = {
  principal_id: 'cust_nw_01',
  role: 'customer' as const,
  account_scope: [NORTHWIND],
  session_id: 'sess_test_1',
  token_jti: 'jti_test_1',
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const supportEngineer = {
  ...northwindCustomer,
  principal_id: 'eng_demo_01',
  role: 'support_engineer' as const,
  account_scope: [NORTHWIND, HARBORLIGHT],
  session_id: 'sess_test_2',
};

async function harborlightInvoiceId(): Promise<string> {
  const row = await env.DB
    .prepare('SELECT invoice_id FROM invoices WHERE account_id = ?1 LIMIT 1')
    .bind(HARBORLIGHT)
    .first<{ invoice_id: string }>();
  if (!row) throw new Error('fixture not loaded: no Harborlight invoice');
  return row.invoice_id;
}

// ---------------------------------------------------------------------------
// THE TEST THAT MATTERS.
//
// Written to fail loudly if the scope predicate is ever refactored out of the
// query builder — including via the plausible-looking change where a handler
// "just fetches the invoice and checks ownership afterwards".
// ---------------------------------------------------------------------------
describe('cross-tenant reads are denied', () => {
  it('the fixture actually loaded', async () => {
    const n = await env.DB.prepare('SELECT COUNT(*) c FROM invoices').first<{ c: number }>();
    expect(n!.c).toBe(6);
  });

  it('a Northwind-scoped customer cannot read a Harborlight invoice', async () => {
    const db = new ScopedDb(env as any, northwindCustomer);
    const id = await harborlightInvoiceId();

    // Indistinguishable from "not found", by design.
    expect(await db.invoiceById(id)).toBeNull();

    // And the line items must not leak even given the invoice id directly.
    // THIS is the assertion that fails if account_id is dropped from
    // invoice_line_items or from the WHERE clause.
    expect(await db.lineItemsForInvoice(id)).toHaveLength(0);
  });

  it('a support engineer scoped to both CAN read it — so the test above is meaningful', async () => {
    const db = new ScopedDb(env as any, supportEngineer);
    const id = await harborlightInvoiceId();
    expect(await db.invoiceById(id)).not.toBeNull();
    expect((await db.lineItemsForInvoice(id)).length).toBeGreaterThan(0);
  });

  it('an out-of-scope selector throws ScopeViolation rather than returning data', async () => {
    const db = new ScopedDb(env as any, northwindCustomer);
    await expect(db.usageSeries(HARBORLIGHT, 'api_requests_m', '2026-07-01', '2026-07-31'))
      .rejects.toBeInstanceOf(ScopeViolation);
  });

  it('ScopedDb exposes no castable path to the raw database', () => {
    const db = new ScopedDb(env as any, northwindCustomer);
    expect((db as any).db).toBeUndefined();
    expect(Object.keys(db)).not.toContain('db');
    expect((db as any).prepare).toBeUndefined();
    expect((db as any).exec).toBeUndefined();
    expect((db as any).batch).toBeUndefined();
  });

  it('customer-scoped subscription history omits internal actor columns', async () => {
    const rows = await new ScopedDb(env as any, northwindCustomer)
      .subscriptionHistory(NORTHWIND, '2026-06-01', '2026-07-31');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows as Record<string, unknown>[]) {
      expect(r).not.toHaveProperty('actor_id');
      expect(r).not.toHaveProperty('source_system');
    }
  });

  it('the same query as an internal caller DOES include them', async () => {
    const rows = await new ScopedDb(env as any, supportEngineer)
      .subscriptionHistory(NORTHWIND, '2026-06-01', '2026-07-31');
    expect((rows[0] as Record<string, unknown>)).toHaveProperty('actor_id');
  });
});

// ---------------------------------------------------------------------------
// The comparison the whole demo rests on, asserted against the real fixture.
// ---------------------------------------------------------------------------
describe('the July comparison reconciles', () => {
  it('June -> July is +$271.16 and the ranked causes sum to it exactly', async () => {
    const { compareInvoices } = await import('../../src/mcp/tools/compare-invoices');
    const db = new ScopedDb(env as any, northwindCustomer);
    const jun = await db.invoiceByPeriod(NORTHWIND, '2026-06-01') as any;
    const jul = await db.invoiceByPeriod(NORTHWIND, '2026-07-01') as any;

    const cmp = await compareInvoices(db, jun.invoice_id, jul.invoice_id);

    expect(cmp.total_delta_cents).toBe(27116);
    expect(cmp.pct_change).toBeCloseTo(39.994, 2);
    expect(cmp.reconciled).toBe(true);

    const byKey = Object.fromEntries(cmp.lines.map((l) => [l.line_key, l.delta_cents]));
    expect(byKey['usage:api_requests_m:overage']).toBe(12800);
    expect(byKey['addon:ADVANCED_SECURITY:proration']).toBe(8516);
    expect(byKey['discount:LAUNCH_CREDIT:discount']).toBe(5000);

    // Ranked by absolute contribution, largest first.
    const deltas = cmp.lines.map((l) => Math.abs(l.delta_cents));
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
  });
});

// ---------------------------------------------------------------------------
// The enforcement path itself, exercised directly.
//
// This calls `withAudit` rather than driving JSON-RPC, deliberately: the MCP
// SDK pulls CJS dependencies that the Workers test runtime cannot load, and
// more importantly a security boundary that can only be tested end-to-end is
// one that in practice does not get tested. The transport is a thin adapter
// over exactly this function.
// ---------------------------------------------------------------------------
describe('the enforcement path denies and records', () => {
  it('an out-of-scope call is denied and the denial is written to the audit log', async () => {
    const { withAudit, dispatch } = await import('../../src/mcp/guard');
    const principal = { ...northwindCustomer, session_id: 'sess_audit_1', token_jti: 'jti_audit_1' };

    await expect(
      withAudit(env as any, principal, 'billing_get_usage_series', 'account_id',
        { account_id: HARBORLIGHT, metric: 'api_requests_m', from: '2026-07-01', to: '2026-07-31' },
        (db) => dispatch('billing_get_usage_series', db, env as any,
          { account_id: HARBORLIGHT, metric: 'api_requests_m', from: '2026-07-01', to: '2026-07-31' }, 'https://x')),
    ).rejects.toBeInstanceOf(ScopeViolation);

    const stub: any = env.AUDIT.get(env.AUDIT.idFromName('global'));
    const entries = await stub.read({ session_id: 'sess_audit_1', limit: 20 });
    const denial = entries.find((e: any) => e.decision === 'denied');

    expect(denial, 'expected a denial entry in the audit log').toBeTruthy();
    expect(denial.requested_scope).toBe(HARBORLIGHT);
    expect(denial.resolved_scope).toBe(NORTHWIND);
    expect(denial.tool_name).toBe('billing_get_usage_series');
    expect(denial.result_hash).toBeNull();   // the payload is never in the log
  });

  it('an in-scope call is allowed and logs a result HASH, not the payload', async () => {
    const { withAudit, dispatch } = await import('../../src/mcp/guard');
    const principal = { ...northwindCustomer, session_id: 'sess_allow_1', token_jti: 'jti_allow_1' };

    const out: any = await withAudit(env as any, principal, 'billing_find_invoice', 'account_id',
      { account_id: NORTHWIND, period_start: '2026-07-01' },
      (db) => dispatch('billing_find_invoice', db, env as any,
        { account_id: NORTHWIND, period_start: '2026-07-01' }, 'https://x'));
    expect(out.total_cents).toBe(94916);

    const stub: any = env.AUDIT.get(env.AUDIT.idFromName('global'));
    const [entry] = await stub.read({ session_id: 'sess_allow_1', limit: 1 });
    expect(entry.decision).toBe('allowed');
    expect(entry.result_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.arguments_redacted).not.toContain('94916');
  });

  it('the audit chain verifies', async () => {
    const stub: any = env.AUDIT.get(env.AUDIT.idFromName('global'));
    const result = await stub.verify();
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
  });

  it('the role-scoped manifest omits the write tool for customers', async () => {
    const { toolsForRole } = await import('../../src/mcp/registry');
    expect(toolsForRole('customer').map((t) => t.name)).not.toContain('billing_propose_credit');
    expect(toolsForRole('support_engineer').map((t) => t.name)).toContain('billing_propose_credit');
  });
});
