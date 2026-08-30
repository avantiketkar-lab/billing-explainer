import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../types';
import { McpToolClient } from './mcp-client';
import { systemPrompt, userPrompt, validateExplanation, deterministicFallback, type EvidenceBundle, type JsonRow } from './compose';

type Comparison = EvidenceBundle['comparison'];
type UsageStat  = EvidenceBundle['usage'][number];

export interface InvestigationParams {
  question: string;
  identifier: string;          // account email / domain / id, as the human typed it
  period_a: string;            // 'YYYY-MM-01'
  period_b: string;
  token: string;               // the SESSION's token — scope travels with it
  role: 'support_engineer' | 'customer';
  mcpUrl: string;
}

/** A refusal, as opposed to a transient failure worth retrying. */
const isDenial = (message: string) => /not permitted|not found|outside .*scope/i.test(message);

/** Only pull supporting evidence for lines that actually move the total. */
const MATERIAL_CONTRIBUTION_PCT = 5;

/**
 * BillingInvestigation — the coordination layer.
 *
 * Why a Workflow rather than a loop: the investigation is genuinely multi-step
 * and each step is an external call that can fail independently. Workflow steps
 * are durable and individually retryable, so a failure at "gather evidence"
 * resumes from there instead of re-running the comparison and re-billing the
 * model for tokens it already spent.
 *
 * The agent's authority is the CALLER'S authority: every step calls the MCP
 * server with the session's own token. There is no service credential here and
 * no way for the workflow to see an account the person who asked cannot see.
 */
export class BillingInvestigation extends WorkflowEntrypoint<Env, InvestigationParams> {
  async run(event: WorkflowEvent<InvestigationParams>, step: WorkflowStep) {
    const p = event.payload;
    const mcp = new McpToolClient(p.mcpUrl, p.token);
    const trace: Array<{ tool: string; args: unknown; ms: number }> = [];

    const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      const t0 = Date.now();
      try {
        const out = await mcp.call<T>(name, args);
        trace.push({ tool: name, args, ms: Date.now() - t0 });
        return out;
      } catch (err) {
        const message = (err as Error).message ?? '';
        // A DENIAL IS NOT A TRANSIENT FAILURE. Workflows retries a failed step
        // by default, so without this a scope violation sits in `running` for
        // minutes re-deciding something that will never change — and writes a
        // fresh denial into the audit log on every attempt.
        if (isDenial(message)) throw new NonRetryableError(message);
        throw err;
      }
    };

    /** Transient failures deserve a couple of tries; not ten. */
    const RETRY = { retries: { limit: 2, delay: '1 second', backoff: 'exponential' } } as const;

    // ---- 1. Resolve the account -------------------------------------------
    //
    // A DENIAL IS AN OUTCOME, NOT A CRASH — and it must be returned as a VALUE.
    // A NonRetryableError thrown inside step.do is fatal at the step boundary
    // and never reaches a try/catch around run(), so the user would see "a step
    // threw an error": a message that reads as a fault in the system rather
    // than as the access control working exactly as designed.
    const resolved = await step.do('resolve_account', RETRY, async () => {
      try {
        const r = await call<{ account_id: string; name: string }>(
          'billing_resolve_account', { identifier: p.identifier });
        return { ok: true as const, account: { account_id: r.account_id, name: r.name } };
      } catch (err) {
        const message = (err as Error).message ?? '';
        if (isDenial(message)) {
          return { ok: false as const, reason: message.replace(/^billing_\w+: /, '') };
        }
        throw err;
      }
    });

    if (!resolved.ok) {
      return {
        denied: true,
        account: null,
        comparison: null,
        trace,
        validation: { ok: false, problems: [resolved.reason] },
        answer:
          'That account is not available to this session.\n\n' +
          'The request was refused before any billing data was read, and the refusal ' +
          'is recorded in the audit log together with the account that was asked for.',
        withheld: true,
      };
    }
    const account = resolved.account;

    // ---- 2. Locate the two invoices ---------------------------------------
    const invoices = await step.do('locate_invoices', RETRY, async () => {
      const a = await call<any>('billing_find_invoice', {
        account_id: account.account_id, period_start: p.period_a,
      });
      const b = await call<any>('billing_find_invoice', {
        account_id: account.account_id, period_start: p.period_b,
      });
      return { a: a.invoice_id as string, b: b.invoice_id as string };
    });

