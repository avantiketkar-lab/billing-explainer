-- ============================================================================
--  Billing Explainability MCP Server — D1 schema
--  Conventions:
--    * All money is INTEGER CENTS. No floats touch money, ever.
--    * All temporal ranges are [effective_from, effective_to) — from inclusive,
--      to exclusive, NULL = open. ISO-8601 date or datetime strings.
--    * Every table reachable by a tool carries account_id, even when it is
--      derivable by join. See docs/tool-surface.md §2.2 and the leak notes.
--    * Ids are ULIDs. Never sequential — sequential ids make the denial log
--      an enumeration oracle.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  account_id      TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','suspended','closed')),
  currency        TEXT NOT NULL DEFAULT 'USD',
  billing_anchor  INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Plan catalogue + temporal pricing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_cards (
  rate_card_id    TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES plans(plan_id),
  base_cents      INTEGER NOT NULL,
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
-- At most one open rate card per plan.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rate_cards_open ON rate_cards(plan_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS ix_rate_cards_asof ON rate_cards(plan_id, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS rate_card_items (
  rate_card_item_id  TEXT PRIMARY KEY,
  rate_card_id       TEXT NOT NULL REFERENCES rate_cards(rate_card_id),
  metric             TEXT NOT NULL,            -- 'api_requests_m' | 'bandwidth_gb'
  included_qty       REAL NOT NULL DEFAULT 0,
  overage_unit_cents INTEGER NOT NULL,         -- price per ONE unit of `metric`
  UNIQUE (rate_card_id, metric)
);

-- ---------------------------------------------------------------------------
-- Subscriptions, add-ons, and the change log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(account_id),
  plan_id         TEXT NOT NULL REFERENCES plans(plan_id),
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS ix_subs_account ON subscriptions(account_id, effective_from);

CREATE TABLE IF NOT EXISTS subscription_addons (
  addon_id        TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(account_id),   -- denormalised on purpose
  subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
  addon_code      TEXT NOT NULL,
  monthly_cents   INTEGER NOT NULL,
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS ix_addons_account ON subscription_addons(account_id, effective_from);

CREATE TABLE IF NOT EXISTS subscription_change_events (
  event_id          TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(account_id),
  occurred_at       TEXT NOT NULL,
  effective_at      TEXT NOT NULL,
  change_type       TEXT NOT NULL CHECK (change_type IN (
                      'plan_change','addon_added','addon_removed',
                      'discount_applied','discount_expired','quantity_change')),
  from_value        TEXT,
  to_value          TEXT,
  proration_applied INTEGER NOT NULL DEFAULT 0,
  -- INTERNAL-ONLY COLUMNS. Never projected to a customer-scoped caller.
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('customer','support','system','api')),
  actor_id          TEXT,
  source_system     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sce_account_time ON subscription_change_events(account_id, effective_at);

-- ---------------------------------------------------------------------------
-- Account-specific discounts (temporal — expiry is a first-class event)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discounts (
  discount_id     TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(account_id),
  code            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('flat_cents','percent_of_base_bps')),
  value           INTEGER NOT NULL,           -- cents, or basis points
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS ix_discounts_account ON discounts(account_id, effective_from);

-- ---------------------------------------------------------------------------
-- Metered usage — daily grain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_records (
  usage_id      TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(account_id),
  metric        TEXT NOT NULL,
  usage_date    TEXT NOT NULL,                -- ISO date
  quantity      REAL NOT NULL,
  source_system TEXT NOT NULL,
  ingested_at   TEXT NOT NULL,
  UNIQUE (account_id, metric, usage_date)
);
CREATE INDEX IF NOT EXISTS ix_usage_scan ON usage_records(account_id, metric, usage_date);

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id     TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(account_id),
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,               -- inclusive
  status         TEXT NOT NULL CHECK (status IN ('draft','issued','paid','void')),
  currency       TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,  -- <= 0
  total_cents    INTEGER NOT NULL,
  issued_at      TEXT,
  -- Version pin: which rate card this invoice was computed against.
  -- Without this, an invoice cannot be re-derived after pricing changes.
  rate_card_id   TEXT REFERENCES rate_cards(rate_card_id),
  UNIQUE (account_id, period_start),
  CHECK (discount_cents <= 0)
);
CREATE INDEX IF NOT EXISTS ix_invoices_account_period ON invoices(account_id, period_start);

-- ---------------------------------------------------------------------------
-- Invoice line items
--   line_key is STABLE ACROSS PERIODS: '<product_code>:<metric|->:<kind>'
--   UNIQUE (invoice_id, line_key) is what lets compare_invoices be a pure
--   FULL OUTER JOIN on line_key with no description matching and no heuristics.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_line_items (
  line_id               TEXT PRIMARY KEY,
  invoice_id            TEXT NOT NULL REFERENCES invoices(invoice_id),
  account_id            TEXT NOT NULL REFERENCES accounts(account_id),  -- denormalised on purpose
  line_key              TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN
                          ('base','overage','addon','proration','discount','credit','tax')),
  product_code          TEXT NOT NULL,
  metric                TEXT,
  quantity              REAL,
  included_qty          REAL,
  billable_qty          REAL,
  unit_price_cents      INTEGER,
  amount_cents          INTEGER NOT NULL,
  is_prorated           INTEGER NOT NULL DEFAULT 0,
  proration_numerator   INTEGER,              -- days billed
  proration_denominator INTEGER,              -- days in period
  proration_from        TEXT,
  proration_to          TEXT,
  source_ref            TEXT,                 -- discount_id / addon_id / rate_card_item_id
  UNIQUE (invoice_id, line_key)
);
CREATE INDEX IF NOT EXISTS ix_ili_account      ON invoice_line_items(account_id);
CREATE INDEX IF NOT EXISTS ix_ili_account_key  ON invoice_line_items(account_id, line_key);

-- ---------------------------------------------------------------------------
-- Credit proposals — the only write path near money, and it never moves any
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_proposals (
  proposal_id           TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(account_id),
  amount_cents          INTEGER NOT NULL CHECK (amount_cents > 0),
  currency              TEXT NOT NULL,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  proposed_by_principal TEXT NOT NULL,
  proposed_by_session   TEXT NOT NULL,
  approval_token_hash   TEXT NOT NULL,
  approver_principal    TEXT,
  decided_at            TEXT,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  -- No self-approval, enforced by the engine rather than by convention.
  CHECK (approver_principal IS NULL OR approver_principal <> proposed_by_principal)
);
CREATE INDEX IF NOT EXISTS ix_proposals_account ON credit_proposals(account_id, status);

CREATE TABLE IF NOT EXISTS credit_proposal_evidence (
  proposal_id TEXT NOT NULL REFERENCES credit_proposals(proposal_id),
  account_id  TEXT NOT NULL,   -- MUST equal the proposal's account; validated at write
  ref_type    TEXT NOT NULL CHECK (ref_type IN ('invoice','line','usage_series','change_event')),
  ref_id      TEXT NOT NULL,
  PRIMARY KEY (proposal_id, ref_type, ref_id)
);

-- ---------------------------------------------------------------------------
-- NOTE: the audit log is NOT in D1. It lives in the audit Durable Object's own
-- SQLite storage, which the DO creates on construction (src/audit/audit-do.ts).
-- The DDL is reproduced in schema.audit.sql for reference only; do not load it
-- into D1, or you get a second, empty, unwritten copy of the table.
-- ---------------------------------------------------------------------------
