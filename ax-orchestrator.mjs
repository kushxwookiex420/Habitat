import { createHash, randomBytes } from "node:crypto";

/**
 * Habitat-native Ax.
 *
 * Ax is not a second task engine. It is the planning half of the existing one: it turns an
 * objective into a small number of steps, submits each step through the SAME
 * universal-command-engine the /ax/command API uses, drives the SAME NEXUS worker, and only reports
 * completion when the stored result carries adapter-produced evidence.
 *
 * The model is only ever asked for a plan. It cannot execute anything, cannot name an adapter that
 * is not registered, and cannot approve, deny or close a task.
 */

export const DEFAULT_PRICES = Object.freeze({ inputPerMTok: 2, outputPerMTok: 10 });
const MODEL_TIMEOUT_MS = 30_000;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["objective", "adapter"],
        properties: {
          objective: { type: "string", maxLength: 500 },
          adapter: { type: ["string", "null"] },
          needsApproval: { type: "boolean" }
        }
      }
    }
  }
};

/** Any credential-shaped substring is removed before an error can reach a log, a run record or Ax. */
export function redact(text) {
  return String(text ?? "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .slice(0, 500);
}

export function resolveAxOrchestratorConfig(env = process.env) {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const enabled = String(env.AX_ORCHESTRATOR_ENABLED || "").trim().toLowerCase() === "true" && Boolean(apiKey);
  const code = !apiKey ? "openai_unconfigured" : "orchestrator_disabled";
  const error = !apiKey
    ? "Habitat-native Ax is unavailable: set OPENAI_API_KEY for this service."
    : "Habitat-native Ax is disabled: set AX_ORCHESTRATOR_ENABLED=true to allow it to plan and spend API credits.";
  return {
    enabled,
    code: enabled ? null : code,
    error: enabled ? null : error,
    apiKey,
    model: String(env.AX_MODEL || "gpt-6-luna").trim(),
    baseUrl: String(env.AX_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    // A plan is small on purpose: a runaway plan is a runaway bill and a runaway queue.
    maxSteps: Math.max(1, Math.min(8, number(env.AX_MAX_STEPS, 4))),
    maxCorrections: Math.max(0, Math.min(3, number(env.AX_MAX_CORRECTIONS, 1))),
    deadlineMs: Math.max(1_000, Math.min(600_000, number(env.AX_RUN_DEADLINE_MS, 90_000))),
    pollMs: Math.max(50, Math.min(10_000, number(env.AX_POLL_MS, 250))),
    budgetUsd: Math.max(0, Math.min(5, number(env.AX_RUN_BUDGET_USD, 0.05))),
    prices: {
      inputPerMTok: number(env.AX_PRICE_INPUT_PER_MTOK, DEFAULT_PRICES.inputPerMTok),
      outputPerMTok: number(env.AX_PRICE_OUTPUT_PER_MTOK, DEFAULT_PRICES.outputPerMTok)
    }
  };
}

export function costOf(usage, prices = DEFAULT_PRICES) {
  const input = Math.max(0, Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0));
  const output = Math.max(0, Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0));
  return Number(((input * prices.inputPerMTok + output * prices.outputPerMTok) / 1_000_000).toFixed(6));
}

/**
 * The only place a model is called. It returns a plan and the tokens it cost; nothing else.
 * Transport, key handling and redaction live here so the runner never sees a credential.
 */
