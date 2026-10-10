const API = "https://api.cloudflare.com/client/v4";

/**
 * D1-backed cross-instance dispatch lease.
 *
 * A scope key should include project, platform, and the stable scheduled window
 * (for example: "DropPilotAI:tiktok:2026-10-10T18:00Z"). The atomic unique-key
 * upsert allows only one live claimant across separate server processes.
 */
export function createD1DispatchLeaseRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("D1 dispatch leases require CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID, and HABITAT_D1_API_TOKEN.");
  }

  const endpoint = `${API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params })
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.success !== true) {
      throw new Error(`D1 dispatch-lease query failed with HTTP ${response.status}; check D1 credentials, database ID, and schema.`);
    }
    return payload.result || [];
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,

    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_dispatch_leases (scope_key TEXT PRIMARY KEY NOT NULL, lease_token TEXT NOT NULL, claimed_at TEXT NOT NULL, expires_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_dispatch_leases_expiry ON habitat_dispatch_leases(expires_at)");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    },

    async acquire({ scopeKey, leaseToken, nowIso = new Date().toISOString(), expiresAt }) {
      if (![scopeKey, leaseToken, nowIso, expiresAt].every(value => typeof value === "string" && value.trim())) {
        throw new Error("Dispatch lease requires scopeKey, leaseToken, nowIso, and expiresAt.");
      }
      if (expiresAt <= nowIso) throw new Error("Dispatch lease expiry must be later than nowIso.");

      // D1/SQLite serializes the unique-key write. The WHERE clause means an
      // unexpired lease cannot be replaced by a competing instance.
      const result = await query(
        "INSERT INTO habitat_dispatch_leases (scope_key, lease_token, claimed_at, expires_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(scope_key) DO UPDATE SET lease_token = excluded.lease_token, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at " +
        "WHERE habitat_dispatch_leases.expires_at <= excluded.claimed_at RETURNING scope_key, lease_token, expires_at",
        [scopeKey, leaseToken, nowIso, expiresAt]
      );
      const row = result[0]?.results?.[0];
      return row && row.lease_token === leaseToken
        ? { acquired: true, scopeKey, leaseToken, expiresAt: row.expires_at }
        : { acquired: false, scopeKey, reason: "lease_already_held" };
    },

    async release({ scopeKey, leaseToken }) {
      if (![scopeKey, leaseToken].every(value => typeof value === "string" && value.trim())) {
        throw new Error("Releasing a dispatch lease requires scopeKey and leaseToken.");
      }
      const result = await query(
        "DELETE FROM habitat_dispatch_leases WHERE scope_key = ? AND lease_token = ?",
        [scopeKey, leaseToken]
      );
      return Number(result[0]?.meta?.changes || 0) > 0;
    },

    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}
