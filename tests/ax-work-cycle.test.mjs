import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createAgentRuntime, selectAgent } from "../ax-agents.mjs";
import { createRepositoryEngineeringTransport, createRepositoryResearchTransport } from "../ax-agent-transports.mjs";
import { createWorkCycle } from "../ax-work-cycle.mjs";
import { createMemoryMessageRepository } from "../d1-ax-message-repository.mjs";
import { createMessageChannel } from "../ax-message-channel.mjs";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";

/**
 * Mission 17 — NEXUS acceptance suite.
 *
 * Real: the durable objective lifecycle (memory repository implementing the same CAS contract as
 * D1), the agent runtime, repository research and engineering transports running actual file reads
 * and `node --check`, the deterministic Director and Verification agents, the work cycle, the
 * message channel state machine, the HTTP routes and their credentials.
 *
 * Simulated: D1 itself (a memory repository stands in) and the phone. No model call is made — the
 * mission plan is deterministic — so no credential and no paid service is involved.
 */

const COMMAND_TOKEN = "axcmd_" + "c".repeat(30);
const BRIDGE_TOKEN = "axbridge_" + "b".repeat(30);
const NEXUS_TOKEN = "axnexus_" + "n".repeat(30);
const quiet = { log() {}, warn() {}, error() {} };

