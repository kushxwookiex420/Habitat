import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxMemoryRepository } from "../d1-ax-memory-repository.mjs";
import { backupDigest, exportMemory, restoreMemory, retentionReport, verifyBackup } from "../ax-memory-backup.mjs";

const quiet = { log() {}, warn() {}, error() {} };

function d1() {
  const db = new DatabaseSync(":memory:");
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  const repository = createD1AxMemoryRepository({
    accountId: "acct-backup",
    databaseId: "db-backup-0001",
    apiToken: "d1_token_backup_" + "x".repeat(12),
    fetchImpl
  });
  return { db, repository };
}

const fact = (overrides = {}) => ({
  project: "habitat",
  key: "arch:engine",
  kind: "verified_fact",
  statement: "NEXUS keeps habitat_command_tasks as the only durable command task engine.",
  provenance: { source: "owner", actor: "owner", ref: "mission-08", observedAt: "2026-11-22T00:00:00.000Z" },
  tags: ["architecture"],
  confidence: 1,
  ...overrides
});

test("an exported backup restores into a fresh database and is idempotent", async () => {
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(fact(), { expectedVersion: 0 });
  await source.repository.put(fact({ key: "arch:memory", statement: "Memory is versioned and provenance is required.", kind: "decision" }), { expectedVersion: 0 });

  const backup = await exportMemory({ repository: source.repository, project: "habitat" });
  assert.equal(backup.ok, true);
  assert.equal(backup.entries.length, 2);
  assert.equal(verifyBackup(backup, { project: "habitat" }).ok, true);

  const target = d1();
  await target.repository.initialize();
  const restored = await restoreMemory({ repository: target.repository, backup });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored, 2);
  assert.equal(restored.conflicts.length, 0);

  const reexported = await exportMemory({ repository: target.repository, project: "habitat" });
  assert.equal(reexported.digest, backup.digest, "round trip preserves content exactly");

  const second = await restoreMemory({ repository: target.repository, backup });
  assert.equal(second.ok, true);
  assert.equal(second.restored, 0);
  assert.equal(second.unchanged, 2, "a replay adds no versions");

  const history = await target.repository.history({ project: "habitat", key: "arch:engine" });
  assert.equal(history.length, 1);
  source.db.close();
  target.db.close();
});

test("a tampered backup is refused before anything is written", async () => {
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(fact(), { expectedVersion: 0 });
  const backup = await exportMemory({ repository: source.repository, project: "habitat" });
  const tampered = { ...backup, entries: backup.entries.map(entry => ({ ...entry, statement: "A different claim entirely." })) };

  const target = d1();
  await target.repository.initialize();
  const result = await restoreMemory({ repository: target.repository, backup: tampered });
  assert.equal(result.ok, false);
  assert.equal(result.code, "backup_digest_mismatch");
  assert.equal(result.writes, 0);
  assert.equal((await target.repository.list({ project: "habitat" })).length, 0);
  source.db.close();
  target.db.close();
});

test("restore refuses to overwrite a locally newer version", async () => {
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(fact(), { expectedVersion: 0 });
  const backup = await exportMemory({ repository: source.repository, project: "habitat" });

  const target = d1();
  await target.repository.initialize();
  await target.repository.put(fact(), { expectedVersion: 0 });
  await target.repository.put(fact({ statement: "Locally corrected after the export." }), { expectedVersion: 1 });

  const result = await restoreMemory({ repository: target.repository, backup });
  assert.equal(result.ok, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].code, "local_newer");
  const local = await target.repository.get({ project: "habitat", key: "arch:engine" });
  assert.match(local.statement, /Locally corrected/);
  source.db.close();
  target.db.close();
});

test("a backup containing a credential is refused by the same rule as a normal write", async () => {
  const source = d1();
  await source.repository.initialize();
  const entry = {
    key: "leak:token",
    kind: "claim",
    statement: "The key is sk-" + "a".repeat(32) + " and must not be stored.",
    provenance: { source: "import", actor: "importer", ref: null, observedAt: "2026-11-23T00:00:00.000Z" },
    tags: [],
    confidence: 0.4,
    version: 1
  };
  const backup = {
    schema: 1,
    project: "habitat",
    exportedAt: "2026-11-24T00:00:00.000Z",
    digest: backupDigest([entry]),
    entries: [entry],
    revisions: {}
  };
  const target = d1();
  await target.repository.initialize();
  const result = await restoreMemory({ repository: target.repository, backup });
  assert.equal(result.ok, false);
  assert.equal(result.code, "restore_refused");
  assert.equal(result.refused[0].code, "contains_credential");
  assert.equal((await target.repository.list({ project: "habitat" })).length, 0);
  source.db.close();
  target.db.close();
});

test("retention reporting lists old entries without deleting anything", async () => {
  const { db, repository } = d1();
  await repository.initialize();
  await repository.put(fact(), { expectedVersion: 0, now: "2025-01-01T00:00:00.000Z" });
  await repository.put(fact({ key: "arch:new", statement: "A recent decision.", kind: "decision" }), { expectedVersion: 0, now: "2026-11-24T00:00:00.000Z" });

  const report = await retentionReport({ repository, project: "habitat", olderThanDays: 30, now: () => "2026-11-24T00:00:00.000Z" });
  assert.equal(report.ok, true);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].key, "arch:engine");
  assert.equal(report.deletionPerformed, false);
  assert.equal((await repository.list({ project: "habitat" })).length, 2, "reporting removed nothing");
  db.close();
});
