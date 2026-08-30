import type { Env, Principal } from '../types';
import { ScopeViolation } from '../types';

/**
 * ScopedDb — the ONLY route from a tool handler to D1.
 *
 * WHY THIS SHAPE, structurally:
 *
 *  1. The D1 binding is held in a `#private` field. Not TypeScript `private`,
 *     which is erased at compile time and defeated by `(db as any).db` — a hard
 *     ECMAScript private field, which is not reachable by casting, by
 *     Object.keys, by JSON.stringify, or by a Proxy. A handler that wants the
 *     raw binding cannot get it. There is nothing to remember and nothing for a
 *     reviewer to catch.
 *
 *  2. This class exposes named repository methods, not a query interface. There
 *     is no `prepare`, no `exec`, no `batch`. Adding a new query is a change to
 *     this file, which is the file the tenancy tests are written against.
 *
 *  3. The scope predicate is appended by this class from `#scope`, which is set
 *     once in the constructor from the Principal. No method accepts a scope
 *     argument, so no caller can widen it.
 *
 *  4. `env.DB` is referenced in this module and nowhere else in src/.
 *     test/tenancy.test.ts asserts that by scanning the source tree, so a
 *     future handler that reaches around this class fails CI rather than
 *     review.
 *
 * The rule this encodes: account_id in tool arguments is a SELECTOR, never an
 * authorization claim.
 */
export class ScopedDb {
  #db: D1Database;
  readonly #scope: readonly string[];
  readonly principal: Principal;

  constructor(env: Env, principal: Principal) {
    this.#db = env.DB;
    this.#scope = principal.account_scope;
    this.principal = principal;
  }

