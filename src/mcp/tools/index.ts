import type { ScopedDb } from '../../db/scoped-db';
import { ScopeViolation } from '../../types';
import { sha256Hex } from '../../audit/hash';

export { compareInvoices } from './compare-invoices';

export async function resolveAccount(db: ScopedDb, identifier: string) {
  const row = await db.resolveAccount(identifier);
  if (!row) throw new ScopeViolation(identifier);
  return row;
}

export async function findInvoice(db: ScopedDb, accountId: string, periodStart: string) {
  const row = await db.invoiceByPeriod(accountId, periodStart);
  if (!row) throw new ScopeViolation(`${accountId}:${periodStart}`);
  return row;
}

export async function getInvoice(db: ScopedDb, invoiceId: string) {
  const invoice = await db.invoiceById(invoiceId);
  if (!invoice) throw new ScopeViolation(invoiceId);
  const lines = await db.lineItemsForInvoice(invoiceId);
  return { ...invoice, lines };
}

/**
 * Returns the series plus DETECTED STEP CHANGES. The date a step began is the
 * evidentiary detail that lets an explanation say "usage stepped up on 9 July
 * and stayed there" rather than "usage was higher" — and it is deterministic
 * arithmetic, so it belongs here rather than in the model.
 */
export async function getUsageSeries(
  db: ScopedDb, accountId: string, metric: string, from: string, to: string,
) {
  const rows = (await db.usageSeries(accountId, metric, from, to)) as { usage_date: string; quantity: number }[];
  const total = rows.reduce((a, r) => a + r.quantity, 0);
  const mean = rows.length ? total / rows.length : 0;

  // A step is a day where the trailing mean shifts by >25% and holds for >=3 days.
  const steps: { date: string; from_daily_mean: number; to_daily_mean: number; pct: number }[] = [];
  for (let i = 3; i < rows.length - 2; i++) {
    const before = rows.slice(Math.max(0, i - 5), i);
    const after = rows.slice(i, i + 5);
    const mb = before.reduce((a, r) => a + r.quantity, 0) / (before.length || 1);
    const ma = after.reduce((a, r) => a + r.quantity, 0) / (after.length || 1);
    if (mb > 0 && (ma - mb) / mb > 0.25 && !steps.some((s) => rows.findIndex((r) => r.usage_date === s.date) > i - 5)) {
      steps.push({
        date: rows[i].usage_date,
        from_daily_mean: Number(mb.toFixed(3)),
        to_daily_mean: Number(ma.toFixed(3)),
        pct: Number((((ma - mb) / mb) * 100).toFixed(1)),
      });
    }
  }

  return {
    account_id: accountId, metric, from, to,
    total: Number(total.toFixed(3)),
    daily_mean: Number(mean.toFixed(3)),
    step_changes: steps,
    series: rows,
  };
}

export async function getSubscriptionHistory(db: ScopedDb, accountId: string, from: string, to: string) {
  return { account_id: accountId, from, to, events: await db.subscriptionHistory(accountId, from, to) };
}

export async function getRateCard(db: ScopedDb, accountId: string, asOf: string) {
  const card = await db.rateCardAsOf(accountId, asOf);
  if (!card) throw new ScopeViolation(accountId);
  // List pricing only. Account-specific discounts deliberately not joined —
  // see docs/data-model.md §5.4.
  return { as_of: asOf, ...card };
}

/**
 * THE ONLY WRITE TOOL, and it does not move money.
 *
 * It creates a PENDING proposal and returns an approval URL. Application
 * happens server-side after a human — never the proposing principal — approves
 * in a separately authenticated surface. There is no agent-callable apply path
 * anywhere in this codebase; grep for `apply_credit` and you will find only
 * this comment.
 */
export async function proposeCredit(
  db: ScopedDb,
  env: { SESSION_SECRET: string },
  args: {
    account_id: string; amount_cents: number; reason: string;
    evidence_refs: { ref_type: string; ref_id: string }[];
  },
  publicBase: string,
) {
  db.assertInScope(args.account_id);

  const proposal_id = crypto.randomUUID();
  const approvalToken = crypto.randomUUID();
  const approval_token_hash = await sha256Hex(approvalToken + env.SESSION_SECRET);
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 864e5);

  await db.insertCreditProposal({
    proposal_id,
    account_id: args.account_id,
    amount_cents: args.amount_cents,
    currency: 'USD',
    reason: args.reason,
    approval_token_hash,
    expires_at: expires.toISOString(),
    created_at: now.toISOString(),
  });
  // Evidence refs are validated against the proposal's account at write time,
  // so a proposal cannot carry another account's invoice into a human UI.
  await db.attachEvidence(proposal_id, args.account_id, args.evidence_refs);

  return {
    proposal_id,
    status: 'PENDING' as const,
    amount_cents: args.amount_cents,
    // The approving human follows this. The model never holds the credential
    // that makes approval effective.
    approval_url: `${publicBase}/approve/${proposal_id}?t=${approvalToken}`,
    note: 'No credit has been applied. A human must approve this proposal.',
  };
}

export async function getProposalStatus(db: ScopedDb, proposalId: string) {
  const row = await db.proposalStatus(proposalId);
  if (!row) throw new ScopeViolation(proposalId);
  return row;
}
