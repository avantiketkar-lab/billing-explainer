import type { Role } from '../types';
import type { LineSide } from '../mcp/tools/compare-invoices';

/** JSON-safe scalar map. Workflow step results must be structured-cloneable,
 *  so `unknown` is not allowed to leak into any of these shapes. */
export type JsonRow = Record<string, string | number | boolean | null>;

/**
 * The composition prompt — the only real prompt engineering in this build.
 *
 * Written defensively, because the failure mode here is not "the model refuses"
 * but "the model produces a fluent, confident, wrong billing explanation" — and
 * a wrong billing explanation is the most expensive output this system can make.
 *
 * The model is handed a delta that deterministic code already computed. Its job
 * is narration, not analysis. Every rule below exists to keep it there.
 */

export interface EvidenceBundle {
  question: string;
  account: { account_id: string; name: string };
  comparison: {
    invoice_a: { invoice_id: string; period_start: string; total_cents: number };
    invoice_b: { invoice_id: string; period_start: string; total_cents: number };
    total_delta_cents: number;
    pct_change: number | null;
    reconciled: boolean;
    lines: Array<{
      line_key: string; kind: string; metric: string | null; status: string;
      delta_cents: number; contribution_pct: number;
      a: LineSide | null; b: LineSide | null;
      proration: { numerator: number; denominator: number; from: string; to: string } | null;
    }>;
  };
  usage: Array<{ metric: string; step_changes: Array<{ date: string; pct: number }>; total: number; daily_mean: number }>;
  changeEvents: JsonRow[];
  rateCard: JsonRow & { items?: JsonRow[] } | null;
}

const SHARED_RULES = `
HARD RULES. These are not style preferences.

1. DO NOT PERFORM ARITHMETIC. Every figure in your answer must appear verbatim
   in the EVIDENCE block. If a number you want does not appear there, you may
   not use it — say the evidence does not show it instead.

   Money is pre-formatted. Write "$104.00", never "10400 cents" and never a
   figure you rounded or converted yourself.

   "included_allowance" is the plan's included quantity, NOT a previous value.
   "metered_quantity" is what was used. Never describe the allowance as
   something that changed.

2. DO NOT NAME A CAUSE THAT IS NOT IN comparison.lines. If you suspect another
   cause, state that the evidence does not show one. Never infer a cause from
   the size of a number.

3. CITE EVERY FACTUAL CLAIM. Use one of:
     [line_key]                    e.g. [usage:api_requests_m:overage]
     [metric@YYYY-MM-DD]           e.g. [api_requests_m@2026-07-09]
     [event:<event_id>]
   A sentence that asserts a fact without a citation is a defect.

4. IF reconciled IS false, your FIRST sentence must say that the itemised causes
   do not account for the whole change, and give the unexplained amount only if
   it appears in the evidence. Do not speculate about the remainder. Recommend
   escalation and stop.

5. YOU ARE EXPLAINING, NOT DECIDING. Do not tell the customer what they are
   owed, do not offer or promise a credit, and do not state policy. If the
   explanation suggests a billing error, say that it warrants review.

STRUCTURE
  - One sentence answering the question directly, with the total change.
  - The causes, in the order given (they are already ranked by contribution).
    One short paragraph each: what changed, by how much, and the evidence.
  - If the evidence rules something out, one closing line saying so.

FORMAT EXAMPLE. Placeholders in <angle brackets> — never reuse these words or
invent numbers to fill them. This shows only WHERE the citations go:

  <Account>'s <later period> invoice rose by <total_change>, from <earlier
  total> to <later total>.

  The largest contributor is <cause description>, up <change>
  [<line_key>]. Usage stepped up on <date> [<metric>@<date>].

  <Second cause description> added <change> [<line_key>] [event:<event_id>].

Every paragraph that states a fact ends with at least one [bracketed] citation.
A paragraph with no bracket is a defect, however well written it reads.
`;

