-- Durable approval nonce registry.
--
-- Every owner-signed approval consumes its attestation nonce here. The primary key is the replay
-- boundary: two instances racing the same attestation both reach INSERT, and exactly one wins.
-- Rows are never deleted, so replay protection survives restarts; expiry cleanup marks rows expired
-- instead of removing them. `status` is the audit state:
--
--   consumed  — the nonce authorised one decision
--   revoked   — the owner withdrew the grant (the mission record is authoritative for the gate)
--   expired   — the attestation/signed approval lifetime passed (retained for audit/replay refusal)
--   released  — the mission write failed, so the nonce was rolled back for a clean retry
--
-- This is additive and forward-only, like every Habitat migration.

CREATE TABLE IF NOT EXISTS habitat_ax_approval_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  key_id TEXT,
  mission_id TEXT NOT NULL,
  approval_id TEXT,
  task_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  issued_at TEXT,
  expires_at TEXT,
  consumed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'consumed' CHECK (status IN ('consumed', 'revoked', 'expired', 'released')),
  revoked_at TEXT,
  revoke_reason TEXT
);

-- Replay lookup is the primary key; these cover mission history, per-approval audit and cleanup scans.
CREATE INDEX IF NOT EXISTS habitat_ax_approval_nonces_mission
  ON habitat_ax_approval_nonces(mission_id, consumed_at DESC);

CREATE INDEX IF NOT EXISTS habitat_ax_approval_nonces_approval
  ON habitat_ax_approval_nonces(approval_id);

CREATE INDEX IF NOT EXISTS habitat_ax_approval_nonces_expiry
  ON habitat_ax_approval_nonces(status, expires_at);
