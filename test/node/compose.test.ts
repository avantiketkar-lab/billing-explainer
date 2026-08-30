import { describe, it, expect } from 'vitest';
import { validateExplanation, deterministicFallback, type EvidenceBundle } from '../../src/agent/compose';
import type { LineSide } from '../../src/mcp/tools/compare-invoices';

/** Only amount_cents matters to the validator; the rest is shape. */
const side = (amount_cents: number): LineSide => ({
  quantity: null, included_qty: null, billable_qty: null,
  unit_price_cents: null, amount_cents,
});

const bundle: EvidenceBundle = {
  question: 'why up in July?',
  account: { account_id: 'acct_01H8NORTHWIND', name: 'Northwind Analytics' },
  comparison: {
    invoice_a: { invoice_id: 'inv_A', period_start: '2026-06-01', total_cents: 67800 },
    invoice_b: { invoice_id: 'inv_B', period_start: '2026-07-01', total_cents: 94916 },
    total_delta_cents: 27116, pct_change: 39.994, reconciled: true,
    lines: [
      { line_key: 'usage:api_requests_m:overage', kind: 'overage', metric: 'api_requests_m',
        status: 'changed', delta_cents: 12800, contribution_pct: 47.2,
        a: side(10400), b: side(23200), proration: null },
      { line_key: 'addon:ADVANCED_SECURITY:proration', kind: 'proration', metric: null,
        status: 'added', delta_cents: 8516, contribution_pct: 31.4,
        a: null, b: side(8516),
        proration: { numerator: 16, denominator: 31, from: '2026-07-16', to: '2026-07-31' } },
      { line_key: 'discount:LAUNCH_CREDIT:discount', kind: 'discount', metric: null,
        status: 'removed', delta_cents: 5000, contribution_pct: 18.4,
        a: side(-5000), b: null, proration: null },
    ],
  },
  usage: [{ metric: 'api_requests_m', step_changes: [{ date: '2026-07-09', pct: 52.1 }], total: 216, daily_mean: 6.97 }],
  changeEvents: [{ event_id: 'evt_ABC', change_type: 'addon_added' }],
  rateCard: {},
};

const good = `Northwind's July invoice rose by $271.16. API request overage grew by $128.00 [usage:api_requests_m:overage], driven by a step change on 9 July [api_requests_m@2026-07-09]. The Advanced Security add-on was activated mid-period and billed 16 of 31 days, adding $85.16 [addon:ADVANCED_SECURITY:proration] [event:evt_ABC]. The LAUNCH_CREDIT discount expired, removing $50.00 of credit [discount:LAUNCH_CREDIT:discount].`;

const hallucinatedCitation = good + ` Storage costs also rose [usage:storage_gb:overage].`;
const inventedNumber       = good + ` A further $19.99 came from taxes [usage:api_requests_m:overage].`;
const commitment           = good + ` We will credit your account [discount:LAUNCH_CREDIT:discount].`;
const unreconciled = { ...bundle, comparison: { ...bundle.comparison, reconciled: false } };

describe('the composition validator catches what the prompt only asks for', () => {
  it('accepts an answer whose every figure and citation is in the evidence', () => {
    expect(validateExplanation(good, bundle).ok).toBe(true);
  });

  it('rejects a citation that does not resolve to the evidence', () => {
    const r = validateExplanation(hallucinatedCitation, bundle);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('usage:storage_gb:overage');
  });

  it('rejects a money figure the model produced rather than read', () => {
    const r = validateExplanation(inventedNumber, bundle);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('$19.99');
  });

  it('rejects a commitment — explanations may not promise remedies', () => {
    expect(validateExplanation(commitment, bundle).ok).toBe(false);
  });

  it('requires an unreconciled comparison to be disclosed in the first sentence', () => {
    expect(validateExplanation(good, unreconciled).ok).toBe(false);
  });

  it('falls back to the computed ranking rather than showing unvalidated prose', () => {
    const out = deterministicFallback(bundle);
    expect(out).toContain('withheld');
    expect(out).toContain('$271.16');
    expect(out).toContain('usage:api_requests_m:overage');
    expect(out).not.toContain('undefined');
  });
});
