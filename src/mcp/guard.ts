import type { AuditEntry, Env, Principal } from '../types';
import { ScopeViolation } from '../types';
import { ScopedDb } from '../db/scoped-db';
import { canonicalJson, sha256Hex } from '../audit/hash';

/**
 * withAudit — the enforcement path, deliberately independent of the MCP
 * transport.
 *
 * This used to live inside the McpAgent subclass. It was pulled out because
 * the security boundary should be testable without booting a protocol server:
 * anything that can only be exercised end-to-end tends, in practice, not to be
 * exercised at all. `server.ts` is now a thin adapter over this function.
 *
 * Order of operations:
 *
 *   1. Build a ScopedDb from the PRINCIPAL, never from the arguments.
 *   2. Pre-flight the account selector against the principal's scope. A
 *      violation is written to the audit log BEFORE anything is read, then
 *      thrown — so the log shows a model reaching for scope it does not have.
 *   3. Run the tool.
 *   4. Append the outcome with a hash of the result, never the result.
 *   5. Fail closed: if the audit append is rejected, the caller gets an error
 *      and no data. If it cannot be audited, it is not disclosed.
 */

/** Free-text arguments can carry customer data; they are logged redacted. */
const REDACT = new Set(['reason', 'identifier']);

function redact(args: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = REDACT.has(k) ? '[redacted]' : v;
  return out;
}

export interface AuditSink {
  append(entry: AuditEntry): Promise<{ seq: number; entry_hash: string }>;
}

export function auditSink(env: Env): AuditSink {
  return env.AUDIT.get(env.AUDIT.idFromName('global')) as unknown as AuditSink;
}

export async function withAudit<T>(
  env: Env,
  principal: Principal,
  toolName: string,
  accountArg: string | undefined,
  args: Record<string, unknown>,
  run: (db: ScopedDb, principal: Principal) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const db = new ScopedDb(env, principal);
  const audit = auditSink(env);

  const requested = accountArg ? ((args[accountArg] as string | undefined) ?? null) : null;

  const base: Omit<AuditEntry, 'decision' | 'denial_reason' | 'result_hash' | 'latency_ms'> = {
    call_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    session_id: principal.session_id,
    parent_call_id: null,
    principal_id: principal.principal_id,
    principal_role: principal.role,
    token_jti: principal.token_jti,
    tool_name: toolName,
    arguments_redacted: JSON.stringify(redact(args)),
    arguments_hash: await sha256Hex(canonicalJson(args)),
    requested_scope: requested,
    resolved_scope: principal.account_scope.join(','),   // what was ENFORCED
    source_system: 'billing-d1',
    as_of: new Date().toISOString(),                     // data version pin
    model_id: null,
    assistant_turn_id: null,
  };

  if (requested && !principal.account_scope.includes(requested)) {
    await audit.append({
      ...base,
      decision: 'denied',
      denial_reason: 'account_id outside principal scope',
      result_hash: null,
      latency_ms: Date.now() - started,
    });
    throw new ScopeViolation(requested);
  }

  try {
    const result = await run(db, principal);
    await audit.append({
      ...base,
      decision: 'allowed',
      denial_reason: null,
      result_hash: await sha256Hex(canonicalJson(result)),   // hash, never the payload
      latency_ms: Date.now() - started,
    });
    return result;
  } catch (err) {
    await audit.append({
      ...base,
      decision: err instanceof ScopeViolation ? 'denied' : 'allowed',
      denial_reason:
        err instanceof ScopeViolation
          ? 'selector outside principal scope'
          : `error: ${(err as Error).name}`,
      result_hash: null,
      latency_ms: Date.now() - started,
    });
    throw err;
  }
}

/** Single dispatch table, shared by the MCP adapter and the tests. */
export async function dispatch(
  name: string,
  db: ScopedDb,
  env: Env,
  args: any,
  publicBase: string,
): Promise<unknown> {
  const T = await import('./tools');
  switch (name) {
    case 'billing_resolve_account':          return T.resolveAccount(db, args.identifier);
    case 'billing_get_invoice':              return T.getInvoice(db, args.invoice_id);
    case 'billing_find_invoice':             return T.findInvoice(db, args.account_id, args.period_start);
    case 'billing_compare_invoices':         return T.compareInvoices(db, args.invoice_a, args.invoice_b);
    case 'billing_get_usage_series':         return T.getUsageSeries(db, args.account_id, args.metric, args.from, args.to);
    case 'billing_get_subscription_history': return T.getSubscriptionHistory(db, args.account_id, args.from, args.to);
    case 'billing_get_rate_card':            return T.getRateCard(db, args.account_id, args.as_of);
    case 'billing_propose_credit':           return T.proposeCredit(db, env, args, publicBase);
    default: throw new Error(`unregistered tool ${name}`);
  }
}
