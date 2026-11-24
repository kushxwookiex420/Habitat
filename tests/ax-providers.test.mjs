import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_NAMES,
  createAxPlannerFromProviderConfig,
  createFailoverPlanner,
  createProviderPlanner,
  describeProviderStatus,
  extractJson,
  resolveAxProviderConfig,
  shouldFallback,
  validatePlan
} from "../ax-providers.mjs";

/**
 * Provider abstraction, with the transport mocked and everything else real.
 *
 * The mock is a fake HTTP endpoint, not a fake provider integration: request construction, the
 * planner contract, failover, cost accounting and refusal behaviour are the production code paths.
 * No provider account is contacted.
 */

const KEY = "sk-mock-" + "p".repeat(24);
const PRICES = { inputPerMTok: 1, outputPerMTok: 2 };

function reply(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function planReply(steps, usage = { prompt_tokens: 1000, completion_tokens: 1000 }) {
  const payload = { choices: [{ message: { content: JSON.stringify({ steps }) } }] };
  if (usage) payload.usage = usage;
  return reply(payload);
}

function provider(name, extra = {}) {
  const baseUrl = name === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai" : "https://" + name + ".test/v1";
  return { name, apiKey: KEY, model: name + "-model", baseUrl, configured: true, ...extra };
}

function planner(name = "openai", options = {}) {
  return createProviderPlanner(provider(name), { prices: PRICES, maxSteps: 4, fetchImpl: options.fetchImpl, ...options });
}

test("configuration defaults to OpenAI and stays disabled until both the gate and a key exist", () => {
  const off = resolveAxProviderConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.code, "provider_unconfigured");
  assert.match(off.error, /OPENAI_API_KEY/);

  const gated = resolveAxProviderConfig({ OPENAI_API_KEY: KEY });
  assert.equal(gated.enabled, false);
  assert.equal(gated.code, "orchestrator_disabled");

  const on = resolveAxProviderConfig({ OPENAI_API_KEY: KEY, AX_ORCHESTRATOR_ENABLED: "true" });
  assert.equal(on.enabled, true);
  assert.equal(on.primary.name, "openai");
  assert.equal(on.primary.model, "gpt-6-luna");
});

test("the status summary never contains a credential", () => {
  const config = resolveAxProviderConfig({
    OPENAI_API_KEY: KEY,
    GEMINI_API_KEY: "gemini-key-value",
    AX_PROVIDER: "openai",
    AX_PROVIDER_FALLBACKS: "gemini",
    AX_ORCHESTRATOR_ENABLED: "true"
  });
  const serialized = JSON.stringify(describeProviderStatus(config)) + JSON.stringify(config.summary);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes("gemini-key-value"), false);
  assert.equal(describeProviderStatus(config).fallbacks.length, 1);
});

test("an unknown AX_PROVIDER is refused instead of silently becoming OpenAI", () => {
  const config = resolveAxProviderConfig({ AX_PROVIDER: "openaii", OPENAI_API_KEY: KEY, AX_ORCHESTRATOR_ENABLED: "true" });
  assert.equal(config.enabled, false);
  assert.equal(config.code, "unknown_provider");
  assert.equal(config.primary, null);
  assert.match(config.error, /openaii/);
});

test("each provider reads its own key variable and default endpoint", () => {
  const gemini = resolveAxProviderConfig({ GEMINI_API_KEY: "g", AX_PROVIDER: "gemini", AX_ORCHESTRATOR_ENABLED: "true" });
  assert.equal(gemini.enabled, true);
  assert.match(gemini.primary.baseUrl, /generativelanguage\.googleapis\.com/);
  assert.equal(gemini.primary.model, "gemini-2.5-flash");

  const openrouter = resolveAxProviderConfig({ OPENROUTER_API_KEY: "r", AX_PROVIDER: "openrouter", AX_ORCHESTRATOR_ENABLED: "true" });
  assert.equal(openrouter.enabled, true);
  assert.match(openrouter.primary.baseUrl, /openrouter\.ai/);

  assert.ok(PROVIDER_NAMES.includes("gemini"));
  assert.ok(PROVIDER_NAMES.includes("openrouter"));
});

