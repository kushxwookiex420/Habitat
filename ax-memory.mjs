import { createHash } from "node:crypto";

/**
 * Habitat Ax memory: the durable project record Ax plans against.
 *
 * Design rules enforced here, not in the storage layer:
 *
 *  - A memory entry is always labelled with what kind of statement it is. An imported conversation,
 *    a model's guess and a verified fact are different kinds and must never be silently merged.
 *  - Nothing that looks like a credential is accepted, whatever the caller claims about it.
 *  - Updates are versioned. A writer that did not read the current version gets a conflict instead
 *    of silently overwriting a newer decision.
 *  - Deletion is a status change with a revision, not a destructive row delete, so an owner can see
 *    what was removed and when.
 */

export const MEMORY_KINDS = Object.freeze([
  "verified_fact",
  "claim",
  "assumption",
  "hypothesis",
  "decision",
  "preference",
  "goal",
  "status",
  "risk"
]);

/** Kinds an importer or a model may write. `verified_fact` is reserved for owner confirmation. */
export const UNVERIFIED_KINDS = Object.freeze(["claim", "assumption", "hypothesis"]);

export const MEMORY_SOURCES = Object.freeze(["owner", "ax", "import", "system"]);

export const MEMORY_LIMITS = Object.freeze({
  statementMax: 2000,
  keyMax: 64,
  projectMax: 64,
  tagsMax: 12,
  tagMax: 32
});

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/**
 * Credential detection. Deliberately errs towards refusing: a false positive costs a rephrase, a
 * false negative writes a live secret into long-lived project memory.
 */
const SECRET_PATTERNS = Object.freeze([
  { label: "openai_key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { label: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { label: "assigned_secret", re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/i },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ }
]);

/** Returns the label of the first credential-looking pattern, or null. */
export function findSecret(value) {
  const text = String(value ?? "");
  for (const { label, re } of SECRET_PATTERNS) if (re.test(text)) return label;
  return null;
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = [];
  for (const tag of tags) {
    const clean = cleanText(tag, MEMORY_LIMITS.tagMax).toLowerCase();
    if (clean && !seen.includes(clean)) seen.push(clean);
    if (seen.length >= MEMORY_LIMITS.tagsMax) break;
  }
  return seen;
}

export function memoryId(project, key) {
  return "mem_" + createHash("sha256").update(project + "\u0000" + key).digest("hex").slice(0, 32);
}

export function statementDigest(statement) {
  return createHash("sha256")
    .update(String(statement ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .digest("hex");
}

/**
 * Validate and normalize a write.
 *
 * `provenance` is required. Memory without a source is indistinguishable from an invented fact, and
 * the whole point of the kind/confidence split is that a reader can tell the difference.
 */
export function normalizeMemoryEntry(input = {}) {
  const project = String(input.project || "").trim().toLowerCase();
  const key = String(input.key || "").trim().toLowerCase();
  const kind = String(input.kind || "").trim().toLowerCase();
  const statement = cleanText(input.statement, MEMORY_LIMITS.statementMax);

  if (!PROJECT_PATTERN.test(project)) return { ok: false, code: "invalid_project" };
  if (!KEY_PATTERN.test(key) || key.length > MEMORY_LIMITS.keyMax) return { ok: false, code: "invalid_key" };
  if (!MEMORY_KINDS.includes(kind)) return { ok: false, code: "invalid_kind", allowed: MEMORY_KINDS };
  if (!statement) return { ok: false, code: "empty_statement" };

  const secret = findSecret(statement) || findSecret(key) || findSecret(input.tags);
  if (secret) return { ok: false, code: "contains_credential", detail: secret };

  const provenanceInput = input.provenance && typeof input.provenance === "object" ? input.provenance : null;
  const source = String(provenanceInput?.source || "").trim().toLowerCase();
  if (!provenanceInput || !MEMORY_SOURCES.includes(source)) {
    return { ok: false, code: "missing_provenance", allowed: MEMORY_SOURCES };
  }
  const provenanceSecret = findSecret(JSON.stringify(provenanceInput));
  if (provenanceSecret) return { ok: false, code: "contains_credential", detail: provenanceSecret };

  const confidence = input.confidence === undefined || input.confidence === null ? null : Number(input.confidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return { ok: false, code: "invalid_confidence" };
  }

  return {
    ok: true,
    entry: {
      project,
      key,
      kind,
      statement,
      provenance: {
        source,
        actor: cleanText(provenanceInput.actor, 64) || null,
        ref: cleanText(provenanceInput.ref, 200) || null,
        observedAt: cleanText(provenanceInput.observedAt, 40) || null
      },
      tags: cleanTags(input.tags),
      confidence,
      // A model-written claim can never claim to be a verified fact. Only an owner write may.
      downgraded: UNVERIFIED_KINDS.includes(kind) ? false : source !== "owner"
    }
  };
}

/**
 * Conflict rules for a write.
 *
 *  - `expectedVersion` present and different  -> hard conflict (a concurrent writer won the race).
 *  - same key, different kind                 -> conflict unless the caller says it is a correction.
 *  - same key, different statement            -> allowed (that is an update), but a caller that did
 *    not pass `expectedVersion` gets a conflict so a blind overwrite cannot happen.
 *  - identical statement                      -> idempotent no-op, not a new version.
 */
export function evaluateWrite(existing, entry, { expectedVersion = null, allowKindChange = false } = {}) {
  if (!existing) {
    if (expectedVersion !== null && Number(expectedVersion) !== 0) {
      return { conflict: true, code: "memory_conflict", reason: "expected_version_missing_row" };
    }
    return { conflict: false, action: "insert" };
  }
  if (expectedVersion === null || expectedVersion === undefined) {
    return { conflict: true, code: "memory_conflict", reason: "expected_version_required" };
  }
  if (Number(expectedVersion) !== Number(existing.version)) {
    return { conflict: true, code: "memory_conflict", reason: "stale_version", currentVersion: existing.version };
  }
  if (existing.kind !== entry.kind && !allowKindChange) {
    return { conflict: true, code: "memory_conflict", reason: "kind_change", currentKind: existing.kind };
  }
  if (statementDigest(existing.statement) === statementDigest(entry.statement) && existing.kind === entry.kind) {
    return { conflict: false, action: "unchanged" };
  }
  return { conflict: false, action: "update" };
}

/** Escape a user query for a SQL LIKE with `ESCAPE '\\'`. */
export function likePattern(query) {
  return "%" + String(query || "").replace(/[\\%_]/g, match => "\\" + match) + "%";
}
