import { timingSafeEqual } from "node:crypto";

const API = "https://api.cloudflare.com/client/v4";
const ALLOWED_STATUS = new Set(["verified", "inferred", "stale", "blocked"]);
const ALLOWED_CATEGORIES = new Set(["decision", "fact", "preference", "open-loop", "result", "constraint"]);

export function createD1WorkspaceRepository({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("Ax Workspace requires CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID, and HABITAT_D1_API_TOKEN.");
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
      throw new Error(`Ax Workspace D1 query failed with HTTP ${response.status}; check D1 credentials, database ID, and schema.`);
    }
    return payload.result || [];
  }

  function decode(row) {
    try {
      const item = JSON.parse(row.record_json);
      return item && typeof item.id === "string" ? item : null;
    } catch { return null; }
  }

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    async initialize() {
      await query("CREATE TABLE IF NOT EXISTS habitat_workspace_memories (id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, category TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await query("CREATE INDEX IF NOT EXISTS habitat_workspace_project_updated ON habitat_workspace_memories(project, updated_at DESC)");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    },
    async upsert(input) {
      const item = validateMemory(input);
      await query(
        "INSERT INTO habitat_workspace_memories (id, project, category, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project = excluded.project, category = excluded.category, record_json = excluded.record_json, updated_at = excluded.updated_at",
        [item.id, item.project, item.category, JSON.stringify(item), item.createdAt, item.updatedAt]
      );
      return structuredClone(item);
    },
    async list({ project = "", limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
      const result = project
        ? await query("SELECT record_json FROM habitat_workspace_memories WHERE project = ? ORDER BY updated_at DESC LIMIT ?", [String(project).slice(0, 80), safeLimit])
        : await query("SELECT record_json FROM habitat_workspace_memories ORDER BY updated_at DESC LIMIT ?", [safeLimit]);
      return (result[0]?.results || []).map(decode).filter(Boolean);
    },
    async healthCheck() {
      await query("SELECT 1 AS ok");
      return { ok: true, adapter: "cloudflare-d1", durable: true };
    }
  });
}

function validateMemory(input) {
  const now = new Date().toISOString();
  const project = String(input?.project || "").trim();
  const content = String(input?.content || "").trim();
  const category = String(input?.category || "fact").trim();
  const status = String(input?.status || "inferred").trim();
  const id = String(input?.id || `mem-${cryptoRandomId()}`).trim();
  const sourceUrl = String(input?.sourceUrl || "").trim();
  const expiresAt = input?.expiresAt == null || input.expiresAt === "" ? null : String(input.expiresAt);
  const confidence = input?.confidence == null ? 0.5 : Number(input.confidence);
  if (!project || project.length > 80) throw new Error("project is required and must be at most 80 characters.");
  if (!content || content.length > 4000) throw new Error("content is required and must be at most 4000 characters.");
  if (!ALLOWED_CATEGORIES.has(category)) throw new Error("category must be decision, fact, preference, open-loop, result, or constraint.");
  if (!ALLOWED_STATUS.has(status)) throw new Error("status must be verified, inferred, stale, or blocked.");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("confidence must be between 0 and 1.");
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) throw new Error("sourceUrl must be an HTTP(S) URL.");
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error("expiresAt must be a valid date.");
  if (id.length > 120) throw new Error("id must be at most 120 characters.");
  return {
    id, project, category, content, status, confidence,
    sourceUrl: sourceUrl || null,
    createdAt: String(input?.createdAt || now),
    updatedAt: now,
    expiresAt
  };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerAxWorkspace(app, { repository, writeToken = "" } = {}) {
  app.get("/workspace/status", async (_req, res) => {
    if (!repository) return res.status(503).json({ ok: false, durable: false, error: "Ax Workspace durable storage is not configured or available." });
    try {
      const health = await repository.healthCheck();
      return res.json({ ok: true, durable: health.durable === true, adapter: health.adapter, writeProtection: writeToken ? "token-required" : "writes-disabled" });
    } catch {
      return res.status(503).json({ ok: false, durable: false, error: "Ax Workspace storage health check failed." });
    }
  });

  app.get("/workspace/memories", async (req, res) => {
    if (!repository) return res.status(503).json({ ok: false, error: "Ax Workspace durable storage is not configured or available." });
    try {
      const project = String(req.query?.project || "").trim();
      const limit = Number(req.query?.limit || 100);
      const memories = await repository.list({ project, limit });
      return res.json({ ok: true, durable: true, count: memories.length, memories });
    } catch {
      return res.status(503).json({ ok: false, error: "Ax Workspace could not read durable memories." });
    }
  });

  app.post("/workspace/memories", async (req, res) => {
    if (!repository) return res.status(503).json({ ok: false, error: "Ax Workspace durable storage is not configured or available." });
    const authorization = String(req.get("authorization") || "");
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokenMatches(writeToken, supplied)) return res.status(writeToken ? 401 : 503).json({ ok: false, error: writeToken ? "A valid workspace write token is required." : "Workspace writes are disabled until HABITAT_WORKSPACE_WRITE_TOKEN is configured." });
    try {
      const memory = await repository.upsert(req.body || {});
      return res.status(201).json({ ok: true, durable: true, memory });
    } catch (error) {
      return res.status(400).json({ ok: false, error: String(error?.message || "Invalid workspace memory.") });
    }
  });
}