test("the fallback chain is ordered, de-duplicated and excludes the primary", () => {
  const config = resolveAxProviderConfig({
    OPENAI_API_KEY: KEY,
    AX_ORCHESTRATOR_ENABLED: "true",
    AX_PROVIDER: "openai",
    AX_PROVIDER_FALLBACKS: "gemini, openai, openrouter, gemini, nope"
  });
  assert.deepEqual(config.fallbacks.map(entry => entry.name), ["gemini", "openrouter"]);
});

test("OpenAI uses a strict JSON schema response and max_completion_tokens", async () => {
  const requests = [];
  const model = planner("openai", {
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return planReply([{ objective: "inspect the repository", adapter: "repo.inspect" }]);
    }
  });
  const result = await model.plan({ objective: "look at the repo", adapters: ["repo.inspect"] });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai");
  assert.equal(requests[0].url, "https://openai.test/v1/chat/completions");
  assert.equal(requests[0].body.response_format.type, "json_schema");
  assert.equal(requests[0].body.max_completion_tokens, 700);
  assert.equal(requests[0].body.messages[0].role, "system");
});

test("Gemini and OpenRouter use max_tokens with JSON-object mode", async () => {
  for (const name of ["gemini", "openrouter"]) {
    const requests = [];
    const model = planner(name, {
      fetchImpl: async (url, init) => {
        requests.push({ url, init, body: JSON.parse(init.body) });
        return planReply([{ objective: "inspect the repository", adapter: "repo.inspect" }]);
      }
    });
    const result = await model.plan({ objective: "look", adapters: ["repo.inspect"] });
    assert.equal(result.ok, true, name);
    assert.equal(requests[0].body.max_tokens, 700);
    assert.equal(requests[0].body.response_format.type, "json_object");
    assert.equal(requests[0].body.max_completion_tokens, undefined);
    assert.equal(requests[0].body.reasoning_effort, undefined);
  }
});

test("the credential travels in the header and never appears in a result", async () => {
  let seen = null;
  const model = planner("openai", {
    fetchImpl: async (_url, init) => {
      seen = init.headers.authorization;
      return reply({ error: { message: "invalid key " + KEY } }, 401);
    }
  });
  const result = await model.plan({ objective: "x", adapters: [] });
  assert.equal(seen, "Bearer " + KEY);
  assert.equal(result.ok, false);
  assert.equal(result.code, "openai_http_401");
  assert.equal(JSON.stringify(result).includes(KEY), false, "an upstream error body must not be echoed");
});

test("a timeout is typed, charged, and does not throw", async () => {
  const model = planner("openai", {
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
  });
  const result = await model.plan({ objective: "x", adapters: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "openai_timeout");
  assert.ok(result.costUsd > 0, "a failed call must still be charged");
  assert.equal(result.estimated, true);
});

test("a transport error is typed, not thrown", async () => {
  const model = planner("openai", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  });
  const result = await model.plan({ objective: "x", adapters: [] });
  assert.equal(result.code, "openai_transport_error");
});

test("empty, non-JSON and structurally invalid completions are refused with distinct codes", async () => {
  const cases = [
    [reply({ choices: [{ message: { content: "   " } }] }), "openai_empty_completion"],
    [reply({ choices: [{ message: { content: "not json at all" } }] }), "openai_invalid_json"],
    [reply({ choices: [{ message: { content: JSON.stringify({ nothing: true }) } }] }), "openai_invalid_plan"],
    [reply({ choices: [{ message: { content: JSON.stringify({ steps: [] }) } }] }), "openai_invalid_plan"]
  ];
  for (const [payload, code] of cases) {
    const model = planner("openai", { fetchImpl: async () => payload });
    const result = await model.plan({ objective: "x", adapters: ["repo.inspect"] });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
});

test("a model cannot name an adapter the worker does not have", async () => {
  const model = planner("openai", {
    fetchImpl: async () => planReply([{ objective: "delete the database", adapter: "repo.destroy" }])
  });
  const result = await model.plan({ objective: "x", adapters: ["repo.inspect"] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "openai_invalid_plan");
  assert.equal(result.detail, "adapter_not_allowed");
  assert.equal(result.plan, undefined);
});

test("a plan may legitimately use no adapter", async () => {
  const model = planner("openai", {
    fetchImpl: async () => planReply([{ objective: "summarise what is known", adapter: null }])
  });
  const result = await model.plan({ objective: "explain", adapters: ["repo.inspect"] });
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0].adapter, null);
});

