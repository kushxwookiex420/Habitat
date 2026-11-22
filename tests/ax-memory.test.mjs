import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxMemoryRepository, MEMORY_SCHEMA } from "../d1-ax-memory-repository.mjs";
import {
  MEMORY_KINDS,
  evaluateWrite,
  findSecret,
  likePattern,
  memoryId,
  normalizeMemoryEntry,
  statementDigest
} from "../ax-memory.mjs";

/**
 * Ax memory against the real repository code.
 *
 * Storage is SQLite behind the same D1 HTTP shape the deployment uses, so SQL, versioning and
 * compare-and-set are exercised for real. No Cloudflare database is contacted.
 */

const KEY = "sk-" + "m".repeat(30);

function d1() {
  const db = new DatabaseSync(":memory:");
  const statements = [];
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  const repository = createD1AxMemoryRepository({
    accountId: "acct-memory",
    databaseId: "db-memory-0001",
    apiToken: "d1_token_memory_" + "x".repeat(12),
    fetchImpl
  });
  return { db, repository, statements };
}

function entry(overrides = {}) {
  return {
    project: "habitat",
    key: "mission:08",
    kind: "decision",
    statement: "NEXUS stays the only task engine.",
    provenance: { source: "owner", actor: "owner", ref: "chat", observedAt: "2026-11-22T00:00:00.000Z" },
    tags: ["architecture"],
    confidence: null,
    ...overrides
  };
}

test("valid entries normalize, keys are canonical and the id is stable", () => {
  const normalized = normalizeMemoryEntry(entry({ project: "Habitat", key: "Mission:08 " }));
  assert.equal(normalized.ok, true);
  assert.equal(normalized.entry.project, "habitat");
  assert.equal(normalized.entry.key, "mission:08");
  assert.equal(normalized.entry.provenance.source, "owner");
  assert.deepEqual(normalized.entry.tags, ["architecture"]);
  assert.equal(memoryId("habitat", "mission:08"), memoryId("habitat", "mission:08"));
  assert.notEqual(memoryId("habitat", "mission:08"), memoryId("habitat", "mission:09"));
});

