-- P1 additive schema: the AX capability registry and the single access-approval ledger.
--
-- Every statement is CREATE ... IF NOT EXISTS. Nothing existing is dropped, renamed or altered, and
-- no task, memory, objective, scheduler or cost-ledger row is touched.
--
-- `habitat_ax_access_requests` is the only approval table. Financial requests leave capability_id
-- NULL rather than opening a second approval system: one decision path, one audit trail.

CREATE TABLE IF NOT EXISTS habitat_ax_capabilities (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_capabilities_kind
  ON habitat_ax_capabilities(kind);
CREATE INDEX IF NOT EXISTS habitat_ax_capabilities_state
  ON habitat_ax_capabilities(state);

CREATE TABLE IF NOT EXISTS habitat_ax_access_requests (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  capability_id TEXT,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  requested_at TEXT NOT NULL,
  quote_expires_at TEXT,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  consumed_at TEXT,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_access_requests_status
  ON habitat_ax_access_requests(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS habitat_ax_access_requests_kind
  ON habitat_ax_access_requests(kind, updated_at DESC);
-- Not UNIQUE: a purchase approval is bound to a quote id, so the same amount may legitimately be
-- requested again against a fresh quote. The gate refuses a second *open* request for the same
-- fingerprint, which is the duplicate that actually matters.
CREATE INDEX IF NOT EXISTS habitat_ax_access_requests_fingerprint
  ON habitat_ax_access_requests(fingerprint);
