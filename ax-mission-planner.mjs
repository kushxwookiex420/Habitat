import { DEFAULT_PRICES, costOf } from "./ax-orchestrator.mjs";
import { planMissionSteps, criterionStatements, MISSION_ROLE_IDS } from "./ax-mission-plan.mjs";
import { createCostGovernor, resolveCostLimits } from "./ax-cost-governor.mjs";

/**
 * Model-backed mission planning for the Director agent.
 *
 * The entry point is provider-independent: it accepts any `complete({system,user,schema,signal})`
 * that returns `{ ok, text|json, costUsd, provider, model, free }`. OpenRouter is wired below because
 * it is an OpenAI-compatible transport, but nothing in the validation, cost or fallback path depends
 * on that choice.
 *
 * The model may only choose which specialists work and what each one is asked. It cannot add an
 * adapter, invent an agent, raise its own budget, or skip independent verification. A malformed,
 * timed-out, refused or over-budget response becomes the deterministic plan, with the reason kept in
 * the result so the mission records that it ran on the fallback.
 */

export const MISSION_PLANNER_LIMITS = Object.freeze({
  timeoutMs: 12_000,
  retries: 1,
  maxSteps: 6,
  maxOutputChars: 12_000,
  maxObjectiveChars: 1000,
  estimateUsd: 0.006
});

const MANDATORY = Object.freeze({
  security: "Audit the adapter allowlist and permissions relevant to: ",
  verification: "Independently check the recorded evidence against every acceptance criterion for: "
});

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Strict validation of a model's mission plan. Returns the normalized plan or a typed error. */
export function validateModelMissionPlan(value, { maxSteps = MISSION_PLANNER_LIMITS.maxSteps } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "plan_not_object" };
  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return { ok: false, code: "steps_required" };
  if (rawSteps.length > maxSteps) return { ok: false, code: "too_many_steps" };

  const steps = [];
  for (const [index, raw] of rawSteps.entries()) {
    if (!raw || typeof raw !== "object") return { ok: false, code: "step_not_object", index };
    if (raw.adapter) return { ok: false, code: "adapter_not_allowed", index };
    const agent = clean(raw.agent, 40).toLowerCase();
    if (!MISSION_ROLE_IDS.includes(agent)) return { ok: false, code: "unknown_agent", index, agent };
    if (agent === "verification") continue; // appended once, after all producing steps
    const objective = clean(raw.objective, MISSION_PLANNER_LIMITS.maxObjectiveChars);
    if (objective.length < 8) return { ok: false, code: "step_objective_too_short", index };
    if (steps.some(step => step.agent === agent)) return { ok: false, code: "duplicate_agent", index, agent };
    steps.push({
      key: agent,
      agent,
      objective,
      adapter: null,
      requiresApproval: raw.requiresApproval === true
    });
  }
  if (!steps.length) return { ok: false, code: "no_producing_steps" };

  // Guarantees are not delegable to the model: security review always runs, and verification is
  // always the final phase. A model that omitted either gets them appended, not trusted.
  const augmented = [];
  if (!steps.some(step => step.agent === "security")) {
    steps.push({
      key: "security",
      agent: "security",
      objective: MANDATORY.security + "(the mission objective)",
      adapter: null,
      requiresApproval: false
    });
    augmented.push("security");
  }
  steps.push({
    key: "verification",
    agent: "verification",
    objective: "Independently check the recorded evidence against every acceptance criterion for this mission.",
    adapter: null,
    requiresApproval: false
  });
  return {
    ok: true,
    steps: steps.map((step, index) => ({ ...step, index })),
    augmented,
    strategy: "model"
  };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("planner_timeout")), ms); })
  ]);
}

/**
 * @param {object} options
 * @param {Function|null} options.complete  provider call; null forces deterministic planning
 * @param {object} options.governor          createCostGovernor()
 * @param {boolean} options.free             provider/model is explicitly free
 */
