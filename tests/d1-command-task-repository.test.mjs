import test from "node:test";
import assert from "node:assert/strict";
import { createD1CommandTaskRepository } from "../d1-command-task-repository.mjs";

/**
 * The command store must survive restarts and must not silently degrade to memory.
 * These tests drive the real repository against a fake D1 endpoint that records the SQL.
 */

function fakeD1({ fail = false } = {}) {
  const rows = new Map();
  const statements = [];
  let beforeUpdate = null;
  let afterSelect = null;
  const fetchImpl = async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    statements.push(sql);
    if (fail) {
      return { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: "boom" }] }) };
    }
    const respond = results => ({ ok: true, status: 200, json: async () => ({ success: true, result: [{ results, meta: { changes: results.length } }] }) });

    if (/^CREATE (TABLE|INDEX)/i.test(sql)) return respond([]);
    if (/^INSERT INTO habitat_command_tasks/i.test(sql)) {
      const [id, recordJson, status, updatedAt] = params;
      rows.set(id, { record_json: recordJson, status, updated_at: updatedAt });
      return respond([{}]);
    }
    if (/^UPDATE habitat_command_tasks/i.test(sql)) {
      const [recordJson, status, updatedAt, id] = params;
      if (!rows.has(id)) return respond([]);
      // Unfenced legacy update: honour the database-side condition deterministically.
      if (/json_extract\(record_json, '\$\.fence'\) IS NULL/.test(sql)) {
        if (beforeUpdate) { const hook = beforeUpdate; beforeUpdate = null; hook({ rows }); }
        const expectedStatus = params[4];
        const expectedRaw = params[5];
        const row = rows.get(id);
        let current = null;
        try { current = JSON.parse(row.record_json); } catch { current = null; }
        if (!current || current.status !== expectedStatus) return respond([]);
        if ((current.fence ?? null) !== null) return respond([]);
        if (row.record_json !== expectedRaw) return respond([]);
        rows.set(id, { record_json: recordJson, status, updated_at: updatedAt });
        return respond([{ record_json: recordJson }]);
      }
      // Fenced transitions carry the expected fence/claimedBy; honour them like D1 does.
      if (/json_extract\(record_json, '\$\.fence'\) IS \?/.test(sql)) {
        const [, , , , expectStatus, expectFence, expectClaimedBy] = params;
        let current = null;
        try { current = JSON.parse(rows.get(id).record_json); } catch { current = null; }
        const matches = current
          && current.status === expectStatus
          && (current.fence ?? null) === (expectFence ?? null)
          && (current.claimedBy ?? null) === (expectClaimedBy ?? null);
        if (!matches) return respond([]);
      }
      rows.set(id, { record_json: recordJson, status, updated_at: updatedAt });
      return respond([{}]);
    }
    if (/^SELECT record_json FROM habitat_command_tasks WHERE id/i.test(sql)) {
      const row = rows.get(params[0]);
      const reply = row ? [{ record_json: row.record_json }] : [];
      if (afterSelect) { const hook = afterSelect; afterSelect = null; await hook({ rows }); }
      return respond(reply);
    }
    if (/^SELECT record_json FROM habitat_command_tasks WHERE status/i.test(sql)) {
      const [status, limit] = params;
      const matches = [...rows.values()].filter(row => row.status === status).slice(0, Number(limit));
      return respond(matches.map(row => ({ record_json: row.record_json })));
    }
    if (/^SELECT record_json FROM habitat_command_tasks/i.test(sql)) {
      const limit = Number(params[0]);
      return respond([...rows.values()].slice(0, limit).map(row => ({ record_json: row.record_json })));
    }
    if (/^SELECT 1 AS ok/i.test(sql)) return respond([{ ok: 1 }]);
    return respond([]);
  };
  return {
    fetchImpl, statements, rows,
    setBeforeUpdate(hook) { beforeUpdate = hook; },
    setAfterSelect(hook) { afterSelect = hook; }
  };
}

function build(options = {}) {
  const fake = fakeD1(options);
  const repository = createD1CommandTaskRepository({
    accountId: "acct",
    databaseId: "db",
    apiToken: "token",
    fetchImpl: fake.fetchImpl
  });
  return { repository, fake };
}

const task = {
  id: "cmd_1",
  objective: "ship the command center",
  status: "queued",
  createdAt: "2026-11-21T12:00:00.000Z",
  updatedAt: "2026-11-21T12:00:00.000Z"
};

test("every D1 request carries a bounded abort signal", async () => {
  const signals = [];
  const repository = createD1CommandTaskRepository({
    accountId: "acct",
    databaseId: "db",
    apiToken: "token",
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      return { ok: true, status: 200, async json() { return { success: true, result: [{ results: [] }] }; } };
    }
  });
  await repository.get("missing");
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[0].aborted, false);
  await repository.initialize();
  assert.ok(signals.length >= 2);
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
});

