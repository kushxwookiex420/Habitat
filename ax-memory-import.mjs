import { createHash } from "node:crypto";
import { findSecret, MEMORY_LIMITS } from "./ax-memory.mjs";

/**
 * ChatGPT export → Habitat memory candidates.
 *
 * A conversation export is a record of what was *said*, not of what is true. Importing it wholesale
 * would make every stale assumption, abandoned plan and model guess indistinguishable from an
 * owner-verified fact. So this pipeline has three separate gates:
 *
 *   1. Extraction produces candidates only, always `kind: "claim"`, with conversation provenance.
 *   2. Nothing is written unless the owner explicitly names the candidate ids to approve.
 *   3. The write goes through the normal memory repository, so credential scanning, versioning and
 *      conflict detection apply exactly as they do to a hand-written entry.
 *
 * A conversation is never treated as a transfer of the ChatGPT session itself. It is source material
 * that a Habitat Ax runtime can read once the owner has accepted it.
 */

export const IMPORT_LIMITS = Object.freeze({
  maxConversations: 50,
  maxPerConversation: 5,
  minStatementLength: 40,
  maxTotal: 100
});

function textOfContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content.parts)) {
    return content.parts.map(part => (typeof part === "string" ? part : part?.text || "")).join(" ");
  }
  if (typeof content.text === "string") return content.text;
  return "";
}

/** Accept the real export shape, a `{ conversations: [...] }` wrapper, and a simplified fixture shape. */
export function parseChatGptExport(input) {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, code: "invalid_export_json", conversations: [] };
    }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.conversations) ? parsed.conversations : null;
  if (!list) return { ok: false, code: "invalid_export_shape", conversations: [] };

  const conversations = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || raw.conversation_id || raw.title || "").slice(0, 80) || "conversation-" + conversations.length;
    const title = String(raw.title || "untitled").slice(0, 200);
    const messages = [];

    if (Array.isArray(raw.messages)) {
      raw.messages.forEach((message, index) => {
        messages.push({
          role: String(message?.role || message?.author?.role || "unknown").toLowerCase(),
          text: textOfContent(message?.content ?? message?.text),
          timestamp: message?.timestamp || message?.create_time || null,
          index
        });
      });
    } else if (raw.mapping && typeof raw.mapping === "object") {
      const nodes = Object.values(raw.mapping)
        .map(node => node?.message)
        .filter(Boolean)
        .sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0));
      nodes.forEach((message, index) => {
        messages.push({
          role: String(message?.author?.role || "unknown").toLowerCase(),
          text: textOfContent(message?.content),
          timestamp: message?.create_time || null,
          index
        });
      });
    }
    conversations.push({ id, title, messages });
  }
  return { ok: true, conversations: conversations.slice(0, IMPORT_LIMITS.maxConversations) };
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "conversation";
}

function candidateId(project, key) {
  return "imp_" + createHash("sha256").update(project + "\u0000" + key).digest("hex").slice(0, 24);
}

/**
 * Derive candidates from an export. Pure: no repository, no network, nothing written.
 *
 * Only owner (user) messages are considered. Assistant messages are excluded deliberately: a model's
 * own output is the least reliable thing in the transcript and would need its own verification pass.
 */