test("invalid shapes are refused with a specific code", () => {
  assert.equal(normalizeMemoryEntry(entry({ project: "Bad Project!" })).code, "invalid_project");
  assert.equal(normalizeMemoryEntry(entry({ key: "has spaces" })).code, "invalid_key");
  assert.equal(normalizeMemoryEntry(entry({ kind: "rumour" })).code, "invalid_kind");
  assert.equal(normalizeMemoryEntry(entry({ statement: "   " })).code, "empty_statement");
  assert.equal(normalizeMemoryEntry(entry({ provenance: null })).code, "missing_provenance");
  assert.equal(normalizeMemoryEntry(entry({ provenance: { source: "model" } })).code, "missing_provenance");
  assert.equal(normalizeMemoryEntry(entry({ confidence: 1.5 })).code, "invalid_confidence");
  assert.deepEqual(MEMORY_KINDS, [
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
});

test("credentials are refused before they can be written", () => {
  assert.equal(findSecret(KEY), "openai_key");
  assert.equal(findSecret("token: ghp_" + "a".repeat(30)), "github_token");
  assert.equal(findSecret("-----BEGIN RSA PRIVATE KEY-----"), "private_key");
  assert.equal(findSecret("password = hunter2hunter2"), "assigned_secret");
  assert.equal(findSecret("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"), "jwt");
  assert.equal(findSecret("nothing sensitive here"), null);

  const withKey = normalizeMemoryEntry(entry({ statement: "the key is " + KEY }));
  assert.equal(withKey.ok, false);
  assert.equal(withKey.code, "contains_credential");

  const inTags = normalizeMemoryEntry(entry({ tags: ["ghp_" + "b".repeat(30)] }));
  assert.equal(inTags.code, "contains_credential");
});

test("identity, version and conflict rules are explicit", () => {
  const first = normalizeMemoryEntry(entry()).entry;
  assert.deepEqual(evaluateWrite(null, first, { expectedVersion: 0 }), { conflict: false, action: "insert" });
  assert.equal(evaluateWrite(null, first, { expectedVersion: 3 }).reason, "expected_version_missing_row");

  const existing = { version: 2, kind: "decision", statement: "old" };
  assert.equal(evaluateWrite(existing, first, {}).reason, "expected_version_required");
  assert.equal(evaluateWrite(existing, first, { expectedVersion: 1 }).reason, "stale_version");
  assert.equal(
    evaluateWrite({ ...existing, kind: "goal" }, first, { expectedVersion: 2 }).reason,
    "kind_change"
  );
  assert.equal(
    evaluateWrite({ ...existing, kind: "goal" }, first, { expectedVersion: 2, allowKindChange: true }).action,
    "update"
  );
  assert.equal(
    evaluateWrite({ version: 2, kind: "decision", statement: "  nexus STAYS the only task engine. " }, first, { expectedVersion: 2 }).action,
    "unchanged"
  );
  assert.equal(statementDigest("A  b"), statementDigest(" a b "));
});

test("LIKE patterns escape wildcards so a search term cannot match everything", () => {
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
  assert.equal(likePattern("c:\\"), "%c:\\\\%");
});

test("the schema is additive and initializes idempotently", async () => {
  const { repository } = d1();
  assert.equal(await repository.initialize().then(result => result.ok), true);
  assert.equal(await repository.initialize().then(result => result.ok), true);
  for (const statement of MEMORY_SCHEMA) {
    assert.match(statement, /CREATE (TABLE|UNIQUE INDEX) IF NOT EXISTS/);
    assert.doesNotMatch(statement, /DROP|ALTER|DELETE FROM/i);
  }
  assert.ok(MEMORY_SCHEMA.some(statement => statement.includes("habitat_ax_memory_revisions")));
});

test("a write is readable, versioned and provenance is preserved", async () => {
  const { repository } = d1();
  await repository.initialize();
  const inserted = await repository.put(entry(), { expectedVersion: 0 });
  assert.equal(inserted.ok, true);
  assert.equal(inserted.entry.version, 1);
  assert.equal(inserted.entry.provenance.actor, "owner");
  assert.equal(inserted.downgraded, false);

  const read = await repository.get({ project: "habitat", key: "mission:08" });
  assert.equal(read.statement, "NEXUS stays the only task engine.");

  const updated = await repository.put(entry({ statement: "NEXUS stays the only task engine, with Ax above it." }), {
    expectedVersion: 1
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "update");
  assert.equal(updated.entry.version, 2);
  assert.equal(updated.previousVersion, 1);
});

test("a stale writer cannot overwrite a newer decision", async () => {
  const { repository } = d1();
  await repository.initialize();
  await repository.put(entry(), { expectedVersion: 0 });
  const [first, second] = await Promise.all([
    repository.put(entry({ statement: "decision from writer one" }), { expectedVersion: 1 }),
    repository.put(entry({ statement: "decision from writer two" }), { expectedVersion: 1 })
  ]);
  const succeeded = [first, second].filter(result => result.ok);
  const conflicted = [first, second].filter(result => !result.ok);
  assert.equal(succeeded.length, 1);
  assert.equal(conflicted.length, 1);
  assert.equal(conflicted[0].code, "memory_conflict");
  assert.equal(conflicted[0].current.version, 2);
});

test("an identical rewrite is an idempotent no-op, not a new version", async () => {
  const { repository } = d1();
  await repository.initialize();
  await repository.put(entry(), { expectedVersion: 0 });
  const again = await repository.put(entry({ statement: "  NEXUS stays the only task engine.  " }), { expectedVersion: 1 });
  assert.equal(again.ok, true);
  assert.equal(again.unchanged, true);
  const read = await repository.get({ project: "habitat", key: "mission:08" });
  assert.equal(read.version, 1);
});

test("history keeps every version, including the deletion", async () => {
  const { repository } = d1();
  await repository.initialize();
  await repository.put(entry(), { expectedVersion: 0 });
  await repository.put(entry({ statement: "second" }), { expectedVersion: 1 });
  await repository.remove({ project: "habitat", key: "mission:08", expectedVersion: 2, actor: "owner" });

  const history = await repository.history({ project: "habitat", key: "mission:08" });
  assert.deepEqual(history.map(item => item.action), ["created", "updated", "deleted"]);
  assert.deepEqual(history.map(item => item.version), [1, 2, 3]);
  assert.equal(history[1].statement, "second");
  assert.equal(history[0].provenance.source, "owner");
});

test("deletion requires the owner and the current version, and keeps the row", async () => {
  const { repository } = d1();
  await repository.initialize();
  await repository.put(entry(), { expectedVersion: 0 });

  const asAx = await repository.remove({ project: "habitat", key: "mission:08", expectedVersion: 1, actor: "ax" });
  assert.equal(asAx.code, "owner_required");

  const stale = await repository.remove({ project: "habitat", key: "mission:08", expectedVersion: 0, actor: "owner" });
  assert.equal(stale.code, "memory_conflict");

  const ok = await repository.remove({ project: "habitat", key: "mission:08", expectedVersion: 1, actor: "owner" });
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.status, "deleted");
  assert.ok(ok.entry.deletedAt);

  assert.equal(await repository.get({ project: "habitat", key: "mission:08" }), null);
  assert.deepEqual(await repository.search({ project: "habitat", query: "NEXUS" }), []);
});

test("search matches statement, key and tags, filters by kind, and ignores wildcards", async () => {
  const { repository } = d1();
  await repository.initialize();
  await repository.put(entry({ key: "mission:08", statement: "NEXUS stays the only task engine.", tags: ["architecture"] }), { expectedVersion: 0 });
  await repository.put(entry({ key: "risk:memory", kind: "risk", statement: "The 100% budget claim is unproven.", tags: ["budget"] }), { expectedVersion: 0 });
  await repository.put(entry({ key: "goal:sandbox", kind: "goal", statement: "Prove isolation on a dedicated host." }), { expectedVersion: 0 });

  assert.equal((await repository.search({ project: "habitat", query: "nexus" })).length, 1);
  assert.equal((await repository.search({ project: "habitat", query: "budget" })).length, 1);
  assert.equal((await repository.search({ project: "habitat", query: "100%" })).length, 1);
  assert.equal((await repository.search({ project: "habitat", query: "%" })).length, 1, "a bare % must not match every row");
  assert.equal((await repository.search({ project: "habitat", query: "e", kind: "goal" })).length, 1);
  assert.equal((await repository.list({ project: "habitat" })).length, 3);
  assert.equal((await repository.search({ project: "other", query: "nexus" })).length, 0);
});

test("a credential never reaches storage, even through the repository", async () => {
  const { repository, db } = d1();
  await repository.initialize();
  const refused = await repository.put(entry({ statement: "api_key = " + KEY }), { expectedVersion: 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "contains_credential");
  const rows = db.prepare("SELECT COUNT(*) AS total FROM habitat_ax_memory").all();
  assert.equal(Number(rows[0].total), 0);
});

test("stats report shape, not content", async () => {
  const { repository } = d1();
  await repository.initialize();
  await repository.put(entry({ key: "a", kind: "decision" }), { expectedVersion: 0 });
  await repository.put(entry({ key: "b", kind: "risk" }), { expectedVersion: 0 });
  await repository.remove({ project: "habitat", key: "b", expectedVersion: 1, actor: "owner" });
  const stats = await repository.stats({ project: "habitat" });
  assert.equal(stats.active, 1);
  assert.equal(stats.deleted, 1);
  assert.deepEqual(stats.byKind, { decision: 1 });
  assert.equal(JSON.stringify(stats).includes("NEXUS"), false);
});
