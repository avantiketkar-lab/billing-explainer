import type { ScopedDb } from '../../db/scoped-db';
import { ScopeViolation } from '../../types';

interface Line {
  line_key: string; kind: string; product_code: string; metric: string | null;
  quantity: number | null; included_qty: number | null; billable_qty: number | null;
  unit_price_cents: number | null; amount_cents: number;
  is_prorated: number; proration_numerator: number | null;
  proration_denominator: number | null; proration_from: string | null; proration_to: string | null;
  source_ref: string | null;
}

export type LineStatus = 'changed' | 'added' | 'removed' | 'unchanged';

/** Concrete and JSON-safe: Workflow step results must be structured-cloneable. */
export interface LineSide {
  quantity: number | null;
  included_qty: number | null;
  billable_qty: number | null;
  unit_price_cents: number | null;
  amount_cents: number;
}

/**
 * compare_invoices — a FULL OUTER JOIN on line_key.
 *
 * This is deliberately not a model task. Arithmetic over a revenue document is
 * where a fluent wrong answer is most expensive and least detectable, so the
 * delta is computed here, deterministically and testably, and the model's job
 * narrows to explaining a delta it was handed.
 *
 * The join needs no heuristics because line_key is stable across periods and
 * UNIQUE (invoice_id, line_key) holds. An expired discount is therefore a NULL
 * on one side of a join — a fact — rather than an inference from a total that
 * moved.
 */
export async function compareInvoices(db: ScopedDb, invoiceA: string, invoiceB: string) {
  const [a, b] = await Promise.all([db.invoiceById(invoiceA), db.invoiceById(invoiceB)]);
  // A missing invoice is indistinguishable from an out-of-scope one, by design.
  if (!a) throw new ScopeViolation(invoiceA);
  if (!b) throw new ScopeViolation(invoiceB);

  const [linesA, linesB] = await Promise.all([
    db.lineItemsForInvoice(invoiceA) as Promise<unknown[]>,
    db.lineItemsForInvoice(invoiceB) as Promise<unknown[]>,
  ]);

  const mapA = new Map((linesA as Line[]).map((l) => [l.line_key, l]));
  const mapB = new Map((linesB as Line[]).map((l) => [l.line_key, l]));
  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];   // the outer join

  const totalDelta = (b as any).total_cents - (a as any).total_cents;

  const rows = keys.map((key) => {
    const la = mapA.get(key) ?? null;
    const lb = mapB.get(key) ?? null;
    const amtA = la?.amount_cents ?? 0;
    const amtB = lb?.amount_cents ?? 0;
    const delta = amtB - amtA;
    const status: LineStatus =
      la && lb ? (delta === 0 ? 'unchanged' : 'changed') : lb ? 'added' : 'removed';

    const side = (l: Line | null): LineSide | null => l && ({
      quantity: l.quantity, included_qty: l.included_qty, billable_qty: l.billable_qty,
      unit_price_cents: l.unit_price_cents, amount_cents: l.amount_cents,
    });

    const shape = lb ?? la!;
    return {
      line_key: key,
      kind: shape.kind,
      product_code: shape.product_code,
      metric: shape.metric,
      status,
      a: side(la),
      b: side(lb),
      delta_cents: delta,
      // Share of the TOTAL change, so the caller can say "this is half of it".
      contribution_pct: totalDelta === 0 ? 0 : Number(((delta / totalDelta) * 100).toFixed(1)),
      proration: shape.is_prorated
        ? {
            numerator: shape.proration_numerator,
            denominator: shape.proration_denominator,
            from: shape.proration_from,
            to: shape.proration_to,
          }
        : null,
      source_ref: shape.source_ref,
    };
  });

  const changed = rows
    .filter((r) => r.status !== 'unchanged')
    .sort((x, y) => Math.abs(y.delta_cents) - Math.abs(x.delta_cents));

  // Invariant worth asserting rather than assuming: the parts equal the whole.
  const sum = changed.reduce((acc, r) => acc + r.delta_cents, 0);
  const reconciled = sum === totalDelta;

  return {
    invoice_a: { invoice_id: (a as any).invoice_id, period_start: (a as any).period_start, total_cents: (a as any).total_cents },
    invoice_b: { invoice_id: (b as any).invoice_id, period_start: (b as any).period_start, total_cents: (b as any).total_cents },
    currency: (b as any).currency,
    total_delta_cents: totalDelta,
    pct_change: (a as any).total_cents === 0
      ? null
      : Number(((totalDelta / (a as any).total_cents) * 100).toFixed(3)),
    lines: changed,
    unchanged_count: rows.length - changed.length,
    /**
     * If this is ever false the explanation must not be trusted: some part of
     * the change is not represented in any line. Surfaced rather than hidden so
     * the agent can escalate instead of confabulating a cause.
     */
    reconciled,
  };
}