const README = "# NEXUS mission evidence\n\nThe runtime persists objectives and evidence before it reports a verified result.\n";
const MODULE = "export const answer = 42;\n";
const BROKEN = "export const answer = ;\n";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); },
    use() {}
  };
}

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "registered route: " + key);
  const res = recorder();
  const request = { headers: {}, query: {}, params: {}, body: {}, ...req };
  for (const handler of handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

async function harness({
  research = true,
  engineering = true,
  memory = true,
  messages = true,
  inspectPaths = ["module.mjs"],
  checks = [{ name: "syntax", command: process.execPath, args: ["--check", "{file}"], when: "file" }],
  objectiveRepository = null
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nexus17-"));
  await writeFile(path.join(root, "README.md"), README);
  await writeFile(path.join(root, "module.mjs"), MODULE);
  await writeFile(path.join(root, "broken.mjs"), BROKEN);

  const repository = objectiveRepository || createMemoryObjectiveRepository();
  const objectives = createObjectiveService({ repository, log: quiet });
  const calls = { research: 0, engineering: 0 };
  const failState = { engineering: false };
  const hooks = { onResearch: null };
  const remembered = [];
  const memoryContext = {
    recall: async () => ({
      ok: true,
      entries: [{ id: "mem_1", key: "decision:deploy", version: 1, kind: "decision" }],
      citations: [{ key: "decision:deploy", version: 1, source: "owner" }],
      context: "decision:deploy v1: deploy only after the owner approves"
    }),
    remember: async input => {
      remembered.push(input);
      return { ok: true, key: "run:" + input.runId, version: 1 };
    }
  };
  const researchTransport = createRepositoryResearchTransport({ root });
  const engineeringTransport = createRepositoryEngineeringTransport({ root, inspectPaths, checks });

  const dependencies = {
    ...(memory ? { memory: memoryContext } : {}),
    diagnostics: async () => ({
      generatedAt: new Date().toISOString(),
      database: { status: "reachable" },
      memory: { status: memory ? "available" : "unavailable" },
      providers: { enabled: false },
      scheduler: { state: "never_run" },
      sandbox: { status: "available" },
      notifications: { status: "recorded_only" },
      deviceBridge: { status: "not_ready" }
    }),
    ...(research ? {
      research: async input => {
        calls.research += 1;
        if (typeof hooks.onResearch === "function") await hooks.onResearch();
        return researchTransport(input);
      }
    } : {}),
    ...(engineering ? {
      engineering: async input => {
        calls.engineering += 1;
        if (failState.engineering) throw new Error("simulated_worker_crash");
        return engineeringTransport(input);
      }
    } : {})
  };

  const agents = createAgentRuntime({
    dependencies,
    log: quiet,
    limits: { maxDelegations: 40, maxWallClockMs: 60_000 },
    now: () => new Date().toISOString()
  });

  const messageRepository = createMemoryMessageRepository();
  const channel = messages
    ? createMessageChannel({ repository: messageRepository, allowedAdapters: ["runtime.health", "repo.inspect"], log: quiet })
    : null;

  const securityEvents = [];
  const cycle = createWorkCycle({
    objectives,
    agents,
    memory: memory ? memoryContext : null,
    messages: channel,
    security: { record: async entry => { securityEvents.push(entry); } },
    log: quiet,
    limits: { retryDelayMs: 1, maxAttempts: 2 }
  });

  return {
    root,
    repository,
    objectives,
    agents,
    cycle,
    calls,
    failState,
    hooks,
    remembered,
    memoryContext,
    channel,
    messageRepository,
    securityEvents,
    async cleanup() { await rm(root, { recursive: true, force: true }); }
  };
}

async function makeObjective(h, { text, criteria }) {
  const created = await h.objectives.create({
    objective: text,
    requestedBy: "owner",
    criteria,
    budgetUsd: 0.05
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.objective;
}

const RESEARCH_CRITERIA = [
  { id: "c1", statement: "Repository evidence cites README.md with evidence" },
  { id: "c2", statement: "The adapter allowlist was audited" }
];

// -------------------------------------------------------------------- phase 3 and 7

test("1-2-3: an objective is persisted, decomposed by the Director, and research returns cited evidence", async () => {
  const h = await harness();
  try {
    const objective = await makeObjective(h, {
      text: "Research the README.md evidence and inspect module.mjs with an allowlisted syntax check",
      criteria: RESEARCH_CRITERIA
    });
    assert.equal(objective.status, "received");
    assert.equal((await h.objectives.list({ limit: 10 })).length, 1, "the objective is durable before any work runs");

    const report = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(report.ok, true, JSON.stringify(report));

    const stored = await h.objectives.get(objective.id);
    assert.equal(stored.status, "completed");
    assert.deepEqual(stored.plan.steps.map(step => step.agent), ["memory", "research", "engineering", "security", "verification"]);
    assert.deepEqual(report.steps.map(step => step.agent), ["memory", "research", "engineering", "security"]);
    assert.equal(report.director.ok, true);

    const researchEvidence = stored.evidence.filter(item => item.agent === "research");
    assert.ok(researchEvidence.length >= 1);
    assert.ok(researchEvidence.some(item => /README\.md#L\d+/.test(item.summary)), "a real file and line is cited");
    assert.ok(researchEvidence.every(item => item.digest && item.digest.length >= 16), "every research item carries a digest");
    assert.equal(h.calls.research, 1);
  } finally {
    await h.cleanup();
  }
});

test("4: the engineering agent detects a real failing check and proposes a tested correction without writing", async () => {
  const h = await harness({ inspectPaths: ["broken.mjs"] });
  try {
    const objective = await makeObjective(h, {
      text: "Inspect broken.mjs for a syntax bug and report the failing check",
      criteria: [{ id: "c1", statement: "The syntax check evidence is recorded" }]
    });
    const before = await readFile(path.join(h.root, "broken.mjs"), "utf8");
    const report = await h.cycle.run({ objectiveId: objective.id, by: "test" });

    assert.equal(report.ok, false);
    assert.equal(report.code, "engineering_check_failed");
    assert.equal(report.status, "failed");
    const failedStep = report.steps.find(step => step.agent === "engineering");
    assert.equal(failedStep.ok, false);
    assert.equal(failedStep.proposedCorrection.applied, false);
    assert.equal(failedStep.proposedCorrection.requiresApproval, true);
    assert.notEqual(failedStep.proposedCorrection.failingChecks[0].exitCode, 0);
    assert.ok(failedStep.proposedCorrection.failingChecks[0].stderrTail.length > 0);
    assert.equal(await readFile(path.join(h.root, "broken.mjs"), "utf8"), before, "the read-only transport wrote nothing");

    const stored = await h.objectives.get(objective.id);
    assert.equal(stored.status, "failed");
    assert.equal(stored.verification.verified, false);
  } finally {
    await h.cleanup();
  }
});

test("5: an interrupted mission resumes without repeating the work that already produced evidence", async () => {
  const h = await harness();
  try {
    h.failState.engineering = true;
    const objective = await makeObjective(h, {
      text: "Research the README.md evidence and inspect module.mjs",
      criteria: RESEARCH_CRITERIA
    });
    const first = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(first.ok, false);
    assert.equal(first.code, "agent_failed");
    assert.equal(first.status, "interrupted");
    assert.equal(h.calls.research, 1);
    assert.equal(h.calls.engineering, 2, "the retry limit was actually used");

    h.failState.engineering = false;
    const resumed = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));

    assert.equal(resumed.status, "completed");
    assert.equal(h.calls.research, 1, "the completed research step was reused, not repeated");
    assert.ok(
      resumed.steps.some(step => step.agent === "research" && step.code === "already_recorded"),
      JSON.stringify(resumed.steps.map(step => ({ agent: step.agent, status: step.status, code: step.code })))
    );
    assert.equal((await h.objectives.get(objective.id)).recovered >= 1, true);
  } finally {
    await h.cleanup();
  }
});

test("6: a plan that needs an owner is refused before any agent runs", async () => {
  const h = await harness();
  try {
    const objective = await makeObjective(h, {
      text: "Publish the release notes to the public site",
      criteria: [{ id: "c1", statement: "The release notes were published publicly" }]
    });
    await h.objectives.understand(objective.id, { summary: "Publish release notes", by: "test" });
    await h.objectives.plan(objective.id, {
      steps: [{ objective: "Prepare the public copy", agent: "content", adapter: null, requiresApproval: false }],
      permissions: ["publish.external"],
      risk: "low",
      by: "test"
    });
    const report = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(report.ok, false);
    assert.equal(report.code, "permission_requires_owner");
    assert.deepEqual(report.permissions, ["publish.external"]);
    assert.equal(h.agents.delegations(), 0, "no agent was invoked");
    const stored = await h.objectives.get(objective.id);
    assert.equal(stored.evidence.length, 0);
    assert.equal(stored.status, "planned");

    const approvalObjective = await makeObjective(h, {
      text: "Draft a caption and ask before publishing it",
      criteria: [{ id: "c1", statement: "The caption draft exists as evidence" }]
    });
    await h.objectives.understand(approvalObjective.id, { summary: "Draft then ask", by: "test" });
    await h.objectives.plan(approvalObjective.id, {
      steps: [{ objective: "Draft the caption", agent: "content", adapter: null, requiresApproval: true }],
      permissions: [],
      by: "test"
    });
    const gated = await h.cycle.run({ objectiveId: approvalObjective.id, by: "test" });
    assert.equal(gated.code, "approval_required");
    assert.equal((await h.objectives.get(approvalObjective.id)).status, "awaiting_approval");
  } finally {
    await h.cleanup();
  }
});

test("7: results and evidence survive a new service instance over the same durable store", async () => {
  const h = await harness();
  try {
    const objective = await makeObjective(h, {
      text: "Research the README.md evidence and inspect module.mjs",
      criteria: RESEARCH_CRITERIA
    });
    const report = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(report.ok, true);
    const evidenceCount = (await h.objectives.get(objective.id)).evidence.length;
    assert.ok(evidenceCount >= 4);

    // A restart: new service, new agent runtime, new cycle over the same repository.
    const objectives2 = createObjectiveService({ repository: h.repository, log: quiet });
    const agents2 = createAgentRuntime({ dependencies: {}, log: quiet });
    const cycle2 = createWorkCycle({ objectives: objectives2, agents: agents2, log: quiet });
    const reloaded = await objectives2.get(objective.id);
    assert.equal(reloaded.status, "completed");
    assert.equal(reloaded.verification.verified, true);
    assert.equal(reloaded.evidence.length, evidenceCount);
    const second = await cycle2.run({ objectiveId: objective.id, by: "test" });
    assert.equal(second.code, "objective_terminal");
  } finally {
    await h.cleanup();
  }
});

test("8: a mission result is sent through the authenticated Ax bridge, and both surfaces reject a missing token", async () => {
  const h = await harness();
  try {
    const objective = await makeObjective(h, {
      text: "Research the README.md evidence and inspect module.mjs",
      criteria: RESEARCH_CRITERIA
    });
    const report = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(report.ok, true);
    assert.ok(report.correlationId);
    const thread = await h.channel.thread({ correlationId: report.correlationId });
    assert.equal(thread.ok, true);
    assert.ok(thread.messages.some(message => message.kind === "progress"));
    assert.ok(thread.messages.some(message => message.kind === "result" && message.from === "nexus"));

    const app = makeApp();
    registerUniversalCommandRoutes(app, {
      env: {
        HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN,
        HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN,
        AX_NEXUS_TOKEN: NEXUS_TOKEN
      },
      repository: null,
      registry: { summary: () => ({ tools: [] }) },
      objectiveProvider: () => h.objectives,
      workProvider: () => h.cycle,
      messageProvider: () => h.channel
    });

    const unauthorised = await invoke(app, "POST /ax/nexus/messages/notify", { body: { kind: "note", body: "hello" } });
    assert.equal(unauthorised.statusCode, 401);

    const sent = await invoke(app, "POST /ax/nexus/messages/notify", {
      headers: { "x-nexus-token": NEXUS_TOKEN },
      body: { kind: "note", body: "mission result acknowledged by NEXUS" }
    });
    assert.equal(sent.statusCode, 201);
    assert.equal(sent.body.ok, true);

    const missionRoute = await invoke(app, "POST /ax/command/objectives/:id/work", {
      params: { id: objective.id }
    });
    assert.equal(missionRoute.statusCode, 401, "the mission route needs the Ax credential");

    const revokeUnauthorised = await invoke(app, "POST /ax/command/agents/revoke", { body: {} });
    assert.equal(revokeUnauthorised.statusCode, 401);
    const revoked = await invoke(app, "POST /ax/command/agents/revoke", {
      headers: { authorization: "Bearer " + COMMAND_TOKEN },
      body: { reason: "acceptance test revocation" }
    });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.body.revoked, true);

    const fresh = await makeObjective(h, {
      text: "Research the README.md evidence",
      criteria: RESEARCH_CRITERIA
    });
    const afterRevoke = await h.cycle.run({ objectiveId: fresh.id, by: "test" });
    assert.equal(afterRevoke.code, "agents_revoked", "a revoked runtime refuses new work");
  } finally {
    await h.cleanup();
  }
});

test("9: failures are reported as failures, never as completed", async () => {
  const missing = await harness({ research: false });
  try {
    const objective = await makeObjective(missing, {
      text: "Research the README.md evidence and cite sources",
      criteria: RESEARCH_CRITERIA
    });
    const blocked = await missing.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "capability_unavailable");
    assert.deepEqual(blocked.missingCapabilities, ["research"]);
    const stored = await missing.objectives.get(objective.id);
    assert.equal(stored.status, "blocked");
    assert.match(stored.error, /research/);
    assert.equal(stored.evidence.length, 0, "nothing was fabricated when the capability was missing");
  } finally {
    await missing.cleanup();
  }

  const unmet = await harness();
  try {
    const objective = await makeObjective(unmet, {
      text: "Research the README.md evidence",
      criteria: [{ id: "c1", statement: "Quantum entanglement telemetry was measured in a laboratory" }]
    });
    const report = await unmet.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(report.ok, false);
    assert.equal(report.code, "verification_failed");
    assert.equal(report.status, "failed");
    const stored = await unmet.objectives.get(objective.id);
    assert.equal(stored.status, "failed");
    assert.equal(stored.verification.verified, false);
    assert.deepEqual(stored.verification.unmet, ["c1"]);
  } finally {
    await unmet.cleanup();
  }
});

test("10: a multi-agent objective reaches a verified completion with memory, audit and a result message", async () => {
  const h = await harness();
  try {
    const objective = await makeObjective(h, {
      text: "Research the README.md evidence and inspect module.mjs with an allowlisted syntax check",
      criteria: RESEARCH_CRITERIA
    });
    const report = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.status, "completed");

    const stored = await h.objectives.get(objective.id);
    assert.equal(stored.status, "completed");
    assert.equal(stored.verification.verified, true);
    assert.deepEqual(stored.verification.unmet || [], []);
    assert.ok(stored.criteria.every(item => item.met === true));
    assert.ok(stored.evidence.length >= 4);
    assert.ok(stored.plan.steps.filter(step => step.agent !== "verification").every(step => step.agent));

    assert.equal(h.remembered.length, 1);
    assert.match(h.remembered[0].runId, /^mission:obj_/);
    assert.equal(report.memory.written, true);
    assert.equal(report.verificationAgent.passed, true);
    assert.ok(h.securityEvents.length === 0, "no permission violation was raised by an allowed mission");
    assert.equal(report.message.kind, "result");
  } finally {
    await h.cleanup();
  }
});

test("11: an operator stop halts the mission between steps and a later run resumes it", async () => {
  const h = await harness();
  try {
    let objectiveId = null;
    h.hooks.onResearch = async () => {
      await h.cycle.stop({ objectiveId, by: "test-operator", reason: "stop after research" });
    };
    const objective = await makeObjective(h, {
      text: "Research the README.md evidence and inspect module.mjs",
      criteria: RESEARCH_CRITERIA
    });
    objectiveId = objective.id;

    const stopped = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.code, "work_stopped");
    assert.equal(stopped.status, "interrupted");
    assert.equal(h.calls.engineering, 0, "the step after the stop never ran");
    assert.ok(h.securityEvents.some(entry => entry.category === "work.stop_requested"));

    // Mission 19: the stop now interrupts the in-flight agent. Its unfinished result is discarded,
    // so there is no research evidence to reuse and the resumed run performs the step again.
    const interrupted = await h.objectives.get(objective.id);
    assert.equal(
      interrupted.evidence.filter(item => item.agent === "research").length,
      0,
      "the interrupted agent's result is never persisted (an earlier memory step may remain)"
    );

    h.hooks.onResearch = null;
    const resumed = await h.cycle.run({ objectiveId: objective.id, by: "test" });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.status, "completed");
    assert.equal(h.calls.research, 2, "the interrupted research step ran again instead of reusing a discarded result");
  } finally {
    await h.cleanup();
  }
});

test("director and verification are assigned by role only, never auto-routed", () => {
  assert.notEqual(selectAgent("Verify the evidence and plan the work").agent, "verification");
  assert.notEqual(selectAgent("Plan the mission and coordinate the agents").agent, "director");
  assert.equal(selectAgent("Audit token permissions for a security issue").agent, "security");
});
