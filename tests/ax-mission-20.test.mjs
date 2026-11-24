import test from "node:test";
import assert from "node:assert/strict";
import { createCostGovernor, createMemoryCostStore } from "../ax-cost-governor.mjs";
import {
  createMissionPlanner,
  createOpenRouterCompletion,
  isFreeModel,
  resolveMissionPlanner,
  validateModelMissionPlan
} from "../ax-mission-planner.mjs";
import {
  createCompositeResearchTransport,
  createWebResearchTransport,
  detectDivergences,
  isPrivateAddress,
  validatePublicUrl
} from "../ax-web-research.mjs";
import { createAgentRuntime } from "../ax-agents.mjs";
import { createWorkCycle } from "../ax-work-cycle.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";

/**
 * Mission 20 — model-backed planning, hard spend limits and secure web research.
 *
 * No real provider or website is contacted. The model transport, DNS resolver and HTTP client are
 * injected, so these tests exercise the production code paths for validation, fallback, cost
 * enforcement and SSRF refusal without spending money or touching the network.
 */

const quiet = { log() {}, warn() {}, error() {} };
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

function response({ status = 200, body = "", type = "text/html", location = null } = {}) {
  return {
    status,
    headers: {
      get: name => (name.toLowerCase() === "content-type" ? type : name.toLowerCase() === "location" ? location : null)
    },
    text: async () => body
  };
}

function html(body, title = "Evidence page") {
  return "<html><head><title>" + title + "</title></head><body>" + body + "</body></html>";
}

// ------------------------------------------------------------------------- cost governor

test("free-only refuses a paid call before it can be made", async () => {
  let calls = 0;
  const governor = createCostGovernor({ freeOnly: true, limits: { taskUsd: 0.02, dailyUsd: 0.05 } });
  const planner = createMissionPlanner({
    complete: async () => { calls += 1; return { ok: true, json: { steps: [{ agent: "research", objective: "Gather evidence from the page" }] }, costUsd: 0.001, free: false }; },
    governor,
    free: false
  });
  const result = await planner.plan({ objective: "Research the evidence", criteria: [], capabilities: { research: true } });
  assert.equal(calls, 0, "no provider call was made");
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "free_only_refused");
  assert.equal(result.plan.provider, "deterministic");
});

test("a task cannot exceed its own ceiling across calls", async () => {
  const governor = createCostGovernor({ freeOnly: true, limits: { taskUsd: 0.01, dailyUsd: 1 } });
  const first = await governor.reserve({ taskId: "task-a", estimateUsd: 0.006, free: true });
  assert.equal(first.ok, true);
  await governor.settle({ taskId: "task-a", estimateUsd: 0.006, costUsd: 0.006 });
  const second = await governor.reserve({ taskId: "task-a", estimateUsd: 0.006, free: true });
  assert.equal(second.ok, false);
  assert.equal(second.code, "task_budget_exceeded");
});

test("the daily ceiling is shared by different tasks and concurrent reservations cannot overdraw it", async () => {
  const governor = createCostGovernor({ freeOnly: true, limits: { taskUsd: 1, dailyUsd: 0.01 } });
  const [a, b] = await Promise.all([
    governor.reserve({ taskId: "one", estimateUsd: 0.006, free: true }),
    governor.reserve({ taskId: "two", estimateUsd: 0.006, free: true })
  ]);
  assert.equal([a, b].filter(result => result.ok).length, 1, "only one reservation fits the day");
  assert.equal([a, b].find(result => !result.ok).code, "daily_budget_exceeded");
  const status = await governor.status();
  assert.ok(status.reservedUsd <= 0.01);
});

test("settlement replaces the reservation with the actual charge and a new day resets the total", async () => {
  let clock = new Date("2026-11-22T10:00:00.000Z");
  const store = createMemoryCostStore();
  const governor = createCostGovernor({ store, now: () => clock, limits: { taskUsd: 0.02, dailyUsd: 0.05 } });
  await governor.reserve({ taskId: "t", estimateUsd: 0.006, free: true });
  const settled = await governor.settle({ taskId: "t", estimateUsd: 0.006, costUsd: 0.0012 });
  assert.equal(settled.ok, true);
  assert.equal(settled.spentUsd, 0.0012);
  assert.equal(settled.reservedUsd, 0);
  clock = new Date("2026-11-23T00:00:01.000Z");
  const next = await governor.status();
  assert.equal(next.spentUsd, 0);
  assert.equal(next.day, "2026-11-23");
});

// ------------------------------------------------------------------------- planner