const ROLE_FRAMING: Record<Role, string> = {
  support_engineer: `
You are writing for an internal support engineer. You may reference internal
change events, the actors that made them, and the source systems.`,
  customer: `
You are writing for the customer whose account this is. Never name internal
staff, internal systems, or internal processes — that information is not in your
evidence and must not be invented to fill the gap. Write plainly, without
billing jargon, and do not be defensive about the increase.`,
};

export function systemPrompt(role: Role): string {
  return `You explain why a bill changed. The change has ALREADY BEEN COMPUTED by
deterministic code; you are narrating it, not analysing it.
${ROLE_FRAMING[role]}
${SHARED_RULES}`.trim();
}

const usd = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${Math.abs(cents / 100).toFixed(2)}`;

/**
 * The evidence the model actually sees.
 *
 * Money is presented ONLY as formatted dollar strings, and quantity fields are
 * renamed to say what they are. The first run of this prompt produced
 * "increased by 27,116 cents" and "decreased by 12 requests (from 112 to 100)"
 * — the model reading raw cents as a unit, and reading the included allowance
 * as a previous value. Neither is a reasoning failure so much as a labelling
 * one: if the evidence hands a model `quantity: 112, included_qty: 100`, a
 * before/after reading is a reasonable guess.
 */
function displayBundle(bundle: EvidenceBundle) {
  const c = bundle.comparison;
  const side = (x: EvidenceBundle['comparison']['lines'][number]['a']) => x && ({
    metered_quantity: x.quantity,
    included_allowance: x.included_qty,
    billable_over_allowance: x.billable_qty,
    unit_price: x.unit_price_cents === null ? null : usd(x.unit_price_cents),
    amount: usd(x.amount_cents),
  });
  return {
    question: bundle.question,
    account: bundle.account,
    comparison: {
      earlier_period: { ...c.invoice_a, total: usd(c.invoice_a.total_cents), total_cents: undefined },
      later_period:   { ...c.invoice_b, total: usd(c.invoice_b.total_cents), total_cents: undefined },
      total_change: usd(c.total_delta_cents),
      percent_change: c.pct_change,
      reconciled: c.reconciled,
      causes_ranked_by_contribution: c.lines.map((l) => ({
        line_key: l.line_key,
        kind: l.kind,
        metric: l.metric,
        status: l.status,
        change: usd(l.delta_cents),
        share_of_total_change_pct: l.contribution_pct,
        earlier: side(l.a),
        later: side(l.b),
        proration: l.proration,
      })),
    },
    usage: bundle.usage,
    changeEvents: bundle.changeEvents,
    rateCard: bundle.rateCard,
  };
}

export function userPrompt(bundle: EvidenceBundle): string {
  return [
    `QUESTION: ${bundle.question}`,
    '',
    'EVIDENCE (all money is already formatted — copy the strings verbatim):',
    JSON.stringify(displayBundle(bundle), null, 2),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Post-hoc validation.
//
// Rules in a prompt are a request. This is the check. It runs on the model's
// output before the answer is shown, and it is cheap — three regexes and a set
// membership test — which is the right trade for the one output in this system
// that a customer might act on.
// ---------------------------------------------------------------------------
export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

export function validateExplanation(text: string, bundle: EvidenceBundle): ValidationResult {
  const problems: string[] = [];

  const knownKeys = new Set(bundle.comparison.lines.map((l) => l.line_key));
  const knownEvents = new Set(bundle.changeEvents.map((e) => String((e as any).event_id)));
  const knownMetrics = new Set(bundle.usage.map((u) => u.metric));

  // 1. Every citation must resolve to something in the evidence.
  const citations = [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  for (const c of citations) {
    if (knownKeys.has(c)) continue;
    if (c.startsWith('event:') && knownEvents.has(c.slice(6))) continue;
    const at = c.match(/^([a-z_]+)@(\d{4}-\d{2}-\d{2})$/);
    if (at && knownMetrics.has(at[1])) continue;
    problems.push(`citation does not resolve to evidence: [${c}]`);
  }

  // 1b. AT LEAST ONE CITATION PER MATERIAL CAUSE.
  //     Rule 3 of the prompt asks for a citation on every factual claim, but
  //     nothing enforced it — so an answer with NO citations passed, because
  //     zero citations means zero *invalid* ones. A first run did exactly that.
  const materialCauses = bundle.comparison.lines.filter(
    (l) => Math.abs(l.contribution_pct) >= 5).length;
  if (citations.length === 0) {
    problems.push('no citations: every factual claim must cite evidence in [brackets]');
  } else if (citations.length < materialCauses) {
    problems.push(
      `only ${citations.length} citation(s) for ${materialCauses} material causes`);
  }

  // 2. Every money figure must appear in the evidence.
  //    NOTE the optional decimals. The first version required them, so "$400"
  //    and "$120" — both invented, the real figures were $4.00 and $1.20 —
  //    were never checked at all.
  const evidenceCents = new Set<number>([
    bundle.comparison.total_delta_cents,
    bundle.comparison.invoice_a.total_cents,
    bundle.comparison.invoice_b.total_cents,
    ...bundle.comparison.lines.map((l) => l.delta_cents),
    ...bundle.comparison.lines.flatMap((l) =>
      [l.a?.amount_cents, l.b?.amount_cents, l.a?.unit_price_cents, l.b?.unit_price_cents]
        .filter((n): n is number => typeof n === 'number')),
  ]);
  const evidenceDollars = new Set<string>();
  for (const c of evidenceCents) {
    const abs = Math.abs(c / 100);
    evidenceDollars.add(abs.toFixed(2));
    if (Number.isInteger(abs)) evidenceDollars.add(String(abs));   // "$8" as well as "$8.00"
  }
  for (const m of text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)) {
    const v = m[1].replace(/,/g, '');
    const norm = v.includes('.') ? Number(v).toFixed(2) : v;
    if (!evidenceDollars.has(norm) && !evidenceDollars.has(v)) {
      problems.push(`figure not present in evidence: $${m[1]}`);
    }
  }

  // 2b. Money must be stated in dollars. "increased by 27,116 cents" is
  //     technically derived from the evidence and unreadable as an explanation.
  const cents = text.match(/\b[\d,]{3,}\s*cents\b/i);
  if (cents) problems.push(`amount given in raw cents, not dollars: "${cents[0]}"`);

  // 3. Unreconciled evidence must be disclosed in the opening sentence.
  if (!bundle.comparison.reconciled) {
    const first = text.split(/(?<=\.)\s/)[0]?.toLowerCase() ?? '';
    if (!/(do not account|does not account|unexplained|do not add up|does not add up)/.test(first)) {
      problems.push('reconciled=false but the opening sentence does not disclose it');
    }
  }

  // 4. No commitments.
  if (/\b(we will credit|you are owed|we owe you|refund has been|i have credited)\b/i.test(text)) {
    problems.push('output contains a commitment; explanations may not promise remedies');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * What happens on failure: the answer is NOT shown. The user gets the ranked
 * causes rendered directly from the computed comparison — no prose — plus a
 * note that the narration failed validation. A deterministic, ugly, correct
 * answer beats a fluent one that cited something that does not exist.
 */
export function deterministicFallback(
  bundle: EvidenceBundle,
  lead = 'The narrated explanation failed validation and has been withheld.',
): string {
  const c = bundle.comparison;
  const money = (cents: number) => `${cents < 0 ? '-' : ''}$${Math.abs(cents / 100).toFixed(2)}`;
  const lines = c.lines
    .map((l) => `  ${money(l.delta_cents).padStart(10)}  ${String(l.contribution_pct).padStart(5)}%  ${l.line_key} (${l.status})`)
    .join('\n');
  return [
    lead,
    ``,
    `Computed change: ${money(c.total_delta_cents)}` +
      (c.pct_change === null ? '' : ` (${c.pct_change}%)`),
    `Reconciled: ${c.reconciled}`,
    ``,
    `Ranked contributions:`,
    lines,
  ].join('\n');
}