export function createOpenAiPlanner({
  apiKey,
  model,
  baseUrl = "https://api.openai.com/v1",
  fetchImpl = fetch,
  prices = DEFAULT_PRICES,
  timeoutMs = MODEL_TIMEOUT_MS,
  maxSteps = 4
} = {}) {
  async function ask({ system, user, schema }) {
    if (!apiKey) throw new Error("openai_unconfigured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          response_format: { type: "json_schema", json_schema: { name: "ax_plan", strict: true, schema } }
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        // The status is useful, the body may contain the key echoed by a proxy: never surface it.
        throw new Error("openai_http_" + response.status);
      }
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("openai_empty_completion");
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error("openai_invalid_json"); }
      return { plan: parsed, usage: payload?.usage || null, costUsd: costOf(payload?.usage, prices) };
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async plan({ objective, adapters }) {
      const system = [
        "You are Ax, the planning half of the Habitat NEXUS runtime.",
        "Break the objective into the smallest number of steps that a read-only executor can complete.",
        "Reply with JSON only: {\"steps\":[{\"objective\":\"...\",\"adapter\":\"<one of the adapters or null>\",\"needsApproval\":false}]}.",
        "Rules: never plan a destructive or irreversible action; never invent an adapter;",
        "prefer one step when one is enough; " + maxSteps + " steps maximum."
      ].join(" ");
      const user = "Adapters available: " + (adapters || []).join(", ") + "\nObjective: " + objective;
      const result = await ask({ system, user, schema: PLAN_SCHEMA });
      return result;
    },
    async correct({ objective, failedObjective, failure, adapters }) {
      const system = [
        "You are Ax, repairing a failed Habitat NEXUS step.",
        "Reply with JSON only: {\"steps\":[{\"objective\":\"...\",\"adapter\":\"<adapter or null>\"}]}.",
        "Plan exactly one corrective step that can establish why the previous step failed or retry it safely.",
        "Never plan a destructive action and never invent an adapter."
      ].join(" ");
      const user = [
        "Adapters available: " + (adapters || []).join(", "),
        "Overall objective: " + objective,
        "Failed step: " + failedObjective,
        "Failure reported: " + failure
      ].join("\n");
      const result = await ask({ system, user, schema: { ...PLAN_SCHEMA, properties: { steps: { ...PLAN_SCHEMA.properties.steps, maxItems: 1 } } } });
      return result;
    }
  });
}

