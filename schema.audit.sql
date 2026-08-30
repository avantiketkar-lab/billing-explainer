-- REFERENCE ONLY. Created at runtime by the audit Durable Object.
-- Do not load into D1 — see the note at the end of schema.sql.

-- ============================================================================
--  AUDIT LOG
--  Lives in the audit Durable Object's own SQLite storage, not in D1.
--  The DO is single-threaded, which is what makes the hash chain race-free
--  without locking. A batch job mirrors to R2 for retention (not built).
-- ============================================================================
CREATE TABLE audit_log (
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
  resolved_scope     TEXT,                    -- what was ENFORCED, not what was asked
  decision           TEXT NOT NULL CHECK (decision IN ('allowed','denied')),
  denial_reason      TEXT,
  source_system      TEXT,
  as_of              TEXT,                    -- data version pin
  result_hash        TEXT,                    -- hash, never the payload
  latency_ms         INTEGER,
  model_id           TEXT,
  assistant_turn_id  TEXT
);

-- Engine-level append-only enforcement. These fire on any UPDATE or DELETE,
-- including one issued by a future careless code path.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Periodically anchored chain head. The application can append here but the
-- object it mirrors to (R2 with object-lock) it cannot rewrite — which is what
-- makes tampering detectable by someone who does not trust this database.
CREATE TABLE audit_chain_anchors (
  anchor_id  TEXT PRIMARY KEY,
  as_of_seq  INTEGER NOT NULL,
  head_hash  TEXT NOT NULL,
  anchored_at TEXT NOT NULL,
  external_ref TEXT
);
