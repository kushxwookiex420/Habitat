-- Multi-instance delivery safety for MCP Events.
--
-- A worker claims a due delivery by inserting a short lease; only one replica can win while the lease is
-- live. A crashed worker's lease expires and the row becomes claimable again, preserving at-least-once
-- semantics. Event ids stay stable across retries so receivers can deduplicate.
--
-- A separate lease table keeps this migration additive and idempotent: no ALTER TABLE is needed, so the
-- migration can be replayed by the validation harness without a duplicate-column error.

CREATE TABLE IF NOT EXISTS habitat_ax_mcp_delivery_leases (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_mcp_delivery_leases_expiry
  ON habitat_ax_mcp_delivery_leases(expires_at);