test("usage is priced, and a reply without usage is charged the failure estimate", async () => {
  const priced = planner("openai", { fetchImpl: async () => planReply([{ objective: "a", adapter: null }]) });
  const result = await priced.plan({ objective: "x", adapters: [] });
  assert.equal(result.costUsd, 0.003); // 1000 input @1/M + 1000 output @2/M
  assert.equal(result.estimated, false);

  const noUsage = planner("openai", {
    failedCallCostUsd: 0.02,
    fetchImpl: async () => planReply([{ objective: "a", adapter: null }], null)
  });
  const cheap = await noUsage.plan({ objective: "x", adapters: [] });
  assert.equal(cheap.costUsd, 0.02);
  assert.equal(cheap.estimated, true);
});

test("failover moves to the next provider only on a transient failure, summing spend", async () => {
  const calls = [];
  const fallover = createFailoverPlanner({
    providers: [provider("openai"), provider("gemini")],
    prices: PRICES,
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes("openai.test")) return reply({ error: "overloaded" }, 503);
      return planReply([{ objective: "inspect", adapter: "repo.inspect" }]);
    }
  });
  const result = await fallover.plan({ objective: "x", adapters: ["repo.inspect"] });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "gemini");
  assert.equal(calls.length, 2);
  assert.deepEqual(result.attempts.map(attempt => attempt.provider), ["openai", "gemini"]);
  assert.ok(result.costUsd > 0.003, "the failed primary attempt must still count");
});

test("a non-transient failure does not spend a second provider's credits", async () => {
  const calls = [];
  const fallover = createFailoverPlanner({
    providers: [provider("openai"), provider("gemini")],
    prices: PRICES,
    fetchImpl: async url => {
      calls.push(url);
      return planReply([{ objective: "invent", adapter: "repo.destroy" }]);
    }
  });
  const result = await fallover.plan({ objective: "x", adapters: ["repo.inspect"] });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1, "a bad plan is a content problem, not a provider outage");
  assert.equal(result.fallbackSkipped, "non_transient");
  assert.equal(result.detail, "adapter_not_allowed");
});

