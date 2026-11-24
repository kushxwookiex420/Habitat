import { d1DatabaseEndpoint } from "./d1-command-task-repository.mjs";
import {
  MEMORY_KINDS,
  evaluateWrite,
  likePattern,
  memoryId,
  normalizeMemoryEntry,
  statementDigest
} from "./ax-memory.mjs";

/**
 * Durable Ax memory on D1.
 *
 * Two additive tables, both created with `IF NOT EXISTS` and never dropped or altered:
 *
 *   habitat_ax_memory           current value of each (project, key), with kind and provenance
 *   habitat_ax_memory_revisions append-only history: every version written, and every deletion
 *
 * No existing table is touched, so this can be rolled out to a live database without migrating or
 * rewriting anything. A row is a *record*, not a credential store: `normalizeMemoryEntry` refuses
 * anything that looks like a secret before it ever reaches SQL.
 *
 * `put` is a compare-and-set on `version`. Two concurrent writers cannot both win: the second sees a
 * version mismatch and gets `memory_conflict` plus the current row, so it can reconcile rather than
 * overwrite a newer decision.
 */

export const MEMORY_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS habitat_ax_memory (" +
  "id TEXT PRIMARY KEY, project TEXT NOT NULL, mem_key TEXT NOT NULL, kind TEXT NOT NULL, " +
  "statement TEXT NOT NULL, provenance TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', " +
  "confidence REAL, version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', " +
  "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)";

export const MEMORY_UNIQUE_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_memory_project_key ON habitat_ax_memory(project, mem_key)";

export const MEMORY_REVISION_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS habitat_ax_memory_revisions (" +
  "id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, project TEXT NOT NULL, mem_key TEXT NOT NULL, " +
  "version INTEGER NOT NULL, kind TEXT NOT NULL, statement TEXT NOT NULL, provenance TEXT NOT NULL, " +
  "recorded_at TEXT NOT NULL, action TEXT NOT NULL)";

export const MEMORY_SCHEMA = Object.freeze([
  MEMORY_TABLE_SQL,
  MEMORY_REVISION_TABLE_SQL,
  MEMORY_UNIQUE_INDEX_SQL
]);

function parseRow(row) {
  if (!row) return null;
  let provenance = {};
  try {
    provenance = JSON.parse(row.provenance || "{}");
  } catch {
    provenance = { source: "unknown" };
  }
  return {
    id: row.id,
    project: row.project,
    key: row.mem_key,
    kind: row.kind,
    statement: row.statement,
    provenance,
    tags: String(row.tags || "")
      .split(",")
      .map(tag => tag.trim())
      .filter(Boolean),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    version: Number(row.version),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null
  };
}

export function createD1AxMemoryRepository({ accountId, databaseId, apiToken, fetchImpl = fetch, ownerVerifier = null, ownerPolicy = "optional" } = {}) {
  const endpoint = d1DatabaseEndpoint({ accountId, databaseId });
  const ownerRequired = ownerPolicy === "required";

  /**
   * Owner writes are refused unless the attestation verifies. Without a verifier, `required` means
   * refuse (an unverifiable owner claim is not an owner claim), while `optional` keeps the historic
   * behavior for callers that authenticate at the route instead.
   */
  function checkOwner(entry, attestation) {
    if (entry.provenance.source !== "owner") return { ok: true };
    if (!ownerVerifier) {
      return ownerRequired ? { ok: false, code: "owner_attestation_unavailable" } : { ok: true, unattested: true };
    }
    return ownerVerifier.verifyEntry(entry, attestation || entry.attestation || null);
  }

  async function query(sql, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiToken },
      body: JSON.stringify({ sql, params })
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Ax memory: D1 returned a non-JSON response.");
    }
    if (!response.ok || payload?.success === false) {
      const message = payload?.errors?.[0]?.message || "D1 query failed with status " + response.status;
      throw new Error("Ax memory: " + message);
    }
    return payload?.result?.[0]?.results || [];
  }

  async function readRow(id) {
    const rows = await query("SELECT * FROM habitat_ax_memory WHERE id = ?", [id]);
    return parseRow(rows[0]);
  }

  async function appendRevision(row, action, recordedAt) {
    await query(
      "INSERT INTO habitat_ax_memory_revisions (id, memory_id, project, mem_key, version, kind, statement, provenance, recorded_at, action) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "rev_" + memoryId(row.project, row.key).slice(4) + "_" + row.version,
        memoryId(row.project, row.key),
        row.project,
        row.key,
        row.version,
        row.kind,
        row.statement,
        JSON.stringify(row.provenance),
        recordedAt,
        action
      ]
    );
  }

  return Object.freeze({
    /**
     * Create the additive schema. Safe to call on every boot; never alters an existing table.
     * Returns the statements that ran so a deployment check can record exactly what it created.
     */
    async initialize() {
      for (const statement of MEMORY_SCHEMA) await query(statement);
      return { ok: true, statements: MEMORY_SCHEMA.length };
    },

    /**
     * Write one entry.
     *
     * `expectedVersion: 0` means "I expect this key not to exist". Omitting it on an existing row is
     * refused (`expected_version_required`) so a caller cannot blind-overwrite a decision it never
     * read. Identical content is an idempotent no-op and does not create a version.
     */
    async put(input, { expectedVersion = null, allowKindChange = false, now = new Date().toISOString() } = {}) {
      const normalized = normalizeMemoryEntry(input);
      if (!normalized.ok) return { ok: false, ...normalized };
      const entry = normalized.entry;
      const ownerCheck = checkOwner(entry, entry.attestation);
      if (!ownerCheck.ok) return { ok: false, ...ownerCheck };
      const id = memoryId(entry.project, entry.key);
      const existing = await readRow(id);
      const decision = evaluateWrite(existing, entry, { expectedVersion, allowKindChange });
      if (decision.conflict) {
        return { ok: false, ...decision, current: existing };
      }
      if (decision.action === "unchanged") {
        return { ok: true, unchanged: true, entry: existing };
      }

      const version = existing ? existing.version + 1 : 1;
      const createdAt = existing ? existing.createdAt : now;

      // The version check above is only a fast path. This conditional statement is the security
      // boundary: a second writer that read the same version gets zero rows back and is told it
      // lost the race, so two concurrent decisions can never both be written.
      let written = [];
      if (!existing) {
        written = await query(
          "INSERT INTO habitat_ax_memory (id, project, mem_key, kind, statement, provenance, tags, confidence, version, status, created_at, updated_at, deleted_at) " +
            "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL " +
            "WHERE NOT EXISTS (SELECT 1 FROM habitat_ax_memory WHERE id = ?) RETURNING id",
          [
            id,
            entry.project,
            entry.key,
            entry.kind,
            entry.statement,
            JSON.stringify(entry.provenance),
            entry.tags.join(","),
            entry.confidence,
            version,
            createdAt,
            now,
            id
          ]
        );
      } else {
        written = await query(
          "UPDATE habitat_ax_memory SET kind = ?, statement = ?, provenance = ?, tags = ?, confidence = ?, " +
            "version = ?, status = 'active', updated_at = ?, deleted_at = NULL " +
            "WHERE id = ? AND version = ? RETURNING id",
          [
            entry.kind,
            entry.statement,
            JSON.stringify(entry.provenance),
            entry.tags.join(","),
            entry.confidence,
            version,
            now,
            id,
            existing.version
          ]
        );
      }
      if (!written.length) {
        return {
          ok: false,
          conflict: true,
          code: "memory_conflict",
          reason: "lost_race",
          current: await readRow(id)
        };
      }

      const row = {
        project: entry.project,
        key: entry.key,
        kind: entry.kind,
        statement: entry.statement,
        provenance: entry.provenance,
        version
      };
      await appendRevision(row, existing ? "updated" : "created", now);
      return {
        ok: true,
        action: decision.action,
        entry: await readRow(id),
        downgraded: entry.downgraded,
        previousVersion: existing ? existing.version : null
      };
    },

    async get({ project, key } = {}) {
      const rows = await query("SELECT * FROM habitat_ax_memory WHERE id = ? AND status = 'active'", [
        memoryId(String(project || "").trim().toLowerCase(), String(key || "").trim().toLowerCase())
      ]);
      return parseRow(rows[0]);
    },

    /**
     * Substring search over statement, key and tags. The query is escaped for LIKE, so `%` in a
     * search term matches a literal percent sign rather than the whole table.
     */
    async search({ project, query: text = "", kind = null, limit = 20 } = {}) {
      const projectId = String(project || "").trim().toLowerCase();
      if (!projectId) return [];
      const max = Math.max(1, Math.min(100, Number(limit) || 20));
      const params = [projectId];
      let sql = "SELECT * FROM habitat_ax_memory WHERE project = ? AND status = 'active'";
      if (kind) {
        sql += " AND kind = ?";
        params.push(String(kind).trim().toLowerCase());
      }
      if (String(text || "").trim()) {
        const pattern = likePattern(String(text).trim().toLowerCase());
        sql += " AND (lower(statement) LIKE ? ESCAPE '\\' OR lower(mem_key) LIKE ? ESCAPE '\\' OR lower(tags) LIKE ? ESCAPE '\\')";
        params.push(pattern, pattern, pattern);
      }
      sql += " ORDER BY updated_at DESC LIMIT " + max;
      return (await query(sql, params)).map(parseRow);
    },

    async list({ project, kind = null, limit = 50 } = {}) {
      return this.search({ project, query: "", kind, limit });
    },

    /** Every version ever written for one key, oldest first. */
    async history({ project, key } = {}) {
      const projectId = String(project || "").trim().toLowerCase();
      const memKey = String(key || "").trim().toLowerCase();
      const rows = await query(
        "SELECT version, kind, statement, provenance, recorded_at, action FROM habitat_ax_memory_revisions " +
          "WHERE project = ? AND mem_key = ? ORDER BY version ASC",
        [projectId, memKey]
      );
      return rows.map(row => ({
        version: Number(row.version),
        kind: row.kind,
        statement: row.statement,
        provenance: JSON.parse(row.provenance || "{}"),
        recordedAt: row.recorded_at,
        action: row.action
      }));
    },

    /**
     * Owner-only soft delete. The row keeps its history; `status` becomes `deleted` and the delete is
     * itself a revision, so a correction is auditable rather than invisible.
     */
    async remove({ project, key, expectedVersion, actor, attestation = null } = {}) {
      if (String(actor || "").trim().toLowerCase() !== "owner") {
        return { ok: false, code: "owner_required" };
      }
      if (ownerVerifier) {
        const removal = ownerVerifier.verifyEntry({
          project, key, kind: "delete", statement: "delete", tags: [], confidence: null
        }, attestation, { operation: "memory.remove" });
        if (!removal.ok) return { ok: false, ...removal };
      } else if (ownerRequired) {
        return { ok: false, code: "owner_attestation_unavailable" };
      }
      const projectId = String(project || "").trim().toLowerCase();
      const memKey = String(key || "").trim().toLowerCase();
      const id = memoryId(projectId, memKey);
      const existing = await readRow(id);
      if (!existing || existing.status !== "active") return { ok: false, code: "memory_not_found" };
      if (expectedVersion === undefined || expectedVersion === null || Number(expectedVersion) !== existing.version) {
        return { ok: false, code: "memory_conflict", reason: "stale_version", current: existing };
      }
      const now = new Date().toISOString();
      await query(
        "UPDATE habitat_ax_memory SET status = 'deleted', version = ?, updated_at = ?, deleted_at = ? WHERE id = ? AND version = ?",
        [existing.version + 1, now, now, id, existing.version]
      );
      await appendRevision(
        { project: projectId, key: memKey, version: existing.version + 1, kind: existing.kind, statement: existing.statement, provenance: existing.provenance },
        "deleted",
        now
      );
      return { ok: true, entry: await readRow(id) };
    },

    /** Counts for the control center. Never returns statements, only shape. */
    async stats({ project } = {}) {
      const rows = await query(
        "SELECT kind, status, COUNT(*) AS total FROM habitat_ax_memory WHERE project = ? GROUP BY kind, status",
        [String(project || "").trim().toLowerCase()]
      );
      return {
        project: String(project || "").trim().toLowerCase(),
        active: rows.filter(row => row.status === "active").reduce((sum, row) => sum + Number(row.total), 0),
        deleted: rows.filter(row => row.status === "deleted").reduce((sum, row) => sum + Number(row.total), 0),
        byKind: Object.fromEntries(rows.filter(row => row.status === "active").map(row => [row.kind, Number(row.total)])),
        kinds: MEMORY_KINDS
      };
    },

    /** For tests and importers: the digest used to detect duplicate statements. */
    digest(statement) {
      return statementDigest(statement);
    },

    ownerAuthentication() {
      return { verifierConfigured: Boolean(ownerVerifier), policy: ownerRequired ? "required" : "optional" };
    }
  });
}