export function createMissionPlanner({
  complete = null,
  governor = createCostGovernor(),
  limits = {},
  free = false,
  provider = null,
  model = null,
  log = console,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => new Date().toISOString()
} = {}) {
  const config = { ...MISSION_PLANNER_LIMITS, ...limits };
  if (!governor || typeof governor.reserve !== "function" || typeof governor.settle !== "function") {
    throw new Error("The mission planner needs the cost governor.");
  }

  function deterministic(input, reason, extra = {}) {
    const plan = planMissionSteps(input);
    return {
      ok: true,
      plan: {
        ...plan,
        provider: "deterministic",
        model: null,
        fallback: true,
        fallbackReason: reason,
        costUsd: 0,
        strategy: "deterministic-routing"
      },
      provider: "deterministic",
      model: null,
      fallback: true,
      fallbackReason: reason,
      costUsd: 0,
      attempts: extra.attempts || [],
      ...extra
    };
  }

  async function plan({ objective, criteria = [], capabilities = {}, taskId = null } = {}) {
    const input = { objective, criteria, capabilities };
    if (typeof complete !== "function") return deterministic(input, "model_not_configured");

    const id = clean(taskId, 160) || "mission-plan:" + clean(objective, 80);
    const reservation = await governor.reserve({
      taskId: id,
      estimateUsd: config.estimateUsd,
      free,
      provider,
      model
    });
    if (reservation.ok !== true) {
      return deterministic(input, reservation.code || "budget_refused", { budget: reservation });
    }

    const attempts = [];
    let spentUsd = 0;
    let lastCode = "planner_failed";
    let lastDetail = null;
    for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
      let outcome;
      try {
        outcome = await withTimeout(complete({
          system: systemPrompt(config.maxSteps),
          user: userPrompt(input),
          schema: PLAN_SCHEMA,
          signal: null
        }), config.timeoutMs);
      } catch (error) {
        outcome = { ok: false, code: error?.message === "planner_timeout" ? "planner_timeout" : "planner_transport_error" };
      }
      spentUsd += Number(outcome?.costUsd || 0);
      let parsed = null;
      let invalid = null;
      if (outcome?.ok === true) {
        parsed = outcome.json ?? null;
        if (!parsed && typeof outcome.text === "string") {
          try { parsed = JSON.parse(outcome.text); } catch { parsed = null; }
        }
        if (!parsed) invalid = { ok: false, code: "invalid_json" };
        else invalid = validateModelMissionPlan(parsed, { maxSteps: config.maxSteps });
      } else {
        invalid = { ok: false, code: outcome?.code || "provider_failed" };
      }
      attempts.push({ attempt, ok: invalid.ok === true, code: invalid.ok ? null : invalid.code, costUsd: Number(outcome?.costUsd || 0) });
      if (invalid.ok === true) {
        const missingCapabilities = invalid.steps
          .map(step => step.agent)
          .filter(agent => input.capabilities[agent] === false);
        const settled = await governor.settle({ taskId: id, estimateUsd: config.estimateUsd, costUsd: spentUsd, ok: true });
        return {
          ok: true,
          plan: {
            objective: clean(objective, 2000),
            criteria: criterionStatements(criteria),
            strategy: "model",
            provider: outcome.provider || provider || "model",
            model: outcome.model || model || null,
            fallback: false,
            costUsd: Number(spentUsd.toFixed(6)),
            steps: invalid.steps,
            augmented: invalid.augmented,
            missingCapabilities,
            capabilities: { ...input.capabilities },
            usage: outcome.usage || null,
            note: "Model plan accepted after strict validation; security and verification are guaranteed."
          },
          provider: outcome.provider || provider || "model",
          model: outcome.model || model || null,
          fallback: false,
          costUsd: Number(spentUsd.toFixed(6)),
          attempts,
          budget: settled
        };
      }
      lastCode = invalid.code;
      lastDetail = invalid;
      // Only transient or repairable failures are retried. A refusal, an over-budget response or a
      // forbidden plan is final: retrying it would only spend more for the same answer.
      const retryable = ["planner_timeout", "planner_transport_error", "provider_failed", "invalid_json", "invalid_plan", "rate_limited", "openrouter_timeout", "openrouter_transport_error", "openrouter_invalid_response"];
      if (!retryable.includes(lastCode)) break;
      if (attempt <= config.retries) await sleep(150 * attempt);
    }

    const fallback = deterministic(input, lastCode, { attempts, detail: lastDetail });
    const settled = await governor.settle({ taskId: id, estimateUsd: config.estimateUsd, costUsd: spentUsd, ok: false });
    return { ...fallback, costUsd: Number(spentUsd.toFixed(6)), budget: settled };
  }

  return Object.freeze({
    mode: complete ? "model" : "deterministic",
    provider,
    model,
    free: free === true,
    plan,
    status: () => governor.status()
  });
}

function systemPrompt(maxSteps) {
  return [
    "You are the Director in the Habitat NEXUS runtime. Plan a bounded, read-only mission.",
    "Return JSON only: {\"steps\":[{\"agent\":\"...\",\"objective\":\"...\",\"requiresApproval\":false}]}.",
    "Allowed agents: " + MISSION_ROLE_IDS.filter(role => role !== "director").join(", ") + ".",
    "Never include an adapter, a deploy, a purchase, a publish or a credential action.",
    "Use the fewest steps that can satisfy the criteria; " + maxSteps + " steps maximum.",
    "Security review and independent verification are added automatically; do not rely on omitting them."
  ].join(" ");
}