test("exhausting every provider is a typed failure with the total cost", async () => {
  const fallover = createFailoverPlanner({
    providers: [provider("openai"), provider("gemini")],
    prices: PRICES,
    failedCallCostUsd: 0.01,
    fetchImpl: async () => reply({ error: "down" }, 500)
  });
  const result = await fallover.plan({ objective: "x", adapters: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "providers_exhausted");
  assert.equal(result.attempts.length, 2);
  assert.equal(Number(result.costUsd.toFixed(2)), 0.02);
});

test("an unconfigured provider is skipped without a request", async () => {
  let calls = 0;
  const fallover = createFailoverPlanner({
    providers: [provider("openai", { apiKey: "", configured: false }), provider("gemini")],
    prices: PRICES,
    fetchImpl: async () => {
      calls += 1;
      return planReply([{ objective: "a", adapter: null }]);
    }
  });
  const result = await fallover.plan({ objective: "x", adapters: [] });
  assert.equal(calls, 1);
  assert.equal(result.provider, "gemini");
  assert.equal(result.attempts[0].code, "openai_unconfigured");
});

test("a disabled configuration yields a planner that refuses without spending", async () => {
  const config = resolveAxProviderConfig({});
  const model = createAxPlannerFromProviderConfig(config, {});
  const result = await model.plan({ objective: "x", adapters: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "provider_unconfigured");
  assert.equal(result.costUsd, 0);

  const correction = await model.correct({ objective: "x", failedObjective: "y", failure: "z", adapters: [] });
  assert.equal(correction.ok, false);
});

test("extractJson tolerates fenced and prefixed JSON but not garbage", () => {
  assert.deepEqual(extractJson('```json\n{"steps":[]}\n```'), { steps: [] });
  assert.deepEqual(extractJson('Here you go: {"steps":[]} thanks'), { steps: [] });
  assert.equal(extractJson("no object here"), null);
  // A non-object that happens to be valid JSON parses; the plan validator rejects it afterwards.
  assert.deepEqual(extractJson("[1,2,3]"), [1, 2, 3]);
});

test("validatePlan enforces shape and the step ceiling", () => {
  assert.equal(validatePlan({ steps: [{ objective: "a", adapter: null }] }), null);
  assert.equal(validatePlan({ steps: [] }), "missing_steps");
  assert.equal(validatePlan({ steps: new Array(5).fill({ objective: "a", adapter: null }) }, { maxSteps: 4 }), "too_many_steps");
  assert.equal(validatePlan({ steps: [{ objective: "  ", adapter: null }] }), "missing_objective");
  assert.equal(validatePlan({ steps: [{ objective: "a", adapter: 7 }] }), "invalid_adapter_type");
  assert.equal(validatePlan({ steps: [{ objective: "a", adapter: "x" }] }, { allowedAdapters: ["y"] }), "adapter_not_allowed");
});

test("only transient provider failures are eligible for fallback", () => {
  assert.equal(shouldFallback({ code: "gemini_timeout" }), true);
  assert.equal(shouldFallback({ code: "gemini_transport_error" }), true);
  assert.equal(shouldFallback({ code: "gemini_http_429" }), true);
  assert.equal(shouldFallback({ code: "gemini_http_503" }), true);
  assert.equal(shouldFallback({ code: "gemini_http_401" }), false);
  assert.equal(shouldFallback({ code: "gemini_http_400" }), false);
  assert.equal(shouldFallback({ code: "gemini_invalid_plan" }), false);
  assert.equal(shouldFallback({ code: "gemini_invalid_json" }), false);
});

test("the correction path is bounded to one step", async () => {
  const model = planner("openai", {
    fetchImpl: async () =>
      planReply([
        { objective: "retry", adapter: "repo.inspect" },
        { objective: "second", adapter: "repo.inspect" }
      ])
  });
  const result = await model.correct({ objective: "x", failedObjective: "y", failure: "z", adapters: ["repo.inspect"] });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "too_many_steps");
});


test("the self-hosted Ollama-compatible provider is selectable without an API key", () => {
  const config = resolveAxProviderConfig({
    AX_PROVIDER: "ollama",
    AX_ORCHESTRATOR_ENABLED: "true"
  });
  assert.equal(config.enabled, true);
  assert.equal(config.primary.name, "ollama");
  assert.equal(config.primary.configured, true);
  assert.equal(config.primary.apiKey, "");
  assert.equal(config.primary.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(config.primary.model, "gpt-oss:20b");
  assert.ok(PROVIDER_NAMES.includes("ollama"));
  const status = describeProviderStatus(config);
  assert.equal(JSON.stringify(status).includes("OLLAMA_API_KEY"), false);
});

test("the self-hosted provider sends no fabricated bearer credential", async () => {
  let request;
  const model = createProviderPlanner({
    name: "ollama",
    apiKey: "",
    model: "local-test-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    configured: true
  }, {
    prices: PRICES,
    fetchImpl: async (url, init) => {
      request = { url, headers: init.headers, body: JSON.parse(init.body) };
      return planReply([{ objective: "inspect local capability", adapter: null }]);
    }
  });
  const result = await model.plan({ objective: "check local model", adapters: [] });
  assert.equal(result.ok, true);
  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.body.model, "local-test-model");
});