    // ---- 3. Compare (deterministic; the model never does this) -------------
    const comparison: Comparison = await step.do('compare_invoices', RETRY, () =>
      call<Comparison>('billing_compare_invoices', {
        invoice_a: invoices.a, invoice_b: invoices.b,
      }));

    // ---- 4. Gather supporting evidence, one step per material cause --------
    const material = comparison.lines.filter(
      (l) => Math.abs(l.contribution_pct) >= MATERIAL_CONTRIBUTION_PCT);

    const usage: UsageStat[] = [];
    for (const line of material.filter((l) => l.metric)) {
      const series: UsageStat = await step.do(`usage:${line.metric}`, RETRY, async () => {
        const r = await call<UsageStat & Record<string, unknown>>('billing_get_usage_series', {
          account_id: account.account_id, metric: line.metric,
          from: p.period_b, to: endOfMonth(p.period_b),
        });
        // Project to the JSON-safe shape the bundle declares; the full series
        // stays out of the workflow's persisted state.
        return { metric: r.metric, step_changes: r.step_changes, total: r.total, daily_mean: r.daily_mean };
      });
      usage.push(series);
    }

    const changeEvents: JsonRow[] = material.some((l) => l.kind === 'proration' || l.kind === 'discount')
      ? await step.do('subscription_history', RETRY, async () => {
          const r = await call<{ events: JsonRow[] }>('billing_get_subscription_history', {
            account_id: account.account_id, from: p.period_a, to: endOfMonth(p.period_b),
          });
          return r.events;
        })
      : [];

    const rateCard: EvidenceBundle['rateCard'] = await step.do('rate_card', RETRY, () =>
      call<EvidenceBundle['rateCard']>('billing_get_rate_card', {
        account_id: account.account_id, as_of: p.period_b,
      }));

    // ---- 5. Compose, then validate before disclosure ----------------------
    const bundle: EvidenceBundle = {
      question: p.question, account, comparison, usage, changeEvents, rateCard,
    };

    // Workers AI is remote-only: `wrangler dev` proxies it to Cloudflare, so a
    // local run without `wrangler login` lands in the catch below. The failure
    // is CAPTURED rather than swallowed — a bare `catch {}` turns "this account
    // cannot reach that model" into "no narration", which is the same symptom
    // as five unrelated causes and tells you which one it was: none.
    const composed = await step.do('compose', RETRY, async () => {
      if (!this.env.AI) {
        return { text: '', error: 'no AI binding (run `wrangler login`)' };
      }
      const model = this.env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      try {
        const res: any = await this.env.AI.run(model, {
          messages: [
            { role: 'system', content: systemPrompt(p.role) },
            { role: 'user', content: userPrompt(bundle) },
          ],
          max_tokens: 900,
          temperature: 0.2,
        });
        return { text: String(res.response ?? res.result?.response ?? ''), error: null as string | null };
      } catch (err) {
        return { text: '', error: `${model}: ${(err as Error).message ?? String(err)}` };
      }
    });

    const narration = composed.text;
    const validation = validateExplanation(narration, bundle);
    if (composed.error) validation.problems = [composed.error, ...validation.problems];

    // An empty narration passes every check vacuously, so "valid" is not the
    // same question as "usable". No model output means no narration to show —
    // the deterministic ranking stands in, and nothing was withheld because
    // nothing was said.
    const narrated = narration.trim().length > 0;

    return {
      account,
      comparison,
      trace,
      validation,
      // A deterministic, ugly, correct answer beats a fluent one that cited
      // something that does not exist.
      answer: narrated && validation.ok
        ? narration
        : deterministicFallback(
            bundle,
            narrated
              ? 'The narrated explanation failed validation and has been withheld.'
              // Name the ACTUAL reason in the answer box. "Unavailable" covers
              // auth, model access, rate limits and a missing binding, and which
              // one you are looking at is the whole question.
              : `No narration was produced (${composed.error ?? 'Workers AI unavailable'}). `
                + 'Computed evidence only.',
          ),
      withheld: narrated && !validation.ok,
    };
  }
}

function endOfMonth(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
}