  /** `account_id IN (?,?,...)` fragment plus its bindings. */
  #scopeClause(): { sql: string; binds: string[] } {
    if (this.#scope.length === 0) return { sql: 'account_id IN (NULL)', binds: [] };
    return {
      sql: `account_id IN (${this.#scope.map(() => '?').join(',')})`,
      binds: [...this.#scope],
    };
  }

  /**
   * Assert that a selector the caller supplied falls inside scope.
   * Call this on any account_id that arrived as a tool argument.
   */
  assertInScope(accountId: string): string {
    if (!this.#scope.includes(accountId)) throw new ScopeViolation(accountId);
    return accountId;
  }

  get scope(): readonly string[] {
    return this.#scope;
  }

  // -------------------------------------------------------------------------
  // Repository methods. Every one of them carries the scope predicate in the
  // SAME WHERE clause as its selector — never in a preceding query.
  // -------------------------------------------------------------------------

  async resolveAccount(identifier: string) {
    const { sql, binds } = this.#scopeClause();
    return this.#db
      .prepare(
        `SELECT account_id, name, status, currency, billing_anchor
           FROM accounts
          WHERE (account_id = ?1 OR lower(name) = lower(?1))
            AND ${sql}
          LIMIT 1`,
      )
      .bind(identifier, ...binds)
      .first();
  }

  async invoiceById(invoiceId: string) {
    const { sql, binds } = this.#scopeClause();
    return this.#db
      .prepare(
        `SELECT invoice_id, account_id, period_start, period_end, status, currency,
                subtotal_cents, discount_cents, total_cents, issued_at, rate_card_id
           FROM invoices
          WHERE invoice_id = ?1 AND ${sql}`,
      )
      .bind(invoiceId, ...binds)
      .first();
  }

  async invoiceByPeriod(accountId: string, periodStart: string) {
    this.assertInScope(accountId);
    return this.#db
      .prepare(
        `SELECT invoice_id, account_id, period_start, period_end, status, currency,
                subtotal_cents, discount_cents, total_cents, issued_at, rate_card_id
           FROM invoices
          WHERE account_id = ?1 AND period_start = ?2`,
      )
      .bind(accountId, periodStart)
      .first();
  }

  /**
   * NOTE the shape: filtered by invoice_id AND account_id together. The
   * denormalised account_id on invoice_line_items exists precisely so this
   * query does not depend on a prior ownership check having been remembered.
   */
  async lineItemsForInvoice(invoiceId: string) {
    const { sql, binds } = this.#scopeClause();
    const r = await this.#db
      .prepare(
        `SELECT line_id, invoice_id, line_key, kind, product_code, metric,
                quantity, included_qty, billable_qty, unit_price_cents, amount_cents,
                is_prorated, proration_numerator, proration_denominator,
                proration_from, proration_to, source_ref
           FROM invoice_line_items
          WHERE invoice_id = ?1 AND ${sql}
          ORDER BY line_key`,
      )
      .bind(invoiceId, ...binds)
      .all();
    return r.results ?? [];
  }

  async usageSeries(accountId: string, metric: string, from: string, to: string) {
    this.assertInScope(accountId);
    const r = await this.#db
      .prepare(
        `SELECT usage_date, quantity
           FROM usage_records
          WHERE account_id = ?1 AND metric = ?2
            AND usage_date >= ?3 AND usage_date <= ?4
          ORDER BY usage_date`,
      )
      .bind(accountId, metric, from, to)
      .all();
    return r.results ?? [];
  }

  /**
   * Column projection is role-dependent: actor_id / actor_type / source_system
   * name internal staff and systems, and a correctly-scoped customer still must
   * not learn that a named support agent touched their account.
   */
  async subscriptionHistory(accountId: string, from: string, to: string) {
    this.assertInScope(accountId);
    const internal = this.principal.role === 'support_engineer';
    const cols = internal
      ? `event_id, occurred_at, effective_at, change_type, from_value, to_value,
         proration_applied, actor_type, actor_id, source_system`
      : `event_id, effective_at, change_type, from_value, to_value, proration_applied`;
    const r = await this.#db
      .prepare(
        `SELECT ${cols}
           FROM subscription_change_events
          WHERE account_id = ?1 AND effective_at >= ?2 AND effective_at <= ?3
          ORDER BY effective_at`,
      )
      .bind(accountId, from, to)
      .all();
    return r.results ?? [];
  }

  /**
   * Catalogue data only. Deliberately does NOT join `discounts`, which are
   * account-specific and commercially sensitive — see docs/data-model.md §5.4.
   */
  async rateCardAsOf(accountId: string, asOf: string) {
    this.assertInScope(accountId);
    const card = await this.#db
      .prepare(
        `SELECT rc.rate_card_id, rc.plan_id, p.code AS plan_code, rc.base_cents,
                rc.effective_from, rc.effective_to
           FROM subscriptions s
           JOIN plans p       ON p.plan_id = s.plan_id
           JOIN rate_cards rc ON rc.plan_id = s.plan_id
          WHERE s.account_id = ?1
            AND s.effective_from <= ?2 AND (s.effective_to  IS NULL OR ?2 < s.effective_to)
            AND rc.effective_from <= ?2 AND (rc.effective_to IS NULL OR ?2 < rc.effective_to)
          LIMIT 1`,
      )
      .bind(accountId, asOf)
      .first<{ rate_card_id: string }>();
    if (!card) return null;
    const items = await this.#db
      .prepare(
        `SELECT metric, included_qty, overage_unit_cents
           FROM rate_card_items WHERE rate_card_id = ?1 ORDER BY metric`,
      )
      .bind(card.rate_card_id)
      .all();
    return { ...card, items: items.results ?? [] };
  }

  async insertCreditProposal(row: {
    proposal_id: string;
    account_id: string;
    amount_cents: number;
    currency: string;
    reason: string;
    approval_token_hash: string;
    expires_at: string;
    created_at: string;
  }) {
    this.assertInScope(row.account_id);
    await this.#db
      .prepare(
        `INSERT INTO credit_proposals
           (proposal_id, account_id, amount_cents, currency, reason, status,
            proposed_by_principal, proposed_by_session, approval_token_hash,
            expires_at, created_at)
         VALUES (?1,?2,?3,?4,?5,'PENDING',?6,?7,?8,?9,?10)`,
      )
      .bind(
        row.proposal_id, row.account_id, row.amount_cents, row.currency, row.reason,
        this.principal.principal_id, this.principal.session_id,
        row.approval_token_hash, row.expires_at, row.created_at,
      )
      .run();
  }

  /** Evidence refs are validated against the proposal's account at write time. */
  async attachEvidence(proposalId: string, accountId: string, refs: { ref_type: string; ref_id: string }[]) {
    this.assertInScope(accountId);
    for (const ref of refs) {
      await this.#db
        .prepare(
          `INSERT OR IGNORE INTO credit_proposal_evidence
             (proposal_id, account_id, ref_type, ref_id) VALUES (?1,?2,?3,?4)`,
        )
        .bind(proposalId, accountId, ref.ref_type, ref.ref_id)
        .run();
    }
  }

  async proposalStatus(proposalId: string) {
    const { sql, binds } = this.#scopeClause();
    return this.#db
      .prepare(
        `SELECT proposal_id, status, amount_cents, currency, decided_at
           FROM credit_proposals
          WHERE proposal_id = ?1 AND ${sql}`,
      )
      .bind(proposalId, ...binds)
      .first();
  }
}
