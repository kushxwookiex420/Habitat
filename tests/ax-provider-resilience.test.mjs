import test from "node:test";
import assert from "node:assert/strict";
import { createFailoverPlanner, createProviderCircuitBreaker } from "../ax-providers.mjs";

function provider(name, key) {
  return { name, baseUrl: "https://" + name + ".example/v1", model: "model-" + name, apiKey: key, configured: Boolean(key) };
}

function successPayload() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify({ steps: [{ objective: "run the read-only check", adapter: null }] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      };
    }
  };
}

const failure = { ok: false, status: 500, async json() { return {}; } };

test("a transient primary failure falls back and records why", async () => {
  const calls = [];
  const planner = createFailoverPlanner({
    providers: [provider("openai", "key-one"), provider("gemini", "key-two")],
    fetchImpl: async url => {
      calls.push(url);
      return url.includes("openai") ? failure : successPayload();
    }
  });
  const result = await planner.plan({ objective: "check the deployment", adapters: [] });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "gemini");
  assert.equal(result.decision.selected, "gemini");
  assert.equal(result.decision.fallbackOccurred, true);
  const openaiAttempt = result.decision.decisions.find(item => item.provider === "openai" && item.decision === "attempted");
  assert.equal(openaiAttempt.reason, "primary");
  const openaiFallback = result.decision.decisions.find(item => item.provider === "openai" && item.decision === "fallback");
  assert.equal(openaiFallback.reason, "openai_http_500");
  assert.ok(result.costUsd > 0, "both attempts are charged");
  assert.equal(calls.length, 2);
});

test("a malformed plan is not retried against another provider", async () => {
  let calls = 0;
  const planner = createFailoverPlanner({
    providers: [provider("openai", "key-one"), provider("gemini", "key-two")],
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "not json at all" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        }
      };
    }
  });
  const result = await planner.plan({ objective: "check", adapters: [] });
  assert.equal(result.ok, false);
  assert.equal(result.fallbackSkipped, "non_transient");
  assert.equal(calls, 1, "a content problem is not a provider outage");
});

test("the circuit opens after repeated transient failures and is skipped afterwards", async () => {
  let clock = 1_000;
  const breaker = createProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000, now: () => clock });
  const planner = createFailoverPlanner({
    providers: [provider("openai", "key-one"), provider("gemini", "key-two")],
    fetchImpl: async url => (url.includes("openai") ? failure : successPayload()),
    breaker,
    now: () => new Date(clock).toISOString()
  });

  await planner.plan({ objective: "first", adapters: [] });
  await planner.plan({ objective: "second", adapters: [] });
  const snapshot = breaker.snapshot().find(item => item.provider === "openai");
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.failures, 2);

  const third = await planner.plan({ objective: "third", adapters: [] });
  assert.equal(third.ok, true);
  const skipped = third.decision.decisions.find(item => item.provider === "openai");
  assert.equal(skipped.decision, "skipped");
  assert.equal(skipped.reason, "circuit_open");
  assert.equal(breaker.allow("openai"), false);

  // After the cooldown one trial is allowed; success closes the circuit.
  clock += 60_001;
  assert.equal(breaker.allow("openai"), true);
  breaker.record("openai", { ok: true });
  assert.equal(breaker.snapshot().find(item => item.provider === "openai").state, "closed");
});

test("an unconfigured provider is skipped without being charged", async () => {
  const planner = createFailoverPlanner({
    providers: [provider("openai", ""), provider("openrouter", "key-three")],
    fetchImpl: async url => (url.includes("openrouter") ? successPayload() : failure)
  });
  const result = await planner.plan({ objective: "check", adapters: [] });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openrouter");
  const openai = result.decision.decisions.find(item => item.provider === "openai");
  assert.equal(openai.decision, "skipped");
  assert.equal(openai.reason, "unconfigured");
  assert.equal(result.attempts[0].costUsd, 0);
});