test("initialize creates the command table and index, idempotently", async () => {
  const { repository, fake } = build();
  const first = await repository.initialize();
  assert.equal(first.ok, true);
  const second = await repository.initialize();
  assert.equal(second.ok, true);
  assert.ok(fake.statements.some(sql => /CREATE TABLE IF NOT EXISTS habitat_command_tasks/.test(sql)));
  assert.ok(fake.statements.some(sql => /CREATE INDEX IF NOT EXISTS habitat_command_tasks_status_updated_at/.test(sql)));
  // Nothing is created outside the command table.
  assert.equal(fake.statements.some(sql => /habitat_tasks\b/.test(sql)), false);
});

test("a task survives a write and a read", async () => {
  const { repository } = build();
  await repository.initialize();
  const created = await repository.create(task);
  assert.equal(created.id, "cmd_1");
  const loaded = await repository.get("cmd_1");
  assert.equal(loaded.objective, "ship the command center");
  assert.equal(loaded.status, "queued");
});

test("an update changes both the record and the indexed status column", async () => {
  const { repository, fake } = build();
  await repository.initialize();
  await repository.create(task);
  const updated = await repository.update("cmd_1", { status: "done", result: { summary: "shipped", evidence: ["commit:abc"] } });
  assert.equal(updated.status, "done");
  assert.equal(updated.result.summary, "shipped");
  assert.ok(fake.statements.some(sql => /^UPDATE habitat_command_tasks SET record_json = \?, status = \?, updated_at = \? WHERE id = \? AND status = \? AND json_extract\(record_json, '\$\.fence'\) IS NULL AND record_json = \? RETURNING record_json$/.test(sql)));
  assert.equal(updated.id, "cmd_1");
});

test("listing filters by status and respects the requested limit", async () => {
  const { repository } = build();
  await repository.initialize();
  await repository.create(task);
  await repository.create({ ...task, id: "cmd_2", status: "done" });
  const queued = await repository.list({ status: "queued" });
  assert.deepEqual(queued.map(row => row.id), ["cmd_1"]);
  const all = await repository.list({ limit: 1 });
  assert.equal(all.length, 1);
});

test("updating a task that does not exist returns null instead of inventing a record", async () => {
  const { repository } = build();
  await repository.initialize();
  assert.equal(await repository.update("cmd_missing", { status: "done" }), null);
  assert.equal(await repository.get("cmd_missing"), null);
});

test("a failing D1 endpoint fails loudly so startup cannot silently use memory", async () => {
  const { repository } = build({ fail: true });
  await assert.rejects(() => repository.initialize(), /D1 command query failed/);
  await assert.rejects(() => repository.get("cmd_1"), /D1 command query failed/);
});

test("missing credentials are refused at construction", () => {
  assert.throws(() => createD1CommandTaskRepository({ accountId: "a", databaseId: "", apiToken: "" }), /requires CLOUDFLARE_ACCOUNT_ID/);
});

test("update() refuses to overwrite a worker-owned record at the repository boundary", async () => {
  const { repository, fake } = build();
  const at = new Date().toISOString();
  const row = {
    id: "cmd_fenced", objective: "worker owned", role: "ax", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: [],
    fence: "fence-live", claimedBy: "nexus-worker-1", leaseUntil: new Date(Date.now() + 60000).toISOString()
  };
  await repository.create(row);
  const before = fake.rows.get("cmd_fenced").record_json;

  await assert.rejects(
    () => repository.update("cmd_fenced", { ...row, status: "done", result: { summary: "hijack", evidence: ["x"] } }),
    /fenced command task/
  );
  assert.equal(fake.rows.get("cmd_fenced").record_json, before, "the fenced row was not rewritten");
  assert.match(fake.rows.get("cmd_fenced").record_json, /fence-live/);

  // A fenced transition with the wrong fence still writes nothing.
  const refused = await repository.transition("cmd_fenced", {
    expect: { status: "working", fence: "wrong-fence", claimedBy: "nexus-worker-9" },
    next: { ...row, status: "done" }
  });
  assert.equal(refused, null);
  assert.equal(fake.rows.get("cmd_fenced").record_json, before);
});

test("update() still works for unfenced legacy records", async () => {
  const { repository } = build();
  const at = new Date().toISOString();
  await repository.create({
    id: "cmd_legacy", objective: "legacy", role: "ax", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
  });
  const updated = await repository.update("cmd_legacy", {
    id: "cmd_legacy", objective: "legacy", role: "ax", status: "done",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: [],
    result: { summary: "manual close", evidence: ["note"] }
  });
  assert.equal(updated.status, "done");
});

