import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createWorkCycle } from "../ax-work-cycle.mjs";
import { createRepositoryEngineeringTransport } from "../ax-agent-transports.mjs";

/**
 * Mission 19 — autonomy gap tests.
 *
 * These cover the three gaps this mission closes without a production change:
 *   1. a stop interrupts an in-flight agent instead of waiting for it to return;
 *   2. revocation is written to the durable audit log and survives a restart;
 *   3. an engineering check is killed when its signal aborts.
 */

const quiet = { log() {}, warn() {}, error() {} };

function plannedObjective(objectives, { text = "Research the README.md evidence", agent = "research" } = {}) {
  return (async () => {
    const created = await objectives.create({
      objective: text,
      requestedBy: "owner",
      criteria: [{ id: "c1", statement: "Repository evidence cites README.md with evidence" }],
      budgetUsd: 0.05
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.objective.id;
    assert.equal((await objectives.understand(id, { summary: text, by: "test" })).ok, true);
    const planned = await objectives.plan(id, {
      steps: [{ objective: text, agent, adapter: null, requiresApproval: false }],
      permissions: [],
      risk: "low",
      by: "test"
    });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    return id;
  })();
}

test("a stop interrupts an in-flight agent and persists no result from it", async () => {
  const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository(), log: quiet });
  const id = await plannedObjective(objectives);

  let started = false;
  let release = null;
  const agents = {
    capabilityMatrix: () => [{ id: "research", available: true }, { id: "memory", available: false }],
    delegateAndReview: async () => {
      started = true;
      return new Promise(resolve => {
        release = () => resolve({ ok: false, envelope: { code: "agent_failed" }, review: { accepted: false, code: "agent_failed" } });
      });
    }
  };
  const cycle = createWorkCycle({ objectives, agents, log: quiet, limits: { retryDelayMs: 1 } });

  const running = cycle.run({ objectiveId: id, by: "test" });
  for (let attempt = 0; attempt < 50 && !started; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started, true, "the agent was actually running");

  const beganAt = Date.now();
  const stop = await cycle.stop({ objectiveId: id, by: "test-operator", reason: "interrupt the agent" });
  assert.equal(stop.ok, true);
  assert.equal(stop.interrupted, true, "a live controller was aborted");

  const report = await Promise.race([
    running,
    new Promise(resolve => setTimeout(() => resolve({ code: "test_timeout" }), 1_000))
  ]);
  const elapsed = Date.now() - beganAt;
  release?.();
  assert.notEqual(report.code, "test_timeout", "the stop returned control instead of awaiting the agent");
  assert.equal(report.code, "work_stopped");
  assert.equal(report.status, "interrupted");
  assert.ok(elapsed < 1_000, "the stop resolved promptly; elapsed=" + elapsed + "ms");

  const stored = await objectives.get(id);
  assert.equal(stored.status, "interrupted");
  assert.equal(stored.evidence.length, 0, "the interrupted agent wrote no evidence");
});

test("revocation is recorded durably and reloaded by a fresh process", async () => {
  const repository = createMemoryObjectiveRepository();
  const objectives = createObjectiveService({ repository, log: quiet });
  const id = await plannedObjective(objectives);

  const events = [{ category: "agent.revoked", seq: 1, createdAt: "2026-11-22T00:00:00.000Z" }];
  let seq = 1;
  const security = {
    available: true,
    record: async entry => {
      seq += 1;
      events.push({ ...entry, seq });
      return { ok: true, event: events[events.length - 1] };
    },
    list: async ({ category }) => ({ ok: true, events: events.filter(event => event.category === category).slice(-1) })
  };
  let calls = 0;
  const agents = {
    capabilityMatrix: () => [{ id: "research", available: true }],
    delegateAndReview: async () => {
      calls += 1;
      return { ok: false, envelope: { code: "agent_failed" }, review: { accepted: false, code: "agent_failed" } };
    }
  };

  // This cycle starts after the durable revocation and must refuse before any agent runs.
  const cycle = createWorkCycle({ objectives, agents, security, log: quiet });
  const refused = await cycle.run({ objectiveId: id, by: "test" });
  assert.equal(refused.code, "agents_revoked");
  assert.equal(calls, 0);

  const restored = await cycle.restore({ by: "test-owner", reason: "resume after investigation" });
  assert.equal(restored.revoked, false);
  assert.equal(restored.durable, true);
  assert.ok(events.some(event => event.category === "agent.restored"));

  // A fresh cycle (a new process) loads the latest audit events: restored wins over the older revoke.
  const restarted = createWorkCycle({ objectives, agents, security, log: quiet });
  await restarted.run({ objectiveId: id, by: "test" });
  assert.ok(calls > 0, "after the durable restore the agent runs again");
});

test("an engineering check is killed when its signal aborts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus19-"));
  try {
    await writeFile(path.join(root, "README.md"), "# evidence\n");
    const transport = createRepositoryEngineeringTransport({
      root,
      inspectPaths: ["README.md"],
      checks: [{ name: "sleep", command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] }],
      timeoutMs: 30_000
    });
    const controller = new AbortController();
    const beganAt = Date.now();
    const running = transport({ objective: "inspect README.md", signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await running;
    const elapsed = Date.now() - beganAt;
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
    assert.equal(result.commands[0].aborted, true);
    assert.ok(elapsed < 5_000, "the child was killed instead of running its 30s timer; elapsed=" + elapsed + "ms");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
