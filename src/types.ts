export type Role = 'support_engineer' | 'customer';

/**
 * The verified caller. Constructed once, at session creation, from an
 * authenticated identity. Never constructed from tool arguments, and never
 * from anything a model produced.
 */
export interface Principal {
  readonly principal_id: string;
  readonly role: Role;
  /** Accounts this principal may touch. Empty array is a valid (useless) scope. */
  readonly account_scope: readonly string[];
  readonly session_id: string;
  readonly token_jti: string;
  readonly exp: number;
}

export interface Env {
  /**
   * The D1 binding. Referenced in exactly ONE module: src/db/scoped-db.ts.
   * test/tenancy.test.ts asserts that invariant.
   */
  DB: D1Database;
  AUDIT: DurableObjectNamespace;
  MCP_AGENT: DurableObjectNamespace;
  AGENT: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  INVESTIGATION: Workflow;
  ASSETS: Fetcher;
  AI: Ai;
  /** Override the default Workers AI model without touching code. */
  AI_MODEL?: string;
  SESSION_SECRET: string;
}

export interface AuditEntry {
  call_id: string;
  ts: string;
  session_id: string;
  parent_call_id: string | null;
  principal_id: string;
  principal_role: Role;
  token_jti: string;
  tool_name: string;
  arguments_redacted: string;
  arguments_hash: string;
  requested_scope: string | null;
  resolved_scope: string | null;
  decision: 'allowed' | 'denied';
  denial_reason: string | null;
  source_system: string | null;
  as_of: string | null;
  result_hash: string | null;
  latency_ms: number | null;
  model_id: string | null;
  assistant_turn_id: string | null;
}

/** Thrown when a call asks for an account outside the principal's scope. */
export class ScopeViolation extends Error {
  constructor(readonly requested: string) {
    // Deliberately undifferentiated: "not found" and "not permitted" must be
    // indistinguishable to the caller. The audit log records which it was.
    super('Not found or not permitted');
    this.name = 'ScopeViolation';
  }
}
