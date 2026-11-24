import { memoryKeywords } from "./ax-memory-context.mjs";

/**
 * Memory intelligence: freshness, conflict surfacing and hybrid ranking.
 *
 * This module is read-only. It never rewrites a memory, never promotes one to a verified fact and
 * never resolves a conflict on its own: conflicting records are surfaced for the owner, which is the
 * only authority allowed to correct them.
 *
 * Retrieval limitation, stated plainly: ranking here is lexical (keyword coverage, kind weight,
 * confidence and recency), not semantic. It is hybrid in the sense that it combines metadata and
 * relevance signals; it is not an embedding search and is not described as one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Review windows by kind. `null` means the record does not silently expire. */
export const REVIEW_POLICY_DAYS = Object.freeze({
  verified_fact: null,
  decision: null,
  preference: null,
  goal: null,
  claim: 90,
  assumption: 30,
  hypothesis: 14,
  status: 30,
  risk: 30
});

const KIND_WEIGHT = Object.freeze({
  verified_fact: 3,
  decision: 2.6,
  preference: 2.2,
  goal: 2,
  status: 1.6,
  risk: 1.6,
  claim: 1,
  assumption: 0.9,
  hypothesis: 0.8
});

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function tokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length >= 4)
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function negated(text) {
  return /\b(not|never|no longer|isn't|aren't|don't|doesn't|avoid|reject|disabled|false)\b/i.test(String(text || ""));
}

function topicOf(entry) {
  const key = String(entry?.key || "");
  const prefix = key.split(":")[0];
  return prefix || key || String(entry?.id || "");
}

/** Freshness for one record, derived from its own timestamps and kind. */
export function assessFreshness(entry, { now = Date.now() } = {}) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const observed = Date.parse(entry?.provenance?.observedAt || entry?.updatedAt || entry?.createdAt || "") || nowMs;
  const ageDays = Math.max(0, (nowMs - observed) / DAY_MS);
  const window = REVIEW_POLICY_DAYS[entry?.kind];
  const reviewAt = window === null || window === undefined ? null : new Date(observed + window * DAY_MS).toISOString();
  return {
    key: entry?.key || null,
    kind: entry?.kind || null,
    ageDays: Number(ageDays.toFixed(1)),
    reviewAt,
    stale: reviewAt !== null && nowMs > Date.parse(reviewAt),
    expiringSoon: reviewAt !== null && nowMs <= Date.parse(reviewAt) && Date.parse(reviewAt) - nowMs <= 7 * DAY_MS
  };
}

/**
 * Possible conflicts across records.
 *
 * Two records conflict when they discuss the same topic with substantial lexical overlap and either
 * make opposing negated claims or are both authoritative kinds with different statements. This is a
 * triage signal, not a truth decision: the owner decides.
 */
export function detectConflicts(entries, { now = Date.now(), maxPairs = 20 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => entry && entry.status !== "deleted");
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (topicOf(a) !== topicOf(b)) continue;
      const overlap = jaccard(tokens(a.statement), tokens(b.statement));
      if (overlap < 0.45) continue;
      const opposing = negated(a.statement) !== negated(b.statement);
      const authoritative = ["verified_fact", "decision"].includes(a.kind) && ["verified_fact", "decision"].includes(b.kind);
      if (!opposing && !(authoritative && overlap >= 0.6)) continue;
      pairs.push({
        a: { key: a.key, kind: a.kind, statement: clean(a.statement, 240) },
        b: { key: b.key, kind: b.kind, statement: clean(b.statement, 240) },
        topic: topicOf(a),
        kind: opposing ? "opposing_claims" : "authoritative_disagreement",
        overlap: Number(overlap.toFixed(2)),
        resolution: "owner_review_required"
      });
      if (pairs.length >= maxPairs) return pairs;
    }
  }
  return pairs;
}

/**
 * Hybrid lexical ranking: keyword coverage, kind weight, confidence and recency, with a staleness
 * penalty. Deterministic for identical inputs so a retried run retrieves the same context.
 */
export function rankMemoryCandidates(entries, objective, { now = Date.now(), maxEntries = 8 } = {}) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const keywords = memoryKeywords(objective, 8);
  const scored = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.status === "deleted") continue;
    const text = [entry.key, entry.statement, ...(Array.isArray(entry.tags) ? entry.tags : [])]
      .map(value => String(value ?? "").toLowerCase())
      .join(" ");
    const hits = keywords.filter(keyword => text.includes(keyword)).length;
    const confidence = entry.confidence === null || entry.confidence === undefined ? 0.5 : Number(entry.confidence);
    const freshness = assessFreshness(entry, { now: nowMs });
    const recencyBonus = Math.max(0, 1.5 - freshness.ageDays / 60);
    const stalePenalty = freshness.stale ? 1.2 : 0;
    scored.push({
      entry,
      score: Number(((KIND_WEIGHT[entry.kind] ?? 1) + hits * 1.8 + confidence + recencyBonus - stalePenalty).toFixed(4)),
      hits,
      verifiedTier: entry.kind === "verified_fact" ? 1 : 0,
      stale: freshness.stale,
      reviewAt: freshness.reviewAt
    });
  }
  scored.sort((a, b) => b.verifiedTier - a.verifiedTier || b.score - a.score || String(a.entry.key).localeCompare(String(b.entry.key)));
  return scored.slice(0, Math.max(1, maxEntries)).map(item => ({
    key: item.entry.key,
    kind: item.entry.kind,
    score: item.score,
    hits: item.hits,
    stale: item.stale,
    reviewAt: item.reviewAt,
    source: item.entry.provenance?.source || "unknown",
    version: Number(item.entry.version || 0),
    statement: clean(item.entry.statement, 240)
  }));
}

/**
 * One report for the control center: what is stale, what expires soon, what conflicts, and how the
 * records rank for a query. Entries are supplied by the caller from the live repository.
 */
export function memoryInsights({ entries = [], objective = "", now = Date.now() } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => entry && entry.status !== "deleted");
  const freshness = list.map(entry => ({ ...assessFreshness(entry, { now }), key: entry.key, kind: entry.kind }));
  return {
    observedAt: new Date(typeof now === "number" ? now : Date.parse(now)).toISOString(),
    total: list.length,
    stale: freshness.filter(item => item.stale).slice(0, 20),
    expiringSoon: freshness.filter(item => item.expiringSoon).slice(0, 20),
    conflicts: detectConflicts(list, { now }),
    ranking: objective ? rankMemoryCandidates(list, objective, { now }) : [],
    reviewPolicyDays: { ...REVIEW_POLICY_DAYS },
    limitations: [
      "Lexical ranking only: no embeddings, no semantic search.",
      "Conflicts are triaged for owner review; nothing is overwritten.",
      "Expiry is a review reminder derived from kind and observation time, not automatic deletion."
    ]
  };
}