test("without a model transport the planner returns the deterministic plan and says so", async () => {
  const planner = createMissionPlanner({ complete: null, governor: createCostGovernor() });
  const result = await planner.plan({
    objective: "Research the README.md evidence and inspect the adapter allowlist",
    criteria: [{ statement: "Repository evidence cites README.md" }],
    capabilities: { research: true, security: true, verification: true }
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "model_not_configured");
  assert.equal(result.plan.provider, "deterministic");
  assert.ok(result.plan.steps.length >= 2);
  assert.equal(result.costUsd, 0);
});

test("a valid model plan is accepted, security and verification are appended, and its cost is charged", async () => {
  let seen = null;
  const governor = createCostGovernor({ freeOnly: true, limits: { taskUsd: 0.02, dailyUsd: 0.05 } });
  const planner = createMissionPlanner({
    complete: async input => {
      seen = input;
      return {
        ok: true,
        json: { steps: [{ agent: "research", objective: "Gather citable evidence from the repository README" }] },
        costUsd: 0.0008,
        provider: "fake-free",
        model: "fake-free",
        free: true
      };
    },
    governor,
    free: true,
    provider: "fake-free",
    model: "fake-free"
  });
  const result = await planner.plan({ objective: "Research the evidence", criteria: [], capabilities: { research: true, security: true, verification: true } });
  assert.equal(result.fallback, false);
  assert.equal(result.plan.provider, "fake-free");
  assert.deepEqual(result.plan.steps.map(step => step.agent), ["research", "security", "verification"]);
  assert.equal(result.costUsd, 0.0008);
  assert.equal((await governor.status()).spentUsd, 0.0008);
  assert.match(seen.system, /JSON only/);
});

test("an invalid or forbidden model plan falls back deterministically after bounded retries", async () => {
  let calls = 0;
  const planner = createMissionPlanner({
    complete: async () => {
      calls += 1;
      return { ok: true, json: { steps: [{ agent: "research", objective: "Run a deploy through an adapter", adapter: "deploy.production" }] }, costUsd: 0.0004, free: true };
    },
    governor: createCostGovernor({ freeOnly: true }),
    free: true,
    limits: { retries: 1 }
  });
  const result = await planner.plan({ objective: "Research the evidence", capabilities: { research: true } });
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "adapter_not_allowed");
  assert.equal(calls, 1, "a forbidden plan is not retried");
  assert.equal((await planner.status()).spentUsd, 0.0004, "the failed call was still charged");
});

test("a provider timeout falls back deterministically within the planner deadline", async () => {
  let calls = 0;
  const planner = createMissionPlanner({
    complete: async () => { calls += 1; return new Promise(() => {}); },
    governor: createCostGovernor({ freeOnly: true }),
    free: true,
    limits: { timeoutMs: 20, retries: 1 }
  });
  const began = Date.now();
  const result = await planner.plan({ objective: "Research the evidence" });
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, "planner_timeout");
  assert.equal(calls, 2, "exactly one bounded retry");
  assert.ok(Date.now() - began < 1_000);
});

test("model plan validation rejects unknown agents, adapters, duplicates and oversized plans", () => {
  assert.equal(validateModelMissionPlan({ steps: [{ agent: "intruder", objective: "Do the thing" }] }).code, "unknown_agent");
  assert.equal(validateModelMissionPlan({ steps: [{ agent: "research", objective: "Do the thing", adapter: "shell" }] }).code, "adapter_not_allowed");
  assert.equal(validateModelMissionPlan({ steps: [{ agent: "research", objective: "Do the thing" }, { agent: "research", objective: "Do it again" }] }).code, "duplicate_agent");
  assert.equal(validateModelMissionPlan({ steps: [] }).code, "steps_required");
  assert.equal(validateModelMissionPlan({ steps: Array.from({ length: 7 }, (_, i) => ({ agent: "memory", objective: "Step " + i + " evidence" })) }).code, "too_many_steps");
  const valid = validateModelMissionPlan({ steps: [{ agent: "research", objective: "Gather citable evidence" }] });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.steps.map(step => step.agent), ["research", "security", "verification"]);
});