function terminal(status) {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** Evidence must exist and must have been written by the NEXUS worker, not by the caller. */
export function verifyResult(task) {
  if (!task || task.status !== "done") return { verified: false, reason: task?.status === "needs_approval" ? "needs_approval" : "not_done" };
  const evidence = Array.isArray(task.result?.evidence) ? task.result.evidence.filter(line => typeof line === "string" && line.trim()) : [];
  if (evidence.length === 0) return { verified: false, reason: "no_evidence" };
  if (!/^nexus-/.test(String(task.result?.verifiedBy || ""))) return { verified: false, reason: "not_executed_by_nexus" };
  return { verified: true, reason: null, evidence };
}

export function createAxOrchestrator({
  engine,
  // Optional: when absent the run is submitted and left for the cron executor, and the run stays
  // "running" instead of pretending it settled.
  execute = null,
  planner,
  runs,
  config,
  // The adapters the worker can actually run. Passed in so the planner can only choose real ones.
  adapters = null,
  log = console,
  now = () => new Date().toISOString(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!engine || typeof engine.submit !== "function" || typeof engine.get !== "function") {
    throw new Error("The Ax orchestrator needs the command engine; it does not own a second task store.");
  }
  if (!planner || typeof planner.plan !== "function") throw new Error("The Ax orchestrator needs a planner.");
  if (!runs || typeof runs.save !== "function" || typeof runs.get !== "function") throw new Error("The Ax orchestrator needs a run store.");

  const allowedAdapters = (adapters || engine.adapters?.() || []).slice().sort();

  async function save(run) {
    run.updatedAt = now();
    try { await runs.save(run); } catch (error) {
      log.error?.("AX_RUN_SAVE_FAILED", redact(error?.message || error));
      run.storeError = "run_could_not_be_persisted";
    }
    return run;
  }

  function validatePlan(raw, maxSteps) {
    const steps = Array.isArray(raw?.steps) ? raw.steps : null;
    if (!steps || steps.length === 0) return { ok: false, error: "the model returned no steps" };
    if (steps.length > maxSteps) return { ok: false, error: "the model returned more steps than allowed" };
    const cleaned = [];
    for (const step of steps) {
      const objective = String(step?.objective || "").trim();
      if (!objective) return { ok: false, error: "a step has no objective" };
      const adapter = step?.adapter === null || step?.adapter === undefined || step?.adapter === "" ? null : String(step.adapter).trim();
      // A planner may only choose what the executor can actually do. This is the guard that keeps
      // model output from becoming a capability request.
      if (adapter && !allowedAdapters.includes(adapter)) return { ok: false, error: "the model named an adapter that is not registered: " + adapter };
      cleaned.push({ objective, adapter, needsApproval: Boolean(step?.needsApproval) });
    }
    return { ok: true, steps: cleaned };
  }

  async function refresh(run) {
    let changed = false;
    for (const step of run.steps) {
      if (!step.taskId || step.terminal) continue;
      const outcome = await engine.get(step.taskId);
      const task = outcome?.ok === false ? null : outcome?.task;
      if (!task) continue;
      if (task.status !== step.status) { step.status = task.status; changed = true; }
      if (terminal(task.status) || task.status === "needs_approval") {
        const verdict = verifyResult(task);
        step.verified = verdict.verified;
        step.verifyReason = verdict.reason;
        step.evidence = verdict.evidence || [];
        step.error = task.error || (verdict.verified ? null : verdict.reason);
        step.terminal = terminal(task.status);
        changed = true;
      }
    }
    return changed;
  }

  async function drive(run, deadline) {
    // The tick claims one task per call. Drive it until every submitted step is terminal, the
    // deadline passes, or a human decision is required.
    let idle = 0;
    while (true) {
      await refresh(run);
      const open = run.steps.filter(step => step.taskId && !step.terminal);
      if (open.length === 0) return "settled";
      if (open.some(step => step.status === "needs_approval")) return "needs_approval";
      // No executor in this process: the tasks are queued for the cron executor. Do not spin.
      if (typeof execute !== "function") return "external";
      if (Date.now() > deadline) return "deadline";
      let report = null;
      try { report = await execute(); } catch (error) {
        log.error?.("AX_EXECUTE_FAILED", redact(error?.message || error));
        return "execute_failed";
      }
      idle = report?.claimed > 0 ? 0 : idle + 1;
      await sleep(idle > 3 ? Math.min(2_000, config.pollMs * 4) : config.pollMs);
    }
  }

  async function runObjective({ objective, requestedBy = "ax" } = {}) {
    const text = String(objective || "").trim();
    if (!text) return { ok: false, code: "invalid_objective", error: "An objective is required." };

    const run = {
      id: "run_" + createHash("sha256").update(text + "|" + now() + "|" + randomBytes(6).toString("hex")).digest("hex").slice(0, 20),
      objective: text.slice(0, 2000),
      requestedBy: String(requestedBy).slice(0, 120),
      status: "planning",
      plan: [],
      steps: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      corrections: 0,
      model: config.model,
      prices: config.prices,
      error: null,
      createdAt: now(),
      updatedAt: now()
    };
    const deadline = Date.now() + config.deadlineMs;
    await save(run);

    // 1. Plan.
    let planned;
    try {
      planned = await planner.plan({ objective: run.objective, adapters: allowedAdapters });
    } catch (error) {
      run.status = "error";
      run.error = redact(error?.message || error);
      return { ok: false, code: "plan_failed", error: run.error, run: await save(run) };
    }
    run.usage.input_tokens += Number(planned.usage?.prompt_tokens || 0);
    run.usage.output_tokens += Number(planned.usage?.completion_tokens || 0);
    run.costUsd = Number((run.costUsd + planned.costUsd).toFixed(6));
    if (run.costUsd > config.budgetUsd) {
      run.status = "budget_exceeded";
      run.error = "Planning cost " + run.costUsd + " USD exceeded the run budget of " + config.budgetUsd + " USD.";
      return { ok: false, code: "budget_exceeded", error: run.error, run: await save(run) };
    }

    const validated = validatePlan(planned.plan, config.maxSteps);
    if (!validated.ok) {
      run.status = "error";
      run.error = "plan_invalid: " + validated.error;
      return { ok: false, code: "plan_invalid", error: run.error, run: await save(run) };
    }
    run.plan = validated.steps;
    run.status = "running";
    await save(run);

    // 2. Submit every step through the existing engine (idempotent per run + index).
    for (const [index, step] of validated.steps.entries()) {
      // Ax must never start work the plan itself says needs the owner. It reports and stops; the
      // owner decides. Submitting it and hoping the worker refuses would be a silent bypass.
      if (step.needsApproval) {
        run.steps.push({
          index, taskId: null, objective: step.objective, adapter: step.adapter,
          needsApproval: true, status: "needs_approval", verified: false,
          verifyReason: "needs_approval", evidence: [], error: null, terminal: false
        });
        break;
      }
      const outcome = await engine.submit({
        objective: step.objective,
        requestedBy: "ax",
        role: "ax",
        adapter: step.adapter,
        idempotencyKey: run.id + ":s" + index
      });
      if (outcome?.ok === false) {
        run.status = "failed";
        run.error = "submit_failed: " + (outcome.error || outcome.code || "unknown");
        return { ok: false, code: "submit_failed", error: run.error, run: await save(run) };
      }
      const task = outcome.task;
      run.steps.push({
        index,
        taskId: task.id,
        objective: step.objective,
        adapter: step.adapter,
        needsApproval: step.needsApproval,
        status: task.status,
        verified: false,
        verifyReason: null,
        evidence: [],
        error: null,
        terminal: false
      });
      await save(run);
      // A step that the engine parked for a human is not executable; stop asking the worker to run.
      if (task.status === "needs_approval") break;
    }

    // 3. Execute and verify.
    let outcome = await drive(run, deadline);

    // 4. Correct a failed step once, through the planner (bounded), then verify again.
    while (outcome === "settled" && run.corrections < config.maxCorrections) {
      const failed = run.steps.find(step => step.status === "failed");
      if (!failed) break;
      run.corrections += 1;
      const correction = await planner.correct({
        objective: run.objective,
        failedObjective: failed.objective,
        failure: failed.error || "failed",
        adapters: allowedAdapters
      }).catch(error => ({ error }));
      if (correction?.error) { run.correctionError = redact(correction.error?.message); break; }
      run.usage.input_tokens += Number(correction.usage?.prompt_tokens || 0);
      run.usage.output_tokens += Number(correction.usage?.completion_tokens || 0);
      run.costUsd = Number((run.costUsd + correction.costUsd).toFixed(6));
      if (run.costUsd > config.budgetUsd) { run.status = "budget_exceeded"; break; }
      const repaired = validatePlan(correction.plan, 1);
      if (!repaired.ok) { run.correctionError = "plan_invalid: " + repaired.error; break; }
      const step = repaired.steps[0];
      const submission = await engine.submit({
        objective: step.objective, requestedBy: "ax", role: "ax", adapter: step.adapter,
        idempotencyKey: run.id + ":c" + run.corrections
      });
      if (submission?.ok === false) { run.correctionError = "submit_failed: " + (submission.error || "unknown"); break; }
      run.steps.push({
        index: run.steps.length,
        taskId: submission.task.id,
        objective: step.objective,
        adapter: step.adapter,
        corrective: true,
        status: submission.task.status,
        verified: false, verifyReason: null, evidence: [], error: null, terminal: false
      });
      failed.correctedBy = submission.task.id;
      await save(run);
      outcome = await drive(run, deadline);
    }

    // 5. Report. Completion requires every step to be done AND verified by the worker's evidence.
    await refresh(run);
    // A step is satisfied when its own result is verified, or when it failed and the corrective task
    // it created is itself verified. The failure stays in the record either way.
    const satisfied = step => step.verified || (
      step.status === "failed" &&
      Boolean(step.correctedBy) &&
      run.steps.some(candidate => candidate.taskId === step.correctedBy && candidate.verified === true)
    );
    const unverified = run.steps.filter(step => !satisfied(step));
    const approval = run.steps.find(step => step.status === "needs_approval");
    if (run.status === "budget_exceeded") {
      // keep the reason already set
    } else if (approval) {
      run.status = "needs_approval";
      run.error = "A step needs the owner's approval. Ax cannot approve it.";
    } else if (outcome === "deadline") {
      run.status = "deadline_exceeded";
      run.error = "The run did not settle within " + config.deadlineMs + " ms.";
    } else if (outcome === "external") {
      run.status = "running";
      run.note = "No in-process executor: the tasks are queued for the cron executor. Poll this run for its result.";
    } else if (outcome === "execute_failed") {
      run.status = "failed";
      run.error = run.correctionError || "executor_failed";
    } else if (unverified.length) {
      run.status = "failed";
      run.error = run.correctionError || ("unverified: " + unverified.map(step => step.taskId + " (" + (step.verifyReason || step.status) + ")").join(", "));
    } else {
      run.status = "completed";
      run.completedAt = now();
    }
    run.verified = run.status === "completed";
    run.evidence = run.steps.flatMap(step => step.evidence || []);
    await save(run);
    return { ok: run.status === "completed", code: run.status, error: run.error, run };
  }

  return Object.freeze({
    enabled: Boolean(config.enabled),
    code: config.code,
    error: config.error,
    model: config.model,
    budgetUsd: config.budgetUsd,
    adapters: allowedAdapters.slice(),
    runObjective,
    async getRun(id) { return runs.get(String(id || "")); },
    async listRuns({ limit = 20 } = {}) { return runs.list({ limit }); },
    async initialize() { if (typeof runs.initialize === "function") await runs.initialize(); return { ok: true }; }
  });
}