export function deriveMemoryCandidates(input, { project, now = null } = {}) {
  const projectId = String(project || "").trim().toLowerCase();
  if (!projectId) return { ok: false, code: "invalid_project", candidates: [], rejected: [], stats: {} };

  const parsed = parseChatGptExport(input);
  if (!parsed.ok) return { ...parsed, candidates: [], rejected: [], stats: {} };

  const candidates = [];
  const rejected = [];
  const seen = new Set();
  const seenStatements = new Set();
  const reject = (reason, detail = null) => rejected.push({ reason, detail });

  for (const conversation of parsed.conversations) {
    let taken = 0;
    for (const message of conversation.messages) {
      if (taken >= IMPORT_LIMITS.maxPerConversation) break;
      if (message.role !== "user") continue;
      const statement = String(message.text || "").replace(/\s+/g, " ").trim().slice(0, MEMORY_LIMITS.statementMax);
      if (statement.length < IMPORT_LIMITS.minStatementLength) {
        reject("statement_too_short");
        continue;
      }
      const secret = findSecret(statement);
      if (secret) {
        reject("contains_credential", secret);
        continue;
      }
      const key = "import:" + slug(conversation.title) + ":" + message.index;
      // Two gates: the same message index is a duplicate key, and the same statement repeated in a
      // different turn is a duplicate statement. An export repeats things constantly.
      const digest = createHash("sha256").update(statement.toLowerCase().replace(/\s+/g, " ")).digest("hex");
      if (seen.has(key)) {
        reject("duplicate_key");
        continue;
      }
      if (seenStatements.has(digest)) {
        reject("duplicate_statement");
        continue;
      }
      seen.add(key);
      seenStatements.add(digest);
      const observedAt =
        typeof message.timestamp === "number"
          ? new Date(message.timestamp * (message.timestamp > 1e12 ? 1 : 1000)).toISOString()
          : message.timestamp
            ? String(message.timestamp)
            : now;
      candidates.push({
        candidateId: candidateId(projectId, key),
        project: projectId,
        key,
        // Never a verified fact. Approval does not make an export authoritative; it makes it accepted
        // owner context, which is exactly what `claim` means.
        kind: "claim",
        statement,
        confidence: 0.35,
        tags: ["chatgpt-export"],
        provenance: {
          source: "import",
          actor: "owner",
          ref: "chatgpt:" + conversation.id + "#" + message.index,
          observedAt
        },
        requiresOwnerApproval: true
      });
      taken += 1;
      if (candidates.length >= IMPORT_LIMITS.maxTotal) break;
    }
    if (candidates.length >= IMPORT_LIMITS.maxTotal) break;
  }

  return {
    ok: true,
    candidates,
    rejected,
    stats: {
      conversations: parsed.conversations.length,
      candidates: candidates.length,
      rejected: rejected.length,
      writes: 0
    }
  };
}

/**
 * Write approved candidates through the memory repository.
 *
 * `approvedIds` is required and must be non-empty: an empty or missing set is a refusal, not
 * "approve everything". Existing keys are reported as skipped, never overwritten, because an import
 * must not silently replace a newer owner decision.
 */
export async function applyMemoryImport(repository, candidates, { approvedIds = [], now = () => new Date().toISOString() } = {}) {
  const approved = new Set((Array.isArray(approvedIds) ? approvedIds : []).map(id => String(id)));
  if (!approved.size) {
    return {
      ok: false,
      code: "owner_approval_required",
      inserted: 0,
      skipped: 0,
      failed: 0,
      results: []
    };
  }
  const results = [];
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (!approved.has(candidate.candidateId)) {
      skipped += 1;
      results.push({ candidateId: candidate.candidateId, status: "not_approved" });
      continue;
    }
    const result = await repository.put(
      {
        project: candidate.project,
        key: candidate.key,
        // Re-forced here as well: a tampered candidate cannot import itself as a verified fact.
        kind: "claim",
        statement: candidate.statement,
        provenance: { ...candidate.provenance, source: "import" },
        tags: candidate.tags,
        confidence: candidate.confidence
      },
      { expectedVersion: 0, now: now() }
    );
    if (result.ok) {
      inserted += 1;
      results.push({ candidateId: candidate.candidateId, status: result.unchanged ? "unchanged" : "inserted", key: candidate.key });
    } else if (result.code === "memory_conflict") {
      skipped += 1;
      results.push({ candidateId: candidate.candidateId, status: "skipped_existing", key: candidate.key, reason: result.reason });
    } else {
      failed += 1;
      results.push({ candidateId: candidate.candidateId, status: "refused", key: candidate.key, code: result.code });
    }
  }
  return { ok: failed === 0, inserted, skipped, failed, results };
}