function userPrompt({ objective, criteria, capabilities }) {
  const statements = criterionStatements(criteria);
  return [
    "Objective: " + clean(objective, 2000),
    "Acceptance criteria: " + (statements.length ? statements.join(" | ") : "none supplied"),
    "Available agents: " + MISSION_ROLE_IDS.map(role => role + "=" + (capabilities[role] ? "available" : "unavailable")).join(", ")
  ].join("\n");
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["agent", "objective"],
        properties: {
          agent: { type: "string", enum: MISSION_ROLE_IDS.filter(role => role !== "director") },
          objective: { type: "string", minLength: 8, maxLength: 1000 },
          requiresApproval: { type: "boolean" }
        }
      }
    }
  }
};

/** Explicitly free models only. `openrouter/auto` is not free and is refused in free-only mode. */
export function isFreeModel(model) {
  const text = String(model || "").trim().toLowerCase();
  return text === "openrouter/free" || text.endsWith(":free");
}

/**
 * OpenAI-compatible completion used by the planner. It never throws and never returns the key.
 * `costUsd` is zero for a free model; a failed paid call is charged the configured failure cost.
 */
export function createOpenRouterCompletion({
  apiKey,
  model = "openrouter/free",
  baseUrl = "https://openrouter.ai/api/v1",
  fetchImpl = fetch,
  freeOnly = true,
  timeoutMs = 20_000,
  maxOutputTokens = 700,
  prices = DEFAULT_PRICES,
  failedCallCostUsd = 0.004,
  now = () => new Date().toISOString()
} = {}) {
  const free = isFreeModel(model);
  async function complete({ system, user, schema } = {}) {
    if (!apiKey) return { ok: false, code: "openrouter_unconfigured", costUsd: 0, free, provider: "openrouter", model };
    if (freeOnly && !free) return { ok: false, code: "free_only_refused", costUsd: 0, free, provider: "openrouter", model };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(String(baseUrl).replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + apiKey,
          "HTTP-Referer": "https://github.com/kushxwookiex420/Habitat",
          "X-Title": "Habitat NEXUS"
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxOutputTokens,
          response_format: { type: "json_schema", json_schema: { name: "nexus_plan", strict: true, schema } },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        return { ok: false, code: "openrouter_http_" + Number(response.status || 0), costUsd: free ? 0 : failedCallCostUsd, free, provider: "openrouter", model, at: now() };
      }
      let payload;
      try { payload = await response.json(); } catch {
        return { ok: false, code: "openrouter_invalid_response", costUsd: free ? 0 : failedCallCostUsd, free, provider: "openrouter", model };
      }
      const usage = payload?.usage && (payload.usage.prompt_tokens != null || payload.usage.input_tokens != null) ? payload.usage : null;
      const costUsd = free ? 0 : usage ? costOf(usage, prices) : failedCallCostUsd;
      const text = String(payload?.choices?.[0]?.message?.content ?? "").slice(0, MISSION_PLANNER_LIMITS.maxOutputChars);
      if (!text.trim()) return { ok: false, code: "openrouter_empty_completion", costUsd, free, provider: "openrouter", model };
      return { ok: true, text, usage: usage || null, costUsd, free, provider: "openrouter", model, at: now() };
    } catch (error) {
      return {
        ok: false,
        code: controller.signal.aborted ? "openrouter_timeout" : "openrouter_transport_error",
        costUsd: free ? 0 : failedCallCostUsd,
        free,
        provider: "openrouter",
        model
      };
    } finally {
      clearTimeout(timer);
    }
  }
  complete.free = free;
  complete.model = model;
  complete.provider = "openrouter";
  return complete;
}

/**
 * Runtime resolution. Off unless explicitly enabled; never constructs a paid provider in free-only
 * mode, and never reads or exposes the key beyond the completion closure.
 */
export function resolveMissionPlanner(env = process.env) {
  if (String(env.NEXUS_MODEL_PLANNING_ENABLED || "").trim().toLowerCase() !== "true") {
    return null;
  }
  const limits = resolveCostLimits(env);
  const provider = String(env.NEXUS_PLANNER_PROVIDER || "openrouter").trim().toLowerCase();
  if (provider !== "openrouter") return null;
  const model = String(env.NEXUS_PLANNER_MODEL || "openrouter/free").trim();
  const apiKey = String(env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) return null;
  const free = isFreeModel(model);
  if (limits.freeOnly && !free) return null;
  const governor = createCostGovernor({ limits, freeOnly: limits.freeOnly });
  const complete = createOpenRouterCompletion({ apiKey, model, freeOnly: limits.freeOnly });
  return createMissionPlanner({ complete, governor, free, provider: "openrouter", model, limits: { estimateUsd: limits.estimateUsd } });
}
