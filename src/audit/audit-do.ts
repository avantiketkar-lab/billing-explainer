import { DurableObject } from 'cloudflare:workers';
import type { AuditEntry, Env } from '../types';
import { GENESIS_HASH, chainHash } from './hash';

/**
 * AuditLog — append-only, hash-chained.
 *
 * WHY A DURABLE OBJECT AND NOT D1:
 * building the chain is a read-modify-write on the head hash. In a normally
 * concurrent store that needs a lock, and a lock is a thing that can be got
 * wrong. A DO serialises requests by construction, so chain correctness is a
 * property of the platform rather than of this code.
 *
 * THE PUBLIC SURFACE IS `append`, `read`, `verify`. There is no update path and
 * no delete path — not as policy, as API surface. Two BEFORE triggers in the
 * schema abort UPDATE and DELETE at the engine level as well, which catches the
 * case this class does not: a future code path written by someone who never
 * read the design docs.
 *
 * HONEST LIMIT: an operator with direct storage access can drop the triggers
 * and rewrite rows. The chain does not prevent that; it makes it DETECTABLE,
 * because any rewrite that does not also recompute every subsequent hash breaks
 * verify(). To close the remaining gap the head must be anchored somewhere this
 * application cannot rewrite — see anchorHead() and docs/data-model.md §3.
 */
export class AuditLog extends DurableObject<Env> {
  #sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        seq                INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id            TEXT NOT NULL UNIQUE,
        prev_hash          TEXT NOT NULL,
        entry_hash         TEXT NOT NULL,
        ts                 TEXT NOT NULL,
        session_id         TEXT NOT NULL,
        parent_call_id     TEXT,
        principal_id       TEXT NOT NULL,
        principal_role     TEXT NOT NULL,
        token_jti          TEXT NOT NULL,
        tool_name          TEXT NOT NULL,
        arguments_redacted TEXT NOT NULL,
        arguments_hash     TEXT NOT NULL,
        requested_scope    TEXT,
        resolved_scope     TEXT,
        decision           TEXT NOT NULL,
        denial_reason      TEXT,
        source_system      TEXT,
        as_of              TEXT,
        result_hash        TEXT,
        latency_ms         INTEGER,
        model_id           TEXT,
        assistant_turn_id  TEXT
      );
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `);
  }

  #head(): { seq: number; entry_hash: string } | null {
    const rows = [...this.#sql.exec<{ seq: number; entry_hash: string }>(
      'SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1',
    )];
    return rows[0] ?? null;
  }

  /**
   * Append one entry. Returns the new head hash.
   * Callers treat a rejection here as fatal to the tool call: if it cannot be
   * audited, it is not disclosed. See withAudit() in ../mcp/server.ts.
   */
  async append(entry: AuditEntry): Promise<{ seq: number; entry_hash: string }> {
    const prev = this.#head()?.entry_hash ?? GENESIS_HASH;
    const entry_hash = await chainHash(prev, entry);
    this.#sql.exec(
      `INSERT INTO audit_log
        (call_id, prev_hash, entry_hash, ts, session_id, parent_call_id,
         principal_id, principal_role, token_jti, tool_name, arguments_redacted,
         arguments_hash, requested_scope, resolved_scope, decision, denial_reason,
         source_system, as_of, result_hash, latency_ms, model_id, assistant_turn_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      entry.call_id, prev, entry_hash, entry.ts, entry.session_id, entry.parent_call_id,
      entry.principal_id, entry.principal_role, entry.token_jti, entry.tool_name,
      entry.arguments_redacted, entry.arguments_hash, entry.requested_scope,
      entry.resolved_scope, entry.decision, entry.denial_reason, entry.source_system,
      entry.as_of, entry.result_hash, entry.latency_ms, entry.model_id,
      entry.assistant_turn_id,
    );
    const head = this.#head()!;
    return head;
  }

  async read(opts: { session_id?: string; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const rows = opts.session_id
      ? this.#sql.exec('SELECT * FROM audit_log WHERE session_id = ? ORDER BY seq DESC LIMIT ?', opts.session_id, limit)
      : this.#sql.exec('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?', limit);
    return [...rows];
  }

  /** Walk the chain from genesis and recompute. Returns the first break, if any. */
  async verify(): Promise<{ ok: boolean; checked: number; brokenAtSeq?: number }> {
    let prev = GENESIS_HASH;
    let checked = 0;
    for (const row of this.#sql.exec<Record<string, SqlStorageValue>>('SELECT * FROM audit_log ORDER BY seq ASC')) {
      const { seq, prev_hash, entry_hash, ...entry } = row as any;
      if (prev_hash !== prev) return { ok: false, checked, brokenAtSeq: seq as number };
      const recomputed = await chainHash(prev, entry);
      if (recomputed !== entry_hash) return { ok: false, checked, brokenAtSeq: seq as number };
      prev = entry_hash as string;
      checked++;
    }
    return { ok: true, checked };
  }

  /**
   * Periodically mirror the head hash somewhere this application cannot
   * rewrite (R2 with object-lock). Without an external anchor an attacker who
   * owns the storage can recompute the entire chain and the log proves nothing.
   * SPECIFIED, NOT BUILT — see docs/data-model.md §3.
   */
  async anchorHead(): Promise<{ seq: number; head_hash: string } | null> {
    const head = this.#head();
    return head ? { seq: head.seq, head_hash: head.entry_hash } : null;
  }
}
