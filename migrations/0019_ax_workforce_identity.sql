-- Workforce security and recovery v2: authenticated worker identities, replay protection,
-- provider operation references and a reassignment ledger.
--
-- Additive and forward-only. 0018 stays exactly as applied: these tables sit beside it and are checked
-- separately, so a database with 0018 but not 0019 still runs the workforce and reports that worker
-- authentication is not yet available instead of silently accepting unauthenticated heartbeats.
--
--   habitat_ax_workforce_credentials    one signing key per worker, rotatable and revocable
--   habitat_ax_workforce_auth_nonces    single-use request nonces, per credential
--   habitat_ax_workforce_operations     provider references and reconciliation verdicts
--   habitat_ax_workforce_reassignments  every reassignment and recovery decision, append-only
--
-- A credential row holds the verification key. That is what HMAC authentication requires: the server must
-- be able to recompute the MAC. The key is never returned by any API after issuance and must be protected
-- at rest like the owner attestation key.

CREATE TABLE IF NOT EXISTS habitat_ax_workforce_credentials (
  credential_id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  grace_until TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  rotated_to TEXT,
  last_used_at TEXT,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_credentials_worker
  ON habitat_ax_workforce_credentials(worker_id, status);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_credentials_expiry
  ON habitat_ax_workforce_credentials(status, expires_at);

-- A nonce is single-use per credential. The composite primary key is the replay boundary: two requests
-- racing the same nonce reach the same INSERT and exactly one proceeds.
CREATE TABLE IF NOT EXISTS habitat_ax_workforce_auth_nonces (
  credential_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  operation TEXT NOT NULL,
  at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, nonce)
);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_auth_nonces_expiry
  ON habitat_ax_workforce_auth_nonces(expires_at);

-- One row per attempted external operation, keyed by the execution's idempotency key.
-- state: `unknown` (default), `confirmed_success`, `confirmed_failure`, `not_executed`.
-- Only `not_executed` with recorded proof may authorise a retry.
CREATE TABLE IF NOT EXISTS habitat_ax_workforce_operations (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  worker_id TEXT,
  provider TEXT,
  provider_reference TEXT,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'confirmed_success', 'confirmed_failure', 'not_executed')),
  proof_json TEXT,
  inspected_at TEXT,
  inspected_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_operations_state
  ON habitat_ax_workforce_operations(state, updated_at);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_operations_reference
  ON habitat_ax_workforce_operations(provider, provider_reference);

CREATE TABLE IF NOT EXISTS habitat_ax_workforce_reassignments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  from_worker TEXT,
  to_worker TEXT,
  lease_id TEXT,
  reason TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('requeue', 'hold_uncertain', 'abandon', 'completed')),
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_workforce_reassignments_mission
  ON habitat_ax_workforce_reassignments(mission_id, seq);
