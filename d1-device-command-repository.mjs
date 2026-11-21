import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { validBackfillDeviceId } from "./device-ownership-migration.mjs";

const API = "https://api.cloudflare.com/client/v4";

function normalizeAuthorizedOwnerIds(value) {
  const raw = value instanceof Set ? [...value] : Array.isArray(value) ? value : String(value || "").split(",");
  return new Set(raw.map(item => String(item || "").trim()).filter(Boolean));
}

export function createD1DeviceCommandRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("Device command storage requires Cloudflare D1 credentials.");
  }
  const endpoint = `${API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000)
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.success !== true) {
      throw new Error(`D1 device-command query failed with HTTP ${response.status}; verify D1 configuration.`);
    }
    return payload.result || [];
  }
  function decode(row) {
    try {
      const command = JSON.parse(row.record_json);
      return command && typeof command.id === "string" ? command : null;
    } catch { return null; }
  }
  function hash(value) {
    return createHash("sha256").update(String(value), "utf8").digest("hex");
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    databaseId: String(databaseId),
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_device_commands (id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, record_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_device_commands_queue ON habitat_device_commands(device_id, status, created_at)");
      await query("CREATE TABLE IF NOT EXISTS habitat_device_pairings (code_hash TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, recovery_at TEXT)");
      await query("CREATE INDEX IF NOT EXISTS habitat_device_pairings_expiry ON habitat_device_pairings(expires_at, consumed_at)");
      await query("CREATE TABLE IF NOT EXISTS habitat_paired_devices (device_id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, device_json TEXT, revoked_at TEXT)");
      await query("CREATE TABLE IF NOT EXISTS habitat_device_ownership (device_id TEXT PRIMARY KEY NOT NULL, owner_device_id TEXT NOT NULL, assigned_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_device_ownership_owner ON habitat_device_ownership(owner_device_id, device_id)");
      await query("CREATE TABLE IF NOT EXISTS habitat_pairing_owners (code_hash TEXT PRIMARY KEY NOT NULL, owner_device_id TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_pairing_owners_owner ON habitat_pairing_owners(owner_device_id, code_hash)");
      await query("CREATE TABLE IF NOT EXISTS habitat_security_audit (id TEXT PRIMARY KEY NOT NULL, occurred_at TEXT NOT NULL, event TEXT NOT NULL, actor_device_id TEXT, target_device_id TEXT, detail_json TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_security_audit_time ON habitat_security_audit(occurred_at DESC)");
      // Revision 3 databases created this table without recovery_at. Add it only when absent so
      // existing installations migrate without dropping pairing rows.
      try {
        const info = await query("PRAGMA table_info(habitat_device_pairings)");
        const columns = (info?.[0]?.results || []).map(row => String(row.name || ""));
        if (columns.length > 0 && !columns.includes("recovery_at")) {
          await query("ALTER TABLE habitat_device_pairings ADD COLUMN recovery_at TEXT");
        }
      } catch (error) {
        throw new Error("Unable to verify the device pairing schema: " + String(error?.message || error));
      }
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    },
    async createPairing({ codeHash, deviceId, createdAt, expiresAt, ownerDeviceId }) {
      if (!ownerDeviceId) throw new Error("A pairing owner is required.");
      await query(
        "INSERT INTO habitat_device_pairings (code_hash, device_id, created_at, expires_at, consumed_at, recovery_at) VALUES (?, ?, ?, ?, NULL, NULL)",
        [codeHash, deviceId, createdAt, expiresAt]
      );
      try {
        await query(
          "INSERT INTO habitat_pairing_owners (code_hash, owner_device_id) VALUES (?, ?) " +
          "ON CONFLICT(code_hash) DO UPDATE SET owner_device_id = excluded.owner_device_id",
          [codeHash, ownerDeviceId]
        );
      } catch (error) {
        // Compensate the first insert so a failed owner write cannot leave an ownerless code that
        // later reports a misleading ownership_missing response.
        await query("DELETE FROM habitat_device_pairings WHERE code_hash = ?", [codeHash]).catch(() => {});
        throw error;
      }
      return true;
    },
    async seedBootstrapPairing({ codeHash, createdAt, expiresAt, ownerDeviceId }) {
      if (!ownerDeviceId) throw new Error("A bootstrap pairing owner is required.");
      // A consumed bootstrap code is a dead credential. Never reset consumed_at, never restore
      // the wildcard binding, and never make it usable again merely because the process restarted.
      // Also leave its issuer untouched: an owner change must not turn an old consumed code into a
      // recoverable code for a different owner.
      const existing = await this.findPairing({ codeHash });
      if (existing?.consumedAt) return true;
      await query(
        "INSERT INTO habitat_device_pairings (code_hash, device_id, created_at, expires_at, consumed_at, recovery_at) VALUES (?, '*', ?, ?, NULL, NULL) " +
        "ON CONFLICT(code_hash) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at " +
        "WHERE habitat_device_pairings.consumed_at IS NULL",
        [codeHash, createdAt, expiresAt]
      );
      try {
        await query(
          "INSERT INTO habitat_pairing_owners (code_hash, owner_device_id) VALUES (?, ?) " +
          "ON CONFLICT(code_hash) DO UPDATE SET owner_device_id = excluded.owner_device_id",
          [codeHash, ownerDeviceId]
        );
      } catch (error) {
        await query("DELETE FROM habitat_device_pairings WHERE code_hash = ? AND consumed_at IS NULL", [codeHash]).catch(() => {});
        throw error;
      }
      return true;
    },
    async consumePairing({ codeHash, deviceId, consumedAt }) {
      const result = await query(
        "UPDATE habitat_device_pairings SET consumed_at = ?, device_id = ? WHERE code_hash = ? AND (device_id = ? OR device_id = '*') AND consumed_at IS NULL AND expires_at > ? RETURNING device_id",
        [consumedAt, deviceId, codeHash, deviceId, consumedAt]
      );
      return Boolean(result[0]?.results?.length);
    },
    /**
     * Claim the one bounded lost-response recovery for a consumed code. The caller must first
     * verify that the consumed timestamp is inside its recovery window. The conditional UPDATE
     * makes this exactly-once even when two retries race.
     */
    async claimPairingRecovery({ codeHash, deviceId, recoveredAt, consumedAfter }) {
      const result = await query(
        "UPDATE habitat_device_pairings SET recovery_at = ? " +
        "WHERE code_hash = ? AND device_id = ? AND consumed_at IS NOT NULL AND consumed_at >= ? " +
        "AND recovery_at IS NULL RETURNING code_hash",
        [recoveredAt, codeHash, deviceId, consumedAfter]
      );
      return Boolean(result[0]?.results?.length);
    },
    // Used only to explain a failed exchange to the user (expired / already used / unknown).
    // It never returns or reconstructs the code itself.
    async findPairing({ codeHash }) {
      const result = await query(
        "SELECT p.code_hash, p.device_id, p.created_at, p.expires_at, p.consumed_at, p.recovery_at, o.owner_device_id " +
        "FROM habitat_device_pairings p LEFT JOIN habitat_pairing_owners o ON o.code_hash = p.code_hash " +
        "WHERE p.code_hash = ? LIMIT 1",
        [codeHash]
      );
      const row = result[0]?.results?.[0];
      if (!row) return null;
      return {
        codeHash: row.code_hash,
        deviceId: row.device_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at || null,
        recoveryAt: row.recovery_at || null,
        ownerDeviceId: row.owner_device_id || null
      };
    },
    async registerDevice({ deviceId, tokenHash, createdAt, ownerDeviceId = null }) {
      // Never clear revoked_at here. A revoked device must not be revived by replaying a pairing
      // code (or by any other registration path); recovery requires an explicit owner action.
      if (ownerDeviceId) {
        // Claim ownership with a conditional insert before touching the credential. Two owners
        // racing the same unowned device cannot both succeed: the loser sees the winner's row and
        // returns false before its token can overwrite the winner's token.
        await query(
          "INSERT INTO habitat_device_ownership (device_id, owner_device_id, assigned_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(device_id) DO NOTHING",
          [deviceId, ownerDeviceId, createdAt]
        );
        const currentOwner = await this.getDeviceOwner(deviceId);
        if (currentOwner !== ownerDeviceId) return false;
      }
      await query(
        "INSERT INTO habitat_paired_devices (device_id, token_hash, created_at, last_seen_at, device_json, revoked_at) VALUES (?, ?, ?, NULL, NULL, NULL) " +
        "ON CONFLICT(device_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_seen_at = NULL, device_json = NULL",
        [deviceId, tokenHash, createdAt]
      );
      return true;
    },
    async getDeviceOwner(deviceId) {
      const result = await query(
        "SELECT owner_device_id FROM habitat_device_ownership WHERE device_id = ? LIMIT 1",
        [deviceId]
      );
      return result[0]?.results?.[0]?.owner_device_id || null;
    },
    async isDeviceRevoked(deviceId) {
      const result = await query(
        "SELECT revoked_at FROM habitat_paired_devices WHERE device_id = ? LIMIT 1",
        [deviceId]
      );
      const row = result[0]?.results?.[0];
      return Boolean(row?.revoked_at);
    },
    async unrevokeDevice(deviceId, ownerDeviceId = null) {
      if (!ownerDeviceId) return false;
      const currentOwner = await this.getDeviceOwner(deviceId);
      if (!currentOwner || currentOwner !== ownerDeviceId) return false;
      return this.recoverRevokedDevice(deviceId);
    },
    /** Break-glass/admin recovery: caller is authenticated separately and must be audited. */
    async unrevokeDeviceByBreakGlass(deviceId) {
      const currentOwner = await this.getDeviceOwner(deviceId);
      if (!currentOwner) return false;
      return this.recoverRevokedDevice(deviceId);
    },
    async recoverRevokedDevice(deviceId) {
      // Recovery is not a token reset. Destroy every old pairing code first, then clear the old token
      // hash and revocation. If the first write fails, the device remains revoked and the caller gets
      // an error; a retry can safely finish. A fresh owner-issued pairing is still required.
      await query(
        "DELETE FROM habitat_device_pairings WHERE device_id = ? OR code_hash IN " +
        "(SELECT code_hash FROM habitat_pairing_owners WHERE owner_device_id = ?)",
        [deviceId, deviceId]
      );
      const updated = await query(
        "UPDATE habitat_paired_devices SET revoked_at = NULL, token_hash = '' " +
        "WHERE device_id = ? AND revoked_at IS NOT NULL RETURNING device_id",
        [deviceId]
      );
      return Boolean(updated[0]?.results?.length);
    },
    async verifyDeviceToken(token, deviceId) {
      const result = await query(
        "SELECT token_hash FROM habitat_paired_devices WHERE device_id = ? AND revoked_at IS NULL LIMIT 1",
        [deviceId]
      );
      const stored = String(result[0]?.results?.[0]?.token_hash || "");
      const supplied = hash(token);
      const a = Buffer.from(stored);
      const b = Buffer.from(supplied);
      return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
    },
    async isDevicePaired(deviceId) {
      const result = await query(
        "SELECT device_id FROM habitat_paired_devices WHERE device_id = ? AND revoked_at IS NULL AND token_hash <> '' LIMIT 1",
        [deviceId]
      );
      return Boolean(result[0]?.results?.length);
    },
    async touchDevice(deviceId, seenAt) {
      await query(
        "UPDATE habitat_paired_devices SET last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        [seenAt, deviceId]
      );
      return true;
    },
    async updateDeviceInfo(deviceId, seenAt, details) {
      await query(
        "UPDATE habitat_paired_devices SET last_seen_at = ?, device_json = ? WHERE device_id = ? AND revoked_at IS NULL",
        [seenAt, JSON.stringify(details || {}), deviceId]
      );
      return true;
    },
    async listDevices() {
      const result = await query(
        "SELECT d.device_id, d.created_at, d.last_seen_at, d.device_json, d.revoked_at, o.owner_device_id " +
        "FROM habitat_paired_devices d LEFT JOIN habitat_device_ownership o ON o.device_id = d.device_id " +
        "ORDER BY d.created_at DESC LIMIT 50"
      );
      return result[0]?.results || [];
    },
    async revokeDevice(deviceId, revokedAt) {
      // Super-admin path only. Owner-initiated revocation must use revokeDeviceOwned().
      await query(
        "UPDATE habitat_paired_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        [revokedAt, deviceId]
      );
      // A revoked device must never recover with a code it saw before revocation. Remove every
      // pairing code for this device and every code issued by this device as an owner, including
      // already-consumed recovery rows, so only a fresh active-owner code can pair it afterward.
      await query(
        "DELETE FROM habitat_device_pairings WHERE device_id = ? OR code_hash IN " +
        "(SELECT code_hash FROM habitat_pairing_owners WHERE owner_device_id = ?)",
        [deviceId, deviceId]
      );
      await query("DELETE FROM habitat_pairing_owners WHERE owner_device_id = ?", [deviceId]);
      await query(
        "UPDATE habitat_device_commands SET status = 'cancelled', record_json = json_set(record_json, '$.status', 'cancelled', '$.cancelledAt', ?) WHERE device_id = ? AND status IN ('queued', 'claimed')",
        [revokedAt, deviceId]
      );
      return true;
    },
    async revokeDeviceOwned(deviceId, ownerDeviceId, revokedAt) {
      if (!ownerDeviceId) return false;
      const currentOwner = await this.getDeviceOwner(deviceId);
      if (!currentOwner || currentOwner !== ownerDeviceId) return false;
      await this.revokeDevice(deviceId, revokedAt);
      return true;
    },
    async enqueue(command) {
      if (!command?.id || !command?.deviceId || !command?.type) throw new Error("A complete device command is required.");
      await query(
        "INSERT INTO habitat_device_commands (id, device_id, record_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        [command.id, command.deviceId, JSON.stringify(command), "queued", command.createdAt, command.expiresAt]
      );
      return structuredClone(command);
    },
    async claimNext(deviceId) {
      const claimedAt = new Date().toISOString();
      const result = await query(
        "UPDATE habitat_device_commands SET status = 'claimed', record_json = json_set(record_json, '$.status', 'claimed', '$.claimedAt', ?) " +
        "WHERE id = (SELECT id FROM habitat_device_commands WHERE device_id = ? AND status = 'queued' AND expires_at > ? ORDER BY created_at ASC LIMIT 1) " +
        "AND status = 'queued' RETURNING record_json",
        [claimedAt, deviceId, claimedAt]
      );
      return decode(result[0]?.results?.[0] || {});
    },
    async complete({ id, deviceId, result: commandResult, completedAt }) {
      const currentResult = await query(
        "SELECT record_json FROM habitat_device_commands WHERE id = ? AND device_id = ? AND status = 'claimed' AND expires_at > ? LIMIT 1",
        [id, deviceId, completedAt]
      );
      const current = decode(currentResult[0]?.results?.[0] || {});
      if (!current) return false;
      const next = { ...current, status: "completed", result: commandResult, completedAt };
      const updated = await query(
        "UPDATE habitat_device_commands SET record_json = ?, status = 'completed' WHERE id = ? AND device_id = ? AND status = 'claimed' RETURNING id",
        [JSON.stringify(next), id, deviceId]
      );
      return Boolean(updated[0]?.results?.length);
    },
    async get(id) {
      const result = await query("SELECT record_json FROM habitat_device_commands WHERE id = ? LIMIT 1", [id]);
      return decode(result[0]?.results?.[0] || {});
    },
    async audit({ event, actorDeviceId = null, targetDeviceId = null, detail = null } = {}) {
      const id = "aud_" + randomUUID();
      const occurredAt = new Date().toISOString();
      await query(
        "INSERT INTO habitat_security_audit (id, occurred_at, event, actor_device_id, target_device_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
        [id, occurredAt, String(event || "unknown").slice(0, 120), actorDeviceId || null, targetDeviceId || null, JSON.stringify(detail || {})]
      );
      return { ok: true, id, occurredAt };
    },
    async getDeviceRecord(deviceId) {
      const result = await query(
        "SELECT device_id, token_hash, revoked_at FROM habitat_paired_devices WHERE device_id = ? LIMIT 1",
        [deviceId]
      );
      return result[0]?.results?.[0] || null;
    },
    /**
     * Read-only ownership preflight. This performs the same checks used before an apply write:
     * the proposed owner must be explicitly authorized, exist, be unrevoked, and hold an active
     * paired credential; the target must exist; and ownership must be absent or already the same.
     * It never writes a row and is safe for dry-run callers.
     */
    async preflightOwnership({ deviceId, ownerDeviceId, authorizedOwnerIds = [] } = {}) {
      const targetId = String(deviceId || "").trim();
      const ownerId = String(ownerDeviceId || "").trim();
      if (!validBackfillDeviceId(targetId) || !validBackfillDeviceId(ownerId)) {
        return { ok: false, code: "invalid_mapping", error: "A valid device and owner id are required." };
      }
      if (targetId === ownerId) {
        return {
          ok: false,
          code: "self_ownership",
          deviceId: targetId,
          ownerDeviceId: ownerId,
          error: "A device cannot be its own owner; ownership must name a different, authorized device."
        };
      }
      const allowed = normalizeAuthorizedOwnerIds(authorizedOwnerIds);
      if (allowed.size === 0) {
        return { ok: false, code: "owner_authorization_required", error: "An explicit owner allowlist is required." };
      }
      if (!allowed.has(ownerId)) {
        return { ok: false, code: "owner_unauthorized", ownerDeviceId: ownerId, error: "The proposed owner is not in the authorized owner allowlist." };
      }
      const owner = await this.getDeviceRecord(ownerId);
      if (!owner) return { ok: false, code: "owner_missing", ownerDeviceId: ownerId, error: "The proposed owner device does not exist." };
      if (owner.revoked_at) return { ok: false, code: "owner_revoked", ownerDeviceId: ownerId, error: "The proposed owner device is revoked." };
      if (!String(owner.token_hash || "").trim()) {
        return { ok: false, code: "owner_inactive", ownerDeviceId: ownerId, error: "The proposed owner device has no active credential." };
      }
      const target = await this.getDeviceRecord(targetId);
      if (!target) return { ok: false, code: "device_not_paired", deviceId: targetId, error: "The target device does not exist." };
      const existing = await this.getDeviceOwner(targetId);
      if (existing && existing !== ownerId) {
        return { ok: false, code: "already_owned", deviceId: targetId, existingOwnerDeviceId: existing, error: "The target device already has a different owner." };
      }
      if (existing === ownerId) {
        return {
          ok: true,
          action: "already_assigned",
          assigned: false,
          deviceId: targetId,
          ownerDeviceId: ownerId,
          targetRevoked: Boolean(target.revoked_at)
        };
      }
      return {
        ok: true,
        action: "assign",
        assigned: true,
        deviceId: targetId,
        ownerDeviceId: ownerId,
        targetRevoked: Boolean(target.revoked_at)
      };
    },
    /**
     * Controlled legacy backfill. The caller supplies an explicit deviceId -> owner mapping; this
     * method never infers an owner. Preflight validates the owner and target. The insert itself
     * rechecks owner activity and absence of ownership so a concurrent revocation cannot attach a
     * device to an unusable owner.
     */
    async backfillOwnership({ deviceId, ownerDeviceId, assignedAt = new Date().toISOString(), authorizedOwnerIds = [] }) {
      const preflight = await this.preflightOwnership({ deviceId, ownerDeviceId, authorizedOwnerIds });
      if (!preflight.ok) return preflight;
      if (preflight.action === "already_assigned") {
        return { ok: true, assigned: false, code: "already_owned_same", existingOwnerDeviceId: ownerDeviceId };
      }
      const result = await query(
        "INSERT INTO habitat_device_ownership (device_id, owner_device_id, assigned_at) " +
        "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM habitat_paired_devices WHERE device_id = ?) " +
        "AND EXISTS (SELECT 1 FROM habitat_paired_devices WHERE device_id = ? AND revoked_at IS NULL AND token_hash <> '') " +
        "AND NOT EXISTS (SELECT 1 FROM habitat_device_ownership WHERE device_id = ?) " +
        "RETURNING device_id",
        [deviceId, ownerDeviceId, assignedAt, deviceId, ownerDeviceId, deviceId]
      );
      if (result[0]?.results?.length) return { ok: true, assigned: true };
      // The conditional write lost a race (owner revoked, target removed, or another mapping won).
      // Re-run the read-only preflight so the caller gets the precise current reason.
      const after = await this.preflightOwnership({ deviceId, ownerDeviceId, authorizedOwnerIds });
      if (after.ok && after.action === "already_assigned") {
        return { ok: true, assigned: false, code: "already_owned_same", existingOwnerDeviceId: ownerDeviceId };
      }
      return after.ok ? { ok: false, code: "assignment_conflict", error: "Ownership changed during the backfill." } : after;
    },
    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}
