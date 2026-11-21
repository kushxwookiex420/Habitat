-- Revision 4 security schema. Additive and safe to apply before deploying the application.
-- This migration deliberately does NOT assign ownership to any existing device. Legacy ownership
-- must be supplied explicitly through scripts/backfill-device-ownership.mjs.
CREATE TABLE IF NOT EXISTS habitat_device_ownership (
  device_id TEXT PRIMARY KEY NOT NULL,
  owner_device_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS habitat_device_ownership_owner
  ON habitat_device_ownership(owner_device_id, device_id);

CREATE TABLE IF NOT EXISTS habitat_pairing_owners (
  code_hash TEXT PRIMARY KEY NOT NULL,
  owner_device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS habitat_pairing_owners_owner
  ON habitat_pairing_owners(owner_device_id, code_hash);

-- Existing Revision 3 databases may already have this table without recovery_at. The application
-- checks PRAGMA table_info and adds the column idempotently at startup; operators may also apply the
-- ALTER manually before deployment.
-- ALTER TABLE habitat_device_pairings ADD COLUMN recovery_at TEXT;

CREATE TABLE IF NOT EXISTS habitat_security_audit (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_device_id TEXT,
  target_device_id TEXT,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS habitat_security_audit_time
  ON habitat_security_audit(occurred_at DESC);
