import test from "node:test";
import assert from "node:assert/strict";
import { createNexusWorker } from "../nexus-runtime.mjs";

/**
 * Worker-level proof that a terminal failure reaches the escalation sink exactly once, and that the
 * escalation can never change the recorded task outcome.
 */

function harness({ failOutcome = { ok: true }, escalate = null, adapter = async () => ({ ok: false, error: "synthetic adapter failure" }) } = {}) {
  const state = {
    task: {
      id: "cmd_worker_1",
      status: "working",
      claimedBy: "w-test",
      fence: "fence-test",
      attempts: 2,
      objective: "Reconcile the staging queue",
      adapter: "fake.readonly"
    },
    failures: [],
    escalations: []
  };
  const repository = {
    async get(id) { return id === state.task.id ? structuredClone(state.task) : null; }
  };
  const engine = {
    async fail({ taskId, error, by, claim }) {
      state.failures.push({ taskId, error, by, claim });
      if (failOutcome.ok === false) return failOutcome;
      return { ok: true, task: { ...state.task, status: "failed", error } };
    }
  };
  const worker = createNexusWorker({
    repository,
    engine,
    query: async () => [],
    adapters: { "fake.readonly": adapter },
    workerId: "w-test",
    escalate: escalate ? async (event) => { state.escalations.push(event); return escalate(event); } : null,
    log: { log() {}, warn() {} }
  });
  return { worker, state };
}

test("a terminal adapter failure is escalated once, with the task id, reason, retries and time", async () => {
  const { worker, state } = harness({ escalate: async () => ({ ok: true, delivered: true }) });

  const result = await worker.execute(structuredClone(state.task));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(state.failures.length, 1, "the task was still failed in the engine");
  assert.equal(state.escalations.length, 1);
  const event = state.escalations[0];
  assert.equal(event.taskId, "cmd_worker_1");
  assert.equal(event.objective, "Reconcile the staging queue");
  assert.match(event.error, /synthetic adapter failure/);
  assert.equal(event.attempts, 2, "the recorded retry count travels with the escalation");
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(event.status, "failed");
});

test("an escalation failure does not change the task outcome or throw", async () => {
  const { worker, state } = harness({ escalate: async () => ({ ok: false, code: "message_store_unavailable", delivered: false }) });

  const result = await worker.execute(structuredClone(state.task));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(state.failures.length, 1, "the failure is recorded regardless of the sink");
});

test("an escalator that throws is contained", async () => {
  const { worker, state } = harness({ escalate: async () => { throw new Error("sink exploded"); } });

  const result = await worker.execute(structuredClone(state.task));

  assert.equal(result.reason, "failed");
  assert.equal(state.failures.length, 1);
});

test("no escalation when the engine refuses the failure transition", async () => {
  const { worker, state } = harness({
    // Not a stale claim (that has its own path); a refused transition means nothing was recorded,
    // so there is nothing to announce.
    failOutcome: { ok: false, code: "invalid_transition" },
    escalate: async () => ({ ok: true, delivered: true })
  });

  const result = await worker.execute(structuredClone(state.task));

  assert.equal(result.reason, "failed");
  assert.equal(state.escalations.length, 0, "a failure that was not recorded is not announced");
});

test("a stale claim is neither failed nor escalated", async () => {
  const { worker, state } = harness({ escalate: async () => ({ ok: true, delivered: true }) });
  state.task.claimedBy = "someone-else";

  const result = await worker.execute(structuredClone(state.task));

  assert.equal(result.reason, "stale_claim");
  assert.equal(state.failures.length, 0);
  assert.equal(state.escalations.length, 0);
});

test("an unavailable adapter is a real failure and is escalated", async () => {
  const { worker, state } = harness({
    adapter: async () => ({ ok: true, summary: "Staging queue reconciled", evidence: ["queue-empty:verified"] }),
    escalate: async () => ({ ok: true, delivered: true })
  });
  // completion needs a real engine; assert only that escalation is not reached on the failure path.
  state.task.adapter = "missing.adapter";
  const result = await worker.execute(structuredClone(state.task));
  assert.equal(result.reason, "failed");
  assert.equal(state.escalations.length, 1, "only the failure path escalates");
});
