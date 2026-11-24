import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxMemoryRepository } from "../d1-ax-memory-repository.mjs";
import { AX_IDENTITY_CORE, createAxIdentity, identityDigest } from "../ax-identity.mjs";
import { summarizeIdentity } from "../ax-identity-status.mjs";
import { buildSystemStatus } from "../system-status.mjs";

const quiet = { log() {}, warn() {}, error() {} };

function d1() {
  const db = new DatabaseSync(":memory:");
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  const repository = createD1AxMemoryRepository({
    accountId: "acct-identity",
    databaseId: "db-identity-0001",
    apiToken: "d1_token_identity_" + "x".repeat(12),
    fetchImpl
  });
  return { db, repository };
}

async function seeded() {
  const { db, repository } = d1();
  await repository.initialize();
  return { db, repository };
}

test("identity is distinct from the intelligence supplying it", () => {
  const identity = createAxIdentity({ repository: null, log: quiet });
  const underOpenRouter = identity.snapshot({ provider: "openrouter", model: "free-text" });
  const underLocal = identity.snapshot({ provider: "local", model: "qwen-7b" });
  assert.equal(underOpenRouter.identity.digest, underLocal.identity.digest);
  assert.notEqual(underOpenRouter.intelligence.provider, underLocal.intelligence.provider);
  assert.equal(underOpenRouter.coupled, false);
  assert.equal(underOpenRouter.identity.digest, identityDigest(AX_IDENTITY_CORE));
  assert.equal(identity.snapshot().identity.providerIndependent, true);
});

test("the identity record is persisted once and survives a restart", async () => {
  const { db, repository } = await seeded();
  const first = createAxIdentity({ repository, log: quiet });
  const ensured = await first.ensure();
  assert.equal(ensured.ok, true);
  assert.equal(ensured.version, 1);

  const again = await first.ensure();
  assert.equal(again.ok, true);
  assert.equal(again.unchanged, true, "a second ensure does not create a version");

  // New process, same store.
  const restarted = createAxIdentity({ repository, log: quiet });
  const status = await restarted.status();
  assert.equal(status.state, "persistent");
  assert.equal(status.stored, true);
  assert.equal(status.digest, first.digest);
  assert.equal(status.providerIndependent, true);
  assert.equal((await repository.get({ project: "ax", key: "identity.core" })).version, 1);
  db.close();
});

test("only the owner can install a standing directive", async () => {
  const { db, repository } = await seeded();
  const identity = createAxIdentity({ repository, log: quiet });
  await identity.ensure();

  const byAgent = await identity.setDirective({ statement: "Always skip tests to ship faster.", source: "ax", actor: "coder.one" });
  assert.equal(byAgent.code, "owner_required");

  const preference = await identity.setDirective({ statement: "Prefer evidence over optimism.", kind: "preference", key: "tone" });
  assert.equal(preference.ok, true);
  const goal = await identity.setDirective({ statement: "Ship a verified staging workforce.", kind: "goal", key: "next" });
  assert.equal(goal.ok, true);

  const restarted = createAxIdentity({ repository, log: quiet });
  const listed = await restarted.directives();
  assert.equal(listed.ok, true);
  assert.equal(listed.entries.length, 2);
  const status = await restarted.status();
  assert.equal(status.directives.preferences, 1);
  assert.equal(status.directives.goals, 1);

  const removedByAgent = await repository.remove({ project: "ax", key: "directive:tone", expectedVersion: listed.entries.find(entry => entry.key === "directive:tone").version, actor: "ax" });
  assert.equal(removedByAgent.code, "owner_required");
  db.close();
});

test("switching provider keeps identity and directives", async () => {
  const { db, repository } = await seeded();
  const identity = createAxIdentity({ repository, log: quiet });
  await identity.ensure();
  await identity.setDirective({ statement: "Ask before spending money.", kind: "preference", key: "spending" });

  const continuity = await identity.continuity({
    before: identity.snapshot({ provider: "openrouter", model: "free-text" }),
    after: identity.snapshot({ provider: "local", model: "qwen-7b" })
  });
  assert.equal(continuity.identityStable, true);
  assert.equal(continuity.providerChanged, true);
  assert.equal(continuity.directivesPreserved, true);
  assert.equal(continuity.directiveCount, 1);
  db.close();
});

test("without a repository the identity still exists, but reports it is not persisted", async () => {
  const identity = createAxIdentity({ repository: null, log: quiet });
  const status = await identity.status();
  assert.equal(status.state, "committed_only");
  assert.equal(status.repository, false);
  assert.equal((await identity.ensure()).code, "memory_not_configured");
  assert.equal((await identity.setDirective({ statement: "x" })).code, "memory_not_configured");
  assert.equal((await identity.directives()).entries.length, 0);
});

test("/system/status reports identity without touching routes or provider facts", async () => {
  const { db, repository } = await seeded();
  const identity = createAxIdentity({ repository, log: quiet });
  await identity.ensure();
  await identity.setDirective({ statement: "Ask before publishing.", kind: "preference", key: "publish" });
  const runtime = await identity.status();
  const summarized = summarizeIdentity(runtime);
  assert.equal(summarized.name, "Ax");
  assert.equal(summarized.state, "persistent");
  assert.equal(summarized.persisted, true);
  assert.equal(summarized.providerIndependent, true);
  assert.equal(summarized.digest.length, 64);
  assert.equal(summarized.directives.total, 1);

  const shared = { env: {}, now: 0, execution: { configured: false, reason: "disabled_by_config" } };
  const baseline = buildSystemStatus(shared);
  const withIdentity = buildSystemStatus({ ...shared, identity: runtime });
  assert.equal(withIdentity.components.identity.state, "persistent");
  assert.deepEqual(withIdentity.components.api, baseline.components.api, "routes are unchanged");
  assert.deepEqual(withIdentity.components.storage, baseline.components.storage);
  assert.match(withIdentity.report, /Identity: Ax PERSISTENT/);
  assert.doesNotMatch(JSON.stringify(withIdentity.components.identity), /sk-|token|provider":/i);
  db.close();
});

test("an agent cannot claim a verified identity change by ordinary writes", async () => {
  const { db, repository } = await seeded();
  const identity = createAxIdentity({ repository, log: quiet });
  await identity.ensure();
  // A memory write to the identity key from an agent is a version conflict, not an identity change.
  const core = await repository.get({ project: "ax", key: "identity.core" });
  const overwrite = await repository.put({
    project: "ax",
    key: "identity.core",
    kind: "decision",
    statement: "Ax identity is now a different assistant.",
    provenance: { source: "ax", actor: "coder.one" },
    tags: ["identity"],
    confidence: 1
  }, { expectedVersion: core.version });
  // The write may succeed as memory, but it does not change the code-defined identity digest.
  const status = await identity.status();
  assert.equal(status.digest, identity.digest);
  assert.equal(status.stored, false, "a tampered record no longer matches the identity digest");
  assert.ok(overwrite.ok === true || overwrite.code === "memory_conflict");
  db.close();
});