test("OpenRouter completion refuses a paid model in free-only mode and never exposes the key", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("must not be called"); };
  const paid = createOpenRouterCompletion({ apiKey: "secret-key-value", model: "openrouter/auto", fetchImpl, freeOnly: true });
  const refused = await paid({ system: "s", user: "u", schema: { type: "object" } });
  assert.equal(refused.code, "free_only_refused");
  assert.equal(called, false);

  const free = createOpenRouterCompletion({ apiKey: "secret-key-value", model: "openrouter/free", freeOnly: true, fetchImpl: async (url, options) => {
    assert.equal(url.endsWith("/chat/completions"), true);
    assert.equal(options.headers.authorization, "Bearer secret-key-value");
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"steps\":[]}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  } });
  const result = await free({ system: "s", user: "u", schema: { type: "object" } });
  assert.equal(result.ok, true);
  assert.equal(result.costUsd, 0, "a free model is charged zero");
  assert.equal(JSON.stringify(result).includes("secret-key-value"), false);
  assert.equal(isFreeModel("openrouter/auto"), false);
  assert.equal(isFreeModel("meta/model:free"), true);
});

test("the runtime planner is off by default and refuses a paid model", () => {
  assert.equal(resolveMissionPlanner({}), null);
  assert.equal(resolveMissionPlanner({ NEXUS_MODEL_PLANNING_ENABLED: "true" }), null, "no key means no planner");
  const paid = resolveMissionPlanner({ NEXUS_MODEL_PLANNING_ENABLED: "true", OPENROUTER_API_KEY: "k", NEXUS_PLANNER_MODEL: "openrouter/auto", NEXUS_FREE_ONLY: "true" });
  assert.equal(paid, null, "free-only mode refuses a paid default model");
  const free = resolveMissionPlanner({ NEXUS_MODEL_PLANNING_ENABLED: "true", OPENROUTER_API_KEY: "k", NEXUS_PLANNER_MODEL: "openrouter/free" });
  assert.equal(free?.mode, "model");
  assert.equal(free?.free, true);
});

// ------------------------------------------------------------------------- web research security

test("private, loopback, link-local and reserved addresses are refused", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("URL validation enforces HTTPS, no credentials, standard ports and public DNS answers", async () => {
  assert.equal((await validatePublicUrl("http://example.com/page", { lookup: PUBLIC_LOOKUP })).code, "https_required");
  assert.equal((await validatePublicUrl("https://user:pass@example.com/page", { lookup: PUBLIC_LOOKUP })).code, "url_has_credentials");
  assert.equal((await validatePublicUrl("https://example.com:8443/page", { lookup: PUBLIC_LOOKUP })).code, "port_not_allowed");
  assert.equal((await validatePublicUrl("https://localhost/page", { lookup: PUBLIC_LOOKUP })).code, "private_host");
  assert.equal((await validatePublicUrl("https://metadata.google.internal/page", { lookup: PUBLIC_LOOKUP })).code, "private_host");
  assert.equal((await validatePublicUrl("https://127.0.0.1/page", { lookup: PUBLIC_LOOKUP })).code, "private_address");
  assert.equal((await validatePublicUrl("https://internal.example.test/page", { lookup: async () => [{ address: "10.0.0.5" }] })).code, "private_address");
  assert.equal((await validatePublicUrl("https://example.com/page", { lookup: PUBLIC_LOOKUP })).ok, true);
});

test("a public URL that redirects to a private address is refused", async () => {
  const transport = createWebResearchTransport({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: async () => response({ status: 302, location: "https://169.254.169.254/latest/meta-data" })
  });
  const result = await transport({ objective: "Research https://example.com/start" });
  assert.equal(result.sources.length, 0);
  assert.equal(result.errors[0].code, "private_address");
});

test("redirect chains are bounded", async () => {
  let hops = 0;
  const transport = createWebResearchTransport({
    lookup: PUBLIC_LOOKUP,
    maxRedirects: 2,
    fetchImpl: async () => { hops += 1; return response({ status: 302, location: "https://example.com/next" }); }
  });
  const result = await transport({ objective: "Research https://example.com/start" });
  assert.equal(result.errors[0].code, "too_many_redirects");
  assert.equal(hops, 3, "initial request plus two redirects");
});

test("responses are bounded, attributed and truncated honestly", async () => {
  const page = html("The service is available for read access and the evidence is recorded. ".repeat(40));
  const transport = createWebResearchTransport({
    lookup: PUBLIC_LOOKUP,
    maxBytes: 400,
    fetchImpl: async () => response({ body: page, type: "text/html" })
  });
  const result = await transport({ objective: "Research https://evidence.test/page about service evidence" });
  const source = result.sources[0];
  assert.equal(result.ok, true);
  assert.equal(source.url, "https://evidence.test/page");
  assert.equal(source.title, "Evidence page");
  assert.ok(source.excerpt.length > 0);
  assert.match(source.excerpt, /service/i);
  assert.equal(source.truncated, true);
  assert.ok(source.bytes <= 400);
  assert.match(source.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(source.digest, /^[a-f0-9]{64}$/);
  assert.match(source.uncertainty, /byte limit/i);
});

test("an unsupported content type is refused instead of parsed", async () => {
  const transport = createWebResearchTransport({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: async () => response({ body: "MZ binary", type: "application/octet-stream" })
  });
  const result = await transport({ objective: "Research https://example.com/file" });
  assert.equal(result.sources.length, 0);
  assert.equal(result.errors[0].code, "unsupported_content_type");
});

test("no URL means no web request and no invented evidence", async () => {
  let called = false;
  const transport = createWebResearchTransport({ fetchImpl: async () => { called = true; return response({ body: html("x") }); }, lookup: PUBLIC_LOOKUP });
  const result = await transport({ objective: "Research the adapter allowlist" });
  assert.equal(called, false);
  assert.deepEqual(result.sources, []);
  assert.equal(result.confidence, 0);
  assert.match(result.summary, /No web URL was supplied/);
});

test("conflicting sources are preserved and flagged, never resolved by the transport", async () => {
  const fetchImpl = async url => {
    if (url.includes("a.test")) return response({ body: html("The service is available for all users and the evidence is recorded."), type: "text/html" });
    return response({ body: html("The service is not available for all users and the evidence is missing."), type: "text/html" });
  };
  const transport = createWebResearchTransport({ lookup: PUBLIC_LOOKUP, fetchImpl, maxSources: 2 });
  const result = await transport({ objective: "Research https://a.test/page and https://b.test/page about service availability" });
  assert.equal(result.sources.length, 2);
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].resolved, false);
  assert.deepEqual(result.divergences[0].urls.sort(), ["https://a.test/page", "https://b.test/page"]);
  assert.ok(result.sources.every(source => source.digest && source.retrievedAt));
  assert.equal(detectDivergences(result.sources)[0].signal, "polarity_divergence");
});

test("the composite transport keeps repository and web sources together", async () => {
  const repository = async () => ({
    ok: true,
    summary: "Repository research matched 1 file",
    sources: [{ title: "README.md#L3", url: "repo://README.md#L3", excerpt: "repository evidence", retrievedAt: "2026-11-22T00:00:00.000Z", digest: "a".repeat(64), confidence: 0.4 }],
    confidence: 0.45,
    scanned: 1,
    limitations: ["local only"]
  });
  const web = async () => ({
    ok: true,
    summary: "Fetched 1 web source",
    sources: [{ title: "Page", url: "https://example.com/page", excerpt: "web evidence", retrievedAt: "2026-11-22T00:00:01.000Z", digest: "b".repeat(64), confidence: 0.6 }],
    confidence: 0.6,
    scanned: 1,
    errors: [],
    divergences: [],
    limitations: ["untrusted"]
  });
  const composite = createCompositeResearchTransport({ repository, web });
  const result = await composite({ objective: "Research evidence" });
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources.map(source => source.url), ["repo://README.md#L3", "https://example.com/page"]);
});

