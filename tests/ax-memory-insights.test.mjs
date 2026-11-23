import test from "node:test";
import assert from "node:assert/strict";
import {
  assessFreshness,
  detectConflicts,
  memoryInsights,
  rankMemoryCandidates,
  REVIEW_POLICY_DAYS
} from "../ax-memory-insights.mjs";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const daysAgo = days => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function entry(overrides = {}) {
  return {
    key: "decision:deploy",
    kind: "decision",
    statement: "Deploy Habitat to Render production every Friday",
    confidence: 0.9,
    version: 2,
    status: "active",
    provenance: { source: "owner", observedAt: daysAgo(2) },
    tags: ["deploy"],
    ...overrides
  };
}

test("record freshness follows kind policy and never deletes anything", () => {
  const hypothesis = assessFreshness(entry({ kind: "hypothesis", provenance: { source: "ax", observedAt: daysAgo(20) } }), { now: NOW });
  assert.equal(hypothesis.stale, true);
  const fact = assessFreshness(entry({ kind: "verified_fact", provenance: { source: "owner", observedAt: daysAgo(900) } }), { now: NOW });
  assert.equal(fact.reviewAt, null);
  assert.equal(fact.stale, false);
  assert.equal(REVIEW_POLICY_DAYS.verified_fact, null);
});

test("opposing records on the same topic are surfaced for owner review", () => {
  const conflicts = detectConflicts([
    entry({ key: "decision:deploy", statement: "We will deploy Habitat to Render production every Friday" }),
    entry({ key: "decision:deploy-rule", statement: "We will not deploy Habitat to Render production every Friday" })
  ], { now: NOW });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "opposing_claims");
  assert.equal(conflicts[0].resolution, "owner_review_required");
});

test("records on different topics do not conflict", () => {
  const conflicts = detectConflicts([
    entry({ key: "decision:deploy", statement: "We will deploy Habitat to Render production every Friday" }),
    entry({ key: "goal:revenue", statement: "We will not deploy Habitat to Render production every Friday" })
  ], { now: NOW });
  assert.equal(conflicts.length, 0);
});

test("hybrid ranking prefers a verified fact and penalizes stale guesses", () => {
  const ranking = rankMemoryCandidates([
    entry({ key: "claim:deploy", kind: "claim", statement: "Deploy might happen on Render production", confidence: 0.4, provenance: { source: "import", observedAt: daysAgo(120) } }),
    entry({ key: "decision:deploy", kind: "verified_fact", statement: "Deploy happens on Render production every Friday", confidence: 0.95 })
  ], "When do we deploy to Render production?", { now: NOW });
  assert.equal(ranking[0].kind, "verified_fact");
  assert.equal(ranking[1].stale, true);
  assert.ok(ranking[0].score > ranking[1].score);
});

test("the insight report carries limitations instead of implying semantic search", () => {
  const report = memoryInsights({
    entries: [entry(), entry({ key: "hypothesis:render", kind: "hypothesis", statement: "Render may become expensive next quarter", provenance: { source: "ax", observedAt: daysAgo(30) } })],
    objective: "deploy to Render",
    now: NOW
  });
  assert.equal(report.total, 2);
  assert.equal(report.stale.length, 1);
  assert.ok(report.ranking.length >= 1);
  assert.ok(report.limitations.some(line => /Lexical ranking only/.test(line)));
  assert.equal(report.conflicts.length, 0);
});
