import { createHash } from "node:crypto";

/**
 * Memory export and recovery.
 *
 * A backup is a portable JSON document: active entries with their provenance, confidence, tags and
 * version, plus the revision history needed to explain how each value got there. Restore replays the
 * entries through the repository's own `put`, so every validation still runs — versioning, kind rules
 * and credential refusal — and a restore can never write a secret that a normal write would reject.
 *
 * A `digest` over the entries detects an edited or truncated backup before anything is written.
 * Restore is idempotent: identical entries are reported `unchanged` and add no version.
 */

export const MEMORY_BACKUP_SCHEMA = 1;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function essential(entry) {
  return {
    key: entry.key,
    kind: entry.kind,
    statement: entry.statement,
    provenance: entry.provenance,
    tags: entry.tags,
    confidence: entry.confidence,
    version: entry.version
  };
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function backupDigest(entries = []) {
  const rows = entries
    .map(essential)
    .sort((left, right) => String(left.key).localeCompare(String(right.key)));
  return sha256(canonical(rows));
}

/**
 * Export one project's active memory. Read-only; no query writes.
 * `historyLimit` bounds the revision arrays so a long-lived key cannot make an unbounded document.
 */
export async function exportMemory({ repository, project, now = () => new Date().toISOString(), historyLimit = 50 } = {}) {
  const projectId = String(project || "").trim().toLowerCase();
  if (!projectId) return { ok: false, code: "project_required" };
  if (!repository || typeof repository.list !== "function") return { ok: false, code: "memory_not_configured" };
  try {
    const entries = await repository.list({ project: projectId, limit: 5000 });
    const revisions = {};
    if (typeof repository.history === "function") {
      for (const entry of entries) {
        const rows = await repository.history({ project: projectId, key: entry.key });
        if (rows.length) revisions[entry.key] = rows.slice(-historyLimit);
      }
    }
    const portable = entries.map(essential);
    return {
      ok: true,
      schema: MEMORY_BACKUP_SCHEMA,
      project: projectId,
      exportedAt: now(),
      digest: backupDigest(portable),
      counts: {
        entries: portable.length,
        kinds: portable.reduce((accumulator, entry) => {
          accumulator[entry.kind] = (accumulator[entry.kind] || 0) + 1;
          return accumulator;
        }, {})
      },
      entries: portable,
      revisions
    };
  } catch (error) {
    return { ok: false, code: "export_failed", error: String(error?.message || error).slice(0, 160) };
  }
}

/** Check a backup without writing: schema, project, digest and per-entry shape. */
export function verifyBackup(backup, { project = null } = {}) {
  if (!backup || typeof backup !== "object") return { ok: false, code: "backup_invalid" };
  if (backup.schema !== MEMORY_BACKUP_SCHEMA) return { ok: false, code: "backup_schema_unsupported", schema: backup.schema ?? null };
  if (!Array.isArray(backup.entries)) return { ok: false, code: "backup_entries_missing" };
  if (project && backup.project !== String(project).trim().toLowerCase()) {
    return { ok: false, code: "backup_project_mismatch", backupProject: backup.project || null };
  }
  const digest = backupDigest(backup.entries);
  if (digest !== backup.digest) return { ok: false, code: "backup_digest_mismatch", expected: backup.digest, actual: digest };
  const malformed = backup.entries.filter(entry => !entry || !entry.key || !entry.statement || !entry.kind);
  if (malformed.length) return { ok: false, code: "backup_entry_malformed", count: malformed.length };
  return { ok: true, digest, entries: backup.entries.length };
}

/**
 * Restore a backup into a repository. Idempotent and additive: it never deletes a local entry that the
 * backup does not contain, and it refuses to overwrite a locally newer version.
 */
export async function restoreMemory({ repository, backup, now = () => new Date().toISOString(), dryRun = false } = {}) {
  const verified = verifyBackup(backup);
  if (!verified.ok) return { ok: false, ...verified, writes: 0 };
  if (!repository || typeof repository.put !== "function") return { ok: false, code: "memory_not_configured", writes: 0 };

  const report = { ok: true, code: null, restored: 0, unchanged: 0, conflicts: [], refused: [], writes: 0, digest: verified.digest, dryRun };
  for (const entry of backup.entries) {
    let current = null;
    try {
      current = await repository.get({ project: backup.project, key: entry.key });
    } catch {
      report.ok = false;
      report.refused.push({ key: entry.key, code: "read_failed" });
      continue;
    }
    if (current && Number(current.version) > Number(entry.version)) {
      report.conflicts.push({ key: entry.key, localVersion: current.version, backupVersion: entry.version, code: "local_newer" });
      continue;
    }
    if (current && current.statement === entry.statement && current.kind === entry.kind) {
      report.unchanged += 1;
      continue;
    }
    if (dryRun) {
      report.restored += 1;
      continue;
    }
    let result;
    try {
      result = await repository.put({
        project: backup.project,
        key: entry.key,
        kind: entry.kind,
        statement: entry.statement,
        provenance: entry.provenance,
        tags: entry.tags,
        confidence: entry.confidence
      }, { expectedVersion: current ? current.version : 0, now: now() });
    } catch (error) {
      result = { ok: false, code: "write_failed", error: String(error?.message || error).slice(0, 160) };
    }
    if (result.ok) {
      report.writes += 1;
      report.restored += result.unchanged ? 0 : 1;
      if (result.unchanged) report.unchanged += 1;
    } else if (result.code === "memory_conflict") {
      report.conflicts.push({ key: entry.key, code: result.reason || "conflict" });
    } else {
      report.refused.push({ key: entry.key, code: result.code || "refused" });
    }
  }
  report.ok = report.conflicts.length === 0 && report.refused.length === 0;
  if (!report.ok) report.code = report.refused.length ? "restore_refused" : "restore_conflicts";
  return report;
}

/**
 * Read-only retention view: what is older than the window, by kind. Deletion is deliberately not
 * offered here — removal requires an owner action through the repository's own `remove`.
 */
export async function retentionReport({ repository, project, olderThanDays = 365, now = () => new Date().toISOString() } = {}) {
  const projectId = String(project || "").trim().toLowerCase();
  if (!repository || typeof repository.list !== "function" || !projectId) {
    return { ok: false, code: "memory_not_configured", candidates: [] };
  }
  const cutoff = Date.parse(now()) - Math.max(1, Number(olderThanDays) || 365) * 24 * 60 * 60 * 1000;
  const entries = await repository.list({ project: projectId, limit: 5000 });
  const candidates = entries
    .filter(entry => Date.parse(entry.updatedAt || entry.createdAt || 0) < cutoff)
    .map(entry => ({ key: entry.key, kind: entry.kind, version: entry.version, updatedAt: entry.updatedAt || null }));
  return {
    ok: true,
    project: projectId,
    olderThanDays: Number(olderThanDays) || 365,
    cutoff: new Date(cutoff).toISOString(),
    candidates,
    counts: candidates.reduce((accumulator, entry) => {
      accumulator[entry.kind] = (accumulator[entry.kind] || 0) + 1;
      return accumulator;
    }, {}),
    deletionPerformed: false,
    detail: "Candidates only. Deleting requires an owner action through the memory repository."
  };
}