// ------------------------------------------------------------------------- end-to-end agent runtime

test("a model-planned mission performs web research, preserves attribution, verifies and writes memory", async () => {
  const page = html("The service is available for read access and the evidence is recorded in this repository.");
  const web = createWebResearchTransport({
    lookup: PUBLIC_LOOKUP,
    fetchImpl: async () => response({ body: page, type: "text/html" })
  });

  const remembered = [];
  const memory = {
    recall: async () => ({ ok: true, entries: [], citations: [], context: null }),
    remember: async input => { remembered.push(input); return { ok: true, key: "run:mission:x", version: 1 }; }
  };
  const governor = createCostGovernor({ freeOnly: true, limits: { taskUsd: 0.02, dailyUsd: 0.05 } });
  const missionPlanner = createMissionPlanner({
    complete: async () => ({
      ok: true,
      json: { steps: [{ agent: "research", objective: "Gather citable evidence from https://evidence.test/page about the service read access" }] },
      costUsd: 0.0005,
      provider: "fake-free",
      model: "fake-free",
      free: true
    }),
    governor,
    free: true,
    provider: "fake-free",
    model: "fake-free"
  });
  const agents = createAgentRuntime({
    dependencies: { research: web, memory, missionPlanner, adapters: [], allowedAdapters: [] },
    log: quiet,
    limits: { maxDelegations: 40, maxWallClockMs: 30_000 }
  });
  const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository(), log: quiet });
  const cycle = createWorkCycle({ objectives, agents, memory, log: quiet, limits: { retryDelayMs: 1 } });

  const created = await objectives.create({
    objective: "Research https://evidence.test/page and record the service evidence",
    requestedBy: "owner",
    criteria: [{ id: "c1", statement: "The service evidence is recorded" }],
    budgetUsd: 0.05
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const report = await cycle.run({ objectiveId: created.objective.id, by: "test" });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.status, "completed");
  assert.equal(report.director.planner.mode, "model");
  assert.equal(report.director.planner.provider, "fake-free");

  const stored = await objectives.get(created.objective.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.plan.provider, "fake-free");
  assert.equal(stored.verification.verified, true);

  const researchEvidence = stored.evidence.filter(item => item.agent === "research");
  assert.ok(researchEvidence.length >= 1);
  assert.equal(researchEvidence[0].url, "https://evidence.test/page");
  assert.match(researchEvidence[0].retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(researchEvidence[0].summary, /https:\/\/evidence\.test\/page/);

  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].sources[0].url, "https://evidence.test/page");
  assert.ok((await governor.status()).spentUsd > 0, "the planning cost was recorded");
});
