import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRuntime, selectAgent, AGENT_IDS, AGENT_MANIFESTS } from "../ax-agents.mjs";

function runtime(overrides = {}, limits = {}) {
  return createAgentRuntime({ dependencies: overrides, limits, now: () => "2026-11-22T00:00:00.000Z" });
}

test("routing sends distinct objectives to distinct specialists", () => {
  assert.equal(selectAgent("Research the competitor pricing and cite sources").agent, "research");
  assert.equal(selectAgent("Fix the failing Kotlin build and run the tests").agent, "engineering");
  assert.equal(selectAgent("Audit token permissions for a security issue").agent, "security");
  assert.equal(selectAgent("Check queue health and the scheduler heartbeat").agent, "operations");
  assert.equal(selectAgent("Recall the decision history for this project").agent, "memory");
  assert.equal(selectAgent("Prepare a DropPilot listing caption").agent, "content");
  assert.equal(selectAgent("Check the phone bridge battery and pairing").agent, "device");
  assert.equal(selectAgent("Do the thing").agent, "operations", "no specialist keyword falls back to a safe probe");
  for (const id of AGENT_IDS) {
    assert.ok(AGENT_MANIFESTS[id].permissions.length > 0, id + " must declare permissions");
    assert.ok(AGENT_MANIFESTS[id].forbidden.length > 0, id + " must declare forbidden actions");
  }
});

test("an agent without its dependency reports capability_unavailable instead of inventing a result", async () => {
  const agents = runtime();
  const research = await agents.delegate({ objective: "Research the current Render pricing", role: "research" });
  assert.equal(research.ok, false);
  assert.equal(research.code, "capability_unavailable");
  assert.equal(research.missingCapability, "research");
  assert.deepEqual(research.evidence, []);
  assert.equal(agents.review(research).accepted, false);
});

test("security audits the real allowlist and reports severity-ranked findings", async () => {
  const agents = runtime({
    adapters: ["repo.read", "repo.test"],
    allowedAdapters: ["repo.read"]
  });
  const outcome = await agents.delegate({ objective: "Audit adapters for a security problem", role: "security" });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.evidence.length >= 2);
  assert.equal(outcome.findings[0].severity, "high");
  assert.match(outcome.summary, /outside the allowlist/);
  const review = agents.review(outcome);
  assert.equal(review.accepted, true);
  assert.equal(review.evidenceCount, outcome.evidence.length);

  const clean = runtime({ adapters: ["repo.read"], allowedAdapters: ["repo.read"] });
  const cleanOutcome = await clean.delegate({ objective: "Audit adapters for a security problem", role: "security" });
  assert.equal(cleanOutcome.findings.length, 0);
  assert.match(cleanOutcome.summary, /No allowlist violation/);
});

test("operations probes the mounted diagnostics and names degraded sections", async () => {
  const agents = runtime({
    diagnostics: async () => ({
      generatedAt: "2026-11-22T00:00:00.000Z",
      database: { status: "reachable" },
      memory: { status: "unavailable" },
      providers: { enabled: true },
      scheduler: { state: "started" },
      sandbox: { status: "available" },
      notifications: { status: "recorded_only" },
      deviceBridge: { status: "not_ready" }
    })
  });
  const outcome = await agents.delegate({ objective: "Check service health and the queue", role: "operations" });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.degraded.some(line => line.includes("memory=unavailable")));
  assert.ok(outcome.evidence[0].summary.includes("diagnostics"));
});

test("memory and device agents use their real dependencies and return provenance", async () => {
  const memory = runtime({
    memory: {
      recall: async () => ({
        ok: true,
        citations: [{ key: "decision:deploy", version: 2, source: "owner" }]
      })
    }
  });
  const recalled = await memory.delegate({ objective: "Recall the accepted memory about deployment", role: "memory" });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.citations.length, 1);
  assert.ok(recalled.evidence[0].summary.includes("decision:deploy"));

  const device = runtime({
    device: {
      state: async () => ({ registered: true, authenticated: true, reachable: true })
    }
  });
  const phone = await device.delegate({ objective: "Report the phone device state", role: "device" });
  assert.equal(phone.ok, true);
  assert.match(phone.summary, /registered=true/);
});

test("content is draft-only and always declares that publishing needs approval", async () => {
  const agents = runtime();
  const outcome = await agents.delegate({ objective: "Prepare a Vice City Files script draft", role: "content" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.requiresApproval, true);
  assert.equal(outcome.draft.publishRequiresApproval, true);
  const review = agents.review(outcome);
  assert.equal(review.accepted, true);
  assert.equal(review.requiresApproval, true);
});

test("Ax review rejects a tampered envelope and a result with no evidence", () => {
  const agents = runtime();
  const tampered = {
    agent: "security",
    ok: true,
    objective: "audit",
    confidence: 0.9,
    evidence: [{ id: "x", summary: "claim" }],
    digest: "not-the-real-digest"
  };
  assert.equal(agents.review(tampered).code, "envelope_digest_mismatch");
  const empty = { ...tampered, digest: "" };
  assert.equal(agents.review(empty).accepted, false);
});

test("depth, cycles and delegation budgets stop runaway chains", async () => {
  const agents = runtime({}, { maxDepth: 2, maxDelegations: 2 });
  const deep = await agents.delegate({ objective: "Research something at depth", role: "research", depth: 3 });
  assert.equal(deep.code, "delegation_depth_exceeded");

  const circular = await agents.delegate({
    objective: "Research something in a cycle",
    role: "research",
    chain: ["operations", "research"]
  });
  assert.equal(circular.code, "circular_delegation");
  assert.deepEqual(circular.chain, ["operations", "research", "research"]);

  const one = await agents.delegate({ objective: "Security audit one", role: "security" });
  const two = await agents.delegate({ objective: "Security audit two", role: "security" });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  const three = await agents.delegate({ objective: "Security audit three", role: "security" });
  assert.equal(three.code, "delegation_budget_exhausted");
  assert.equal(agents.delegations(), 3);
});

test("the capability matrix distinguishes implemented from available", () => {
  const agents = runtime({ memory: { recall: async () => ({ ok: true, citations: [] }) } });
  const matrix = agents.capabilityMatrix();
  assert.equal(matrix.length, AGENT_IDS.length);
  for (const entry of matrix) {
    assert.equal(entry.implemented, true);
    assert.equal(typeof entry.available, "boolean");
  }
  const memory = matrix.find(entry => entry.id === "memory");
  assert.equal(memory.available, true);
  const research = matrix.find(entry => entry.id === "research");
  assert.equal(research.available, false);
  assert.equal(research.missingCapability, "research");
});