test("a claim landing between the legacy read and the write rejects the write atomically", async () => {
  const { repository, fake } = build();
  const at = new Date().toISOString();
  await repository.create({
    id: "cmd_race", objective: "legacy", role: "ax", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
  });
  // Deterministic interleaving: the claim is applied after get() and before the conditional UPDATE.
  fake.setBeforeUpdate(({ rows }) => {
    const current = JSON.parse(rows.get("cmd_race").record_json);
    const claimed = {
      ...current, status: "working", fence: "fence-race-1", claimedBy: "nexus-worker-race",
      leaseUntil: new Date(Date.now() + 60000).toISOString(), updatedAt: new Date().toISOString()
    };
    rows.set("cmd_race", { record_json: JSON.stringify(claimed), status: "working", updated_at: claimed.updatedAt });
  });

  await assert.rejects(
    () => repository.update("cmd_race", {
      id: "cmd_race", objective: "hijack", role: "ax", status: "done",
      createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
    }),
    /changed while it was being updated/
  );

  const stored = JSON.parse(fake.rows.get("cmd_race").record_json);
  assert.equal(stored.objective, "legacy", "the worker's record was not overwritten");
  assert.equal(stored.status, "working");
  assert.equal(stored.fence, "fence-race-1");
  assert.equal(stored.claimedBy, "nexus-worker-race");
  assert.equal(fake.statements.filter(sql => /json_extract\(record_json, '\$\.fence'\) IS NULL/.test(sql)).length, 1);
});

test("a missing or wrong fence cannot modify a worker-owned task", async () => {
  const { repository, fake } = build();
  const at = new Date().toISOString();
  const row = {
    id: "cmd_owned", objective: "worker", role: "ax", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: [],
    fence: "fence-real", claimedBy: "worker-1"
  };
  await repository.create(row);
  const before = fake.rows.get("cmd_owned").record_json;

  for (const expect of [
    { status: "working", fence: undefined, claimedBy: "worker-1" },
    { status: "working", fence: "wrong", claimedBy: "worker-1" },
    { status: "working", fence: "fence-real", claimedBy: "other-worker" }
  ]) {
    const moved = await repository.transition("cmd_owned", {
      expect,
      next: { ...row, status: "done", result: { summary: "hijack", evidence: ["x"] } }
    });
    assert.equal(moved, null);
    assert.equal(fake.rows.get("cmd_owned").record_json, before);
  }
});

test("concurrent claim and legacy update cannot produce an unfenced overwrite", async () => {
  const { repository, fake } = build();
  const at = new Date().toISOString();
  await repository.create({
    id: "cmd_both", objective: "legacy", role: "ax", status: "queued",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: []
  });

  // Apply the claim exactly where the race window is, then run both a fenced transition for the
  // winner and the legacy update the loser still holds.
  fake.setBeforeUpdate(({ rows }) => {
    const current = JSON.parse(rows.get("cmd_both").record_json);
    const claimed = { ...current, status: "working", fence: "fence-winner", claimedBy: "worker-w", leaseUntil: new Date(Date.now() + 60000).toISOString() };
    rows.set("cmd_both", { record_json: JSON.stringify(claimed), status: "working", updated_at: claimed.updatedAt });
  });
  await assert.rejects(() => repository.update("cmd_both", { ...JSON.parse(fake.rows.get("cmd_both").record_json), status: "done" }));

  const stored = JSON.parse(fake.rows.get("cmd_both").record_json);
  assert.equal(stored.fence, "fence-winner", "the winner's fence survives the losing legacy update");
  assert.equal(stored.claimedBy, "worker-w");
  assert.equal(stored.status, "working");
  assert.notEqual(stored.status, "done");
});

test("two concurrent legacy updates cannot silently overwrite each other", async () => {
  const { repository, fake } = build();
  const at = new Date().toISOString();
  await repository.create({
    id: "cmd_lost", objective: "legacy race", role: "ax", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: [], checkpoints: []
  });
  const before = await repository.get("cmd_lost");

  // Gate the first SELECT after it has read the row, so the second writer commits while the first
  // still holds the stale version. No sleeps: the second writer completes before the gate opens.
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  fake.setAfterSelect(async () => { entered(); await gate; });

  const first = repository.update("cmd_lost", { ...before, checkpoints: [{ note: "writer-1" }] });
  await reading;
  const second = await repository.update("cmd_lost", { ...before, checkpoints: [{ note: "writer-2" }] });
  assert.equal(second.checkpoints[0].note, "writer-2");
  release();

  const results = await Promise.allSettled([first]);
  assert.equal(results[0].status, "rejected", "the stale writer was rejected");
  assert.match(String(results[0].reason?.message), /stale write|changed while it was being updated/);

  const stored = await repository.get("cmd_lost");
  assert.equal(stored.checkpoints[0].note, "writer-2", "the newer record survived");
  assert.notEqual(stored.checkpoints[0].note, "writer-1");
});

test("sequential legacy updates still work", async () => {
  const { repository } = build();
  const at = new Date().toISOString();
  await repository.create({
    id: "cmd_seq", objective: "legacy sequence", role: "ax", status: "working",
    createdAt: at, updatedAt: at, attempts: 0, approvals: [], statusHistory: [], checkpoints: []
  });
  const one = await repository.update("cmd_seq", { ...(await repository.get("cmd_seq")), checkpoints: [{ note: "one" }] });
  const two = await repository.update("cmd_seq", { ...(await repository.get("cmd_seq")), checkpoints: [{ note: "two" }] });
  assert.equal(one.checkpoints[0].note, "one");
  assert.equal(two.checkpoints[0].note, "two");
  assert.equal((await repository.get("cmd_seq")).checkpoints[0].note, "two");
});
