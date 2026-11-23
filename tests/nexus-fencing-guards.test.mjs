import test from "node:test";
import assert from "node:assert/strict";
import { createUniversalCommandEngine } from "../universal-command-engine.mjs";

function repository() {
  const rows = new Map();
  return {
    rows,
    async get(id) { const row = rows.get(id); return row ? structuredClone(row) : null; },
    async create(task) { rows.set(task.id, structuredClone(task)); return structuredClone(task); },
    async update(id, task) { rows.set(id, structuredClone({ ...task, id })); return structuredClone({ ...task, id }); },
    async list() { return [...rows.values()].map(row => structuredClone(row)); }
  };
}

const registry = {
  get(name) { return name === "system.health" ? { name, roles: ["ax"], availability: { state: "available", detail: "local" } } : null; },
  approvalRequiredFor() { return { required: false, known: true }; },
  summary() { return { ok: true, count: 1, tools: [] }; }
};

function fenced(id = "cmd_fenced") {
  const at = new Date().toISOString();
  return {
    id, objective: "worker owned", role: "ax", status: "working", createdAt: at, updatedAt: at,
    attempts: 0, approvals: [], statusHistory: [], plan: [], checkpoints: [],
    fence: "fence-live", claimedBy: "nexus-worker-1", leaseUntil: new Date(Date.now() + 60000).toISOString(),
    result: null, error: null
  };
}

test("the legacy completion path cannot overwrite a live fenced task", async () => {
  const store = repository();
  store.rows.set("cmd_fenced", fenced());
  const engine = createUniversalCommandEngine({ repository: store, registry });
  const outcome = await engine.complete({ taskId: "cmd_fenced", verifiedBy: "ax", result: { summary: "manual close", evidence: ["x"] } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "claim_required");
  const stored = store.rows.get("cmd_fenced");
  assert.equal(stored.status, "working");
  assert.equal(stored.result, null);
  assert.equal(stored.fence, "fence-live");
});

test("the legacy failure path cannot overwrite a live fenced task", async () => {
  const store = repository();
  store.rows.set("cmd_fenced", fenced());
  const engine = createUniversalCommandEngine({ repository: store, registry });
  const outcome = await engine.fail({ taskId: "cmd_fenced", error: "manual fail" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "claim_required");
  const stored = store.rows.get("cmd_fenced");
  assert.equal(stored.status, "working");
  assert.equal(stored.error, null);
});

test("a malformed claim is rejected before any write", async () => {
  const store = repository();
  store.rows.set("cmd_fenced", fenced());
  const engine = createUniversalCommandEngine({ repository: store, registry });
  const outcome = await engine.complete({
    taskId: "cmd_fenced", verifiedBy: "nexus-worker-1",
    claim: { fence: "fence-live" },
    result: { summary: "no worker id", evidence: ["x"] }
  });
  assert.equal(outcome.code, "invalid_claim");
  assert.equal(store.rows.get("cmd_fenced").status, "working");
});

test("legacy unfenced tasks can still be closed manually", async () => {
  const store = repository();
  const at = new Date().toISOString();
  store.rows.set("cmd_legacy", {
    id: "cmd_legacy", objective: "legacy", role: "ax", status: "working", createdAt: at, updatedAt: at,
    attempts: 0, approvals: [], statusHistory: [], result: null, error: null
  });
  const engine = createUniversalCommandEngine({ repository: store, registry });
  const outcome = await engine.complete({ taskId: "cmd_legacy", verifiedBy: "owner", result: { summary: "closed", evidence: ["note"] } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.task.status, "done");
});

test("retry of a failed task without a fence clears stale ownership fields", async () => {
  const store = repository();
  const row = fenced("cmd_failed");
  row.status = "failed";
  row.error = "boom";
  delete row.fence;
  store.rows.set("cmd_failed", row);
  const engine = createUniversalCommandEngine({ repository: store, registry });
  const outcome = await engine.retry({ taskId: "cmd_failed", by: "owner" });
  assert.equal(outcome.ok, true);
  const stored = store.rows.get("cmd_failed");
  assert.equal(stored.status, "queued");
  assert.equal("fence" in stored, false);
  assert.equal("claimedBy" in stored, false);
  assert.equal("leaseUntil" in stored, false);
});

test("in-process plan, checkpoint, approval and decision paths cannot disturb a fenced task", async () => {
  const store = repository();
  store.rows.set("cmd_fenced", fenced());
  const engine = createUniversalCommandEngine({ repository: store, registry });
  const attempts = [
    engine.plan({ taskId: "cmd_fenced", steps: [{ step: "hijack", role: "ax" }] }),
    engine.checkpoint({ taskId: "cmd_fenced", note: "hijack" }),
    engine.requestApproval({ taskId: "cmd_fenced", reason: "hijack" }),
    engine.approve({ taskId: "cmd_fenced", by: "owner" }),
    engine.deny({ taskId: "cmd_fenced", by: "owner" })
  ];
  for (const outcome of await Promise.all(attempts)) {
    assert.equal(outcome.ok, false);
    assert.ok(["claim_required", "invalid_transition"].includes(outcome.code), "unexpected code " + outcome.code);
  }
  const stored = store.rows.get("cmd_fenced");
  assert.equal(stored.status, "working");
  assert.equal(stored.fence, "fence-live");
  assert.equal(stored.plan.length, 0);
  assert.equal(stored.checkpoints.length, 0);
  assert.equal(stored.approvals.length, 0);
});

test("a fenced failed task cannot be requeued out from under its worker", async () => {
  const store = repository();
  const row = fenced("cmd_fenced_failed");
  row.status = "failed";
  row.error = "boom";
  store.rows.set("cmd_fenced_failed", row);
  const engine = createUniversalCommandEngine({ repository: store, registry });
  const outcome = await engine.retry({ taskId: "cmd_fenced_failed", by: "owner" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "claim_required");
  assert.equal(store.rows.get("cmd_fenced_failed").status, "failed");
});
