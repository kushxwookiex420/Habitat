import express from "express";

const app = express();

app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 8080;

function getApiKey() {
  const rawApiKey = process.env.OPENROUTER_API_KEY;
  return rawApiKey ? String(rawApiKey).trim().replace(/^["']|["']$/g, "") : "";
}
const apiKey = getApiKey();
const model = "poolside/laguna-s-2.1:free";
const fallbackModels = [
  // Current OpenRouter free endpoints. Keep this list limited to
  // model IDs confirmed by the live OpenRouter catalog.
  "nvidia/nemotron-3.5-lightning:free",
  "poolside/laguna-xs-2.1:free",
  "nvidia/nemotron-3-nano-omni:free"
];
const fallbackModel = fallbackModels[0];
const providerTimeoutMs = 12000;

if (!getApiKey()) {
  console.warn(
    "WARNING: OPENROUTER_API_KEY is not configured."
  );
}

app.use((req, res, next) => {
  const requestId = "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  req.habitatRequestId = requestId;
  res.setHeader("X-Habitat-Request-Id", requestId);
  res.setHeader("X-Habitat-Version", "2026-10-08-auth-path-v1");
  console.log("HABITAT_REQUEST", requestId, req.method, req.path);
  next();
});

async function openRouterChat(payload) {
  const runtimeApiKey = getApiKey();
  if (!runtimeApiKey) {
    const error = new Error("Habitat runtime is missing OPENROUTER_API_KEY before contacting OpenRouter.");
    error.status = 500;
    throw error;
  }

  const requestedModel = payload?.model || model;
  const modelsToTry = requestedModel === model ? [model, ...fallbackModels] : [requestedModel];
  let lastError = null;

  for (const selectedModel of modelsToTry) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);

      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${runtimeApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://habitat-1-szzd.onrender.com",
            "X-Title": "Habitat Ax Core"
          },
          body: JSON.stringify({
            ...payload,
            model: selectedModel,
            max_tokens: payload?.max_tokens || 512,
            provider: payload?.provider || {
              allow_fallbacks: true,
              sort: "throughput"
            }
          }),
          signal: controller.signal
        });

        const text = await response.text();
        let data;
        try { data = JSON.parse(text); }
        catch { data = { error: { message: text || "OpenRouter returned a non-JSON response." } }; }

        if (response.ok) return data;

        const providerMessage =
          data?.error?.message ||
          data?.error?.error?.message ||
          text ||
          `OpenRouter HTTP ${response.status}`;

        const error = new Error(`OpenRouter HTTP ${response.status}: ${providerMessage}`);
        error.status = response.status;
        error.retryAfter = Number(response.headers.get("retry-after") || 0);
        lastError = error;

        console.warn(
          "OPENROUTER_ATTEMPT_FAILED",
          selectedModel,
          "attempt=" + (attempt + 1),
          String(error.message).slice(0, 300)
        );

        if (response.status !== 429 && response.status !== 502 && response.status !== 503) break;

        const waitMs = error.retryAfter > 0
          ? Math.min(error.retryAfter * 1000, 8000)
          : Math.min(1000 * (2 ** attempt), 4000);

        await new Promise(resolve => setTimeout(resolve, waitMs));
      } catch (error) {
        lastError = error;
        console.warn(
          "OPENROUTER_ATTEMPT_FAILED",
          selectedModel,
          "attempt=" + (attempt + 1),
          String(error?.message || error).slice(0, 300)
        );
        // An AbortError is normally a provider timeout. Do not immediately
        // hammer the same provider a second time; move to the next fallback.
        if (error?.name === "AbortError") break;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  throw lastError || new Error("OpenRouter request failed.");
}

/*
 * HABITAT AX CORE
 *
 * FREE BRAIN EDITION
 *
 * Provider:
 *   OpenRouter
 *
 * Model:
 *   openrouter/free
 *
 * Endpoints:
 *   GET  /
 *   GET  /health
 *   POST /chat
 */

app.get("/", (req, res) => {
  res.json({
    habitat: "online",
    brain: getApiKey() ? "ready" : "missing_api_key",
    apiKeyPresent: Boolean(getApiKey()),
    apiKeyPrefix: getApiKey() ? getApiKey().slice(0, 8) + "..." : null,
    backend: "ready",
    provider: "openrouter",
    model,
    fallbackModel,
    free_brain: true,
    message: "Habitat Ax Core backend is running."
  });
});

app.get("/diagnostics/provider", async (req, res) => {
  const startedAt = Date.now();

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      runtimeKeyPresent: false,
      runtimeKeyPrefix: null,
      runtimeKeyLength: 0,
      authorizationHeaderPrepared: false,
      provider: "openrouter",
      error: "OPENROUTER_API_KEY is missing from the running Render process."
    });
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${getApiKey()}`,
        "HTTP-Referer": "https://habitat-1-szzd.onrender.com",
        "X-OpenRouter-Title": "Habitat Ax Core"
      }
    });

    const bodyText = await response.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText.slice(0, 500) }; }

    return res.status(response.ok ? 200 : 502).json({
      ok: response.ok,
      runtimeKeyPresent: true,
      runtimeKeyPrefix: getApiKey().slice(0, 8) + "...",
      runtimeKeyLength: getApiKey().length,
      authorizationHeaderPrepared: true,
      provider: "openrouter",
      providerStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      providerError: response.ok ? null : (body?.error?.message || body?.error || body?.raw || "unknown provider response")
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      runtimeKeyPresent: true,
      runtimeKeyPrefix: apiKey.slice(0, 8) + "...",
      runtimeKeyLength: apiKey.length,
      authorizationHeaderPrepared: true,
      provider: "openrouter",
      elapsedMs: Date.now() - startedAt,
      error: String(error?.message || error)
    });
  }
});

app.post("/device/heartbeat", (req, res) => {
  const packageName = String(req.body?.packageName || "").trim();
  const deviceId = String(req.body?.deviceId || "").trim();
  const deviceModel = String(req.body?.deviceModel || "").trim();
  const appVersion = String(req.body?.appVersion || "").trim();

  if (packageName !== "com.habitat" || !deviceId || !deviceModel) {
    return res.status(400).json({ ok: false, error: "Valid Habitat Android identity required." });
  }

  const device = {
    deviceId,
    packageName,
    deviceModel,
    appVersion,
    lastSeenAt: nowIso()
  };
  androidDevices.set(deviceId, device);
  return res.json({ ok: true, androidDeviceAccess: "PASS", device });
});

app.get("/device/status", (req, res) => {
  const access = androidAccessStatus();
  return res.json({ ok: access.status === "PASS", androidDeviceAccess: access.status, detail: access.detail, devices: access.devices });
});

app.get("/health", (req, res) => {
  res.json({
    habitat: "online",
    brain: apiKey ? "ready" : "missing_api_key",
    backend: "ready",
    provider: "openrouter",
    model,
    free_brain: true
  });
});

app.post("/chat", async (req, res) => {
  try {
    const message = String(
      req.body?.message || ""
    ).trim();

    if (!message) {
      return res.status(400).json({
        error: "message required"
      });
    }

    if (!apiKey) {
      return res.status(500).json({
        error:
          "OPENROUTER_API_KEY is not configured on the Habitat server."
      });
    }

    const history = Array.isArray(
      req.body?.history
    )
      ? req.body.history
      : [];

    const recentHistory = history.slice(-20);

    // Never expose a provider safety/status artifact as Ax's answer.
    const normalizedMessage = message.toLowerCase().replace(/[^a-z0-9? ]/g, " ").replace(/\s+/g, " ").trim();
    const isCoreStatusQuestion =
      /^(is ax (online|there)|are you (online|there)|ax (online|there)|are you up|status|habitat status|check status)[? ]*$/.test(normalizedMessage);

    if (/system\s*check/i.test(message)) {
      const check = await runSystemCheck();
      return res.json({
        response: check.report,
        model,
        provider: "openrouter",
        habitat: "online",
        free_brain: true,
        systemCheck: check
      });
    }

    if (isCoreStatusQuestion) {
      return res.json({
        response: "Yes — Ax is online and the Habitat brain is connected. I'm ready to work.",
        model,
        provider: "openrouter",
        habitat: "online",
        free_brain: true,
        deterministic: true
      });
    }
    // Broad operational commands: route requests that explicitly ask Ax to create/execute/
    // dispatch/verify a task through the real task engine instead of letting the LLM simulate it.
    // Do not intercept system-check requests; those retain their existing diagnostic behavior.
    const operationalIntent = !/system\\s*check|habitat_check|check\\s+android\\s+connectivity/i.test(message) &&
      /\\b(create|make|start|add|execute|run|perform|delegate|dispatch|complete|verify)\\b/i.test(message) &&
      /\\b(task|operation|mission|job|worker)\\b/i.test(message);

    if (operationalIntent) {
      const requestedTitle =
        message.match(/\\b(?:task|operation|mission|job)\\s+(?:named|called|titled)\\s+["']?([^"'\\n]+)["']?/i)?.[1]?.trim() ||
        message.match(/(?:create|make|start|add)\\s+(?:a\\s+)?(?:real\\s+)?(?:task|operation|mission|job)\\b(?:\\s+to)?\\s+(.+?)(?:\\.|$)/i)?.[1]?.trim() ||
        "Ax Operational Test";
      const title = requestedTitle.replace(/\\s+(?:and\\s+)?(?:execute|run|perform|delegate|dispatch|verify).*$/i, "").replace(/[.]+$/, "").trim();
      const wantsExecution = /\\b(?:execute|run|perform|delegate|dispatch|do|complete)\\b/i.test(message);

      try {
        const createResponse = await fetch("http://127.0.0.1:" + port + "/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title || "Ax Operational Task",
            description: "Created by Ax operational command: " + message
          })
        });
        const createText = await createResponse.text();
        let created;
        try { created = JSON.parse(createText); }
        catch { created = { ok: false, error: createText || "task service returned non-JSON" }; }
        if (!createResponse.ok || !created?.task?.id) {
          return res.status(502).json({ error: "Habitat task service could not create the operational task.", taskService: created });
        }

        let task = created.task;
        if (wantsExecution) {
          const delegateResponse = await fetch("http://127.0.0.1:" + port + "/tasks/" + encodeURIComponent(task.id) + "/delegate", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
          });
          const delegateText = await delegateResponse.text();
          let delegated;
          try { delegated = JSON.parse(delegateText); }
          catch { delegated = { ok: false, error: delegateText || "task delegate returned non-JSON" }; }
          if (!delegateResponse.ok || !delegated?.task) {
            return res.status(502).json({ error: "Operational task was created but worker dispatch failed.", task: task, dispatch: delegated });
          }
          task = delegated.task;
          return res.json({
            response: "TASK CREATED AND EXECUTED\\nTask ID: " + task.id + "\\nStatus: " + task.status + "\\nWorker: " + (task.worker || "unknown") + "\\nResult:\\n" + (task.result || task.error || "No worker result."),
            task, taskEngine: "connected", model, provider: "openrouter", habitat: "online", free_brain: true, deterministic: true
          });
        }
        return res.json({
          response: "TASK CREATED\\nTask ID: " + task.id + "\\nStatus: " + task.status,
          task, taskEngine: "connected", model, provider: "openrouter", habitat: "online", free_brain: true, deterministic: true
        });
      } catch (error) {
        console.error("AX OPERATIONAL COMMAND ERROR:", error);
        return res.status(502).json({ error: "Habitat operational task command failed.", details: String(error?.message || error) });
      }
    }

    // Explicit task commands are handled by the real Habitat task engine, not by
    // the language model's memory. This prevents Ax from incorrectly saying the
    // task-management backend is unavailable when /tasks is live.
    const taskIntent = message.match(
      /^(?:ax[,:]?\s*)?(?:please\s+)?(?:create|make|start|add)\s+(?:a\s+)?task\s+(?:named|called)\s+(.+?)(?:\s+and\s+(?:reply|respond|return)\b.*)?$/i
    );

    if (taskIntent) {
      const title = String(taskIntent[1] || "").trim().replace(/[.]+$/, "");
      if (!title) return res.status(400).json({ error: "task title required" });

      try {
        const createResponse = await fetch("http://127.0.0.1:" + port + "/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            description: "Created by Ax from an explicit task command: " + message
          })
        });

        const createText = await createResponse.text();
        let created;
        try { created = JSON.parse(createText); }
        catch { created = { ok: false, error: createText || "task service returned non-JSON" }; }

        if (!createResponse.ok || !created?.task?.id) {
          return res.status(502).json({
            error: "Habitat task service could not create the task.",
            taskService: created
          });
        }

        const task = created.task;
        const wantsExecution = /\b(?:execute|run|perform|delegate|dispatch|do)\b/i.test(message);

        if (wantsExecution) {
          const delegateResponse = await fetch(
            "http://127.0.0.1:" + port + "/tasks/" + encodeURIComponent(task.id) + "/delegate",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}"
            }
          );

          const delegateText = await delegateResponse.text();
          let delegated;
          try { delegated = JSON.parse(delegateText); }
          catch { delegated = { ok: false, error: delegateText || "task delegate returned non-JSON" }; }

          if (!delegateResponse.ok || !delegated?.task) {
            return res.status(502).json({
              error: "Task was created but worker dispatch failed.",
              task: created.task,
              dispatch: delegated
            });
          }

          const finished = delegated.task;
          return res.json({
            response:
              "TASK CREATED AND EXECUTED\n" +
              "Task ID: " + finished.id + "\n" +
              "Status: " + finished.status + "\n" +
              "Worker: " + (finished.worker || "unknown") + "\n" +
              "Result:\n" + (finished.result || finished.error || "No worker result."),
            task: finished,
            taskEngine: "connected",
            model,
            provider: "openrouter",
            habitat: "online",
            free_brain: true
          });
        }

        return res.json({
          response:
            "TASK CREATED\n" +
            "Task ID: " + task.id + "\n" +
            "Status: " + task.status,
          task,
          taskEngine: "connected",
          model,
          provider: "openrouter",
          habitat: "online",
          free_brain: true
        });
      } catch (error) {
        console.error("AX TASK COMMAND ERROR:", error);
        return res.status(502).json({
          error: "Habitat task command failed.",
          details: String(error?.message || error)
        });
      }
    }

    const systemPrompt = `
You are Ax, the central intelligence of Habitat.

Habitat is the user's personal AI operating environment.

Your role is to:

- understand the user's objective
- reason about the task
- use available tools when connected
- coordinate specialized agents
- maintain useful project context
- distinguish planning from completed actions
- never claim an external action happened unless it was actually confirmed
- give direct, practical next steps
- help operate the user's projects
- help develop Habitat itself

Current Habitat projects:

1. DropPilot AI — Shopify + TikTok Shop US dropshipping, currently focused on finding the first sale and then building a repeatable daily sales system.
2. Vice City Files — a phone-first GTA/Vice City content channel using free/low-cost tools and repeatable short-form/video workflows.
3. Habitat — the Android control center itself. Ax is the manager/orchestrator. Habitat should coordinate workers, tasks, memory, verification, and project execution.

Ax operating doctrine:

UNDERSTAND
- Identify the actual objective, constraints, current state, and what is already known.
- Preserve continuity from the supplied conversation history.
- Do not make the user repeat information already present in context.

PLAN
- Break meaningful requests into concrete steps.
- Decide what Ax can do directly, what requires a connected worker/tool, and what requires the user.
- Prefer the highest-probability path over busywork.

ACT
- Give executable instructions or produce the requested result.
- When Habitat workers are available, delegate specialized work and synthesize their results.
- Never claim an external action, purchase, deployment, API call, account change, or completed task unless it is actually confirmed.

OBSERVE
- Pay attention to errors, missing data, latency, and contradictions.
- Treat tool/worker failures as state, not as success.

VERIFY
- Before declaring something fixed or complete, verify the result when verification is available.
- Distinguish "planned", "attempted", "completed", and "verified".

STORE RESULT
- Use the conversation history as working memory.
- Preserve useful decisions, project state, constraints, and next actions in responses so the next turn can continue cleanly.

Response quality standard:
- Do not answer like a generic chatbot.
- For simple questions, be concise.
- For projects, troubleshooting, or decisions, give enough reasoning and concrete detail to be genuinely useful.
- When a task is ambiguous, make the best reasonable interpretation from available context instead of asking unnecessary questions.
- When something cannot be done from Habitat, say exactly what is blocked and the smallest user action needed.
- For technical debugging, identify the likely root cause, the exact fix, and how it will be verified.
- For business decisions, rank options by probability/impact and state the key assumption or risk.
- Keep Ax in the manager role: workers report to Ax; Ax decides and communicates the final execution order.

Current operating context:
- Habitat Android is being actively hardened. The Android app must remain usable on a Samsung Galaxy S26 Ultra.
- The current free brain uses OpenRouter through the Habitat backend. Network/API failures must be reported clearly rather than silently dropping a message.
- DropPilot work should use the known store context when it is relevant rather than inventing new store facts.

You are the intelligence layer coordinating Habitat.

Be direct, natural, practical, detailed when the task warrants it, and honest about what is and is not completed.
`;

    const messages = [
      {
        role: "system",
        content: systemPrompt
      }
    ];

    for (const item of recentHistory) {
      const userMessage = String(
        item?.user || ""
      ).trim();

      const assistantMessage = String(
        item?.assistant || ""
      ).trim();

      if (userMessage) {
        messages.push({
          role: "user",
          content: userMessage
        });
      }

      if (assistantMessage) {
        messages.push({
          role: "assistant",
          content: assistantMessage
        });
      }
    }

    messages.push({
      role: "user",
      content: message
    });

    const response =
      await openRouterChat({
        model,
        messages
      });

    let output =
      response.choices?.[0]?.message?.content || "";

    if (/^usersafety\s*:\s*safe$/i.test(output.trim())) {
      output = "Yes — Ax is online and the Habitat brain is connected. I'm ready to work.";
    }

    if (!output.trim()) {
      return res.status(502).json({
        error: "Habitat brain returned an empty response."
      });
    }

    res.json({
      response: output,
      model,
      provider: "openrouter",
      habitat: "online",
      free_brain: true
    });

  } catch (error) {
    console.error(
      "HABITAT BRAIN ERROR:",
      error
    );

    res.status(500).json({
      error: "Habitat brain error",
      details: String(
        error?.message || error
      )
    });
  }
});

const taskStore = new Map();

const workerRegistry = new Map([
  ["habitat-qa-worker", {
    id: "habitat-qa-worker",
    name: "Habitat QA Worker",
    kind: "model-backed",
    status: apiKey ? "available" : "blocked",
    model,
    capabilities: ["backend-health", "task-execution", "verification-reporting"],
    lastRunAt: null
  }],
  ["dropilot-product-scout", {
    id: "dropilot-product-scout",
    name: "DropPilot Product Scout",
    kind: "specialist",
    status: apiKey ? "available" : "blocked",
    model,
    capabilities: ["product-research", "listing-analysis"],
    lastRunAt: null
  }],
  ["vicecity-topic-scout", {
    id: "vicecity-topic-scout",
    name: "Vice City Topic Scout",
    kind: "specialist",
    status: apiKey ? "available" : "blocked",
    model,
    capabilities: ["topic-research", "content-planning"],
    lastRunAt: null
  }]
]);

function storageSelfTest() {
  const key = "__habitat_storage_probe__";
  const value = { id: makeTaskId(), timestamp: nowIso(), value: "write-read-pass" };
  taskStore.set(key, value);
  const readBack = taskStore.get(key);
  taskStore.delete(key);
  return Boolean(readBack && readBack.value === value.value);
}

function nowIso() { return new Date().toISOString(); }

// Real Android app presence registry. A running Habitat APK posts a heartbeat;
// system checks can verify that the Android client actually reached the backend.
const androidDevices = new Map();
const ANDROID_HEARTBEAT_TTL_MS = 120000;

function pruneAndroidDevices() {
  const cutoff = Date.now() - ANDROID_HEARTBEAT_TTL_MS;
  for (const [id, device] of androidDevices.entries()) {
    if (new Date(device.lastSeenAt).getTime() < cutoff) androidDevices.delete(id);
  }
}

function androidAccessStatus() {
  pruneAndroidDevices();
  const devices = Array.from(androidDevices.values());
  return {
    status: devices.length > 0 ? "PASS" : "UNVERIFIED",
    detail: devices.length > 0
      ? "Live Habitat Android heartbeat received within the last 120 seconds."
      : "No live Habitat Android heartbeat has been received within the last 120 seconds.",
    devices
  };
}
function makeTaskId() {
  return "task-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function runSystemCheck() {
  const checks = {};

  checks.axCore = { status: "PASS", detail: "Habitat chat route is active." };
  checks.backend = { status: "PASS", detail: "Backend request routing is active." };
  checks.brain = { status: apiKey ? "PASS" : "FAIL", detail: apiKey ? "OpenRouter API key is configured." : "OPENROUTER_API_KEY is missing." };

  const worker = workerRegistry.get("habitat-qa-worker");
  checks.workerRegistry = worker
    ? { status: worker.status === "available" ? "PASS" : "FAIL", detail: worker.name + " is registered and " + worker.status + "." }
    : { status: "FAIL", detail: "QA worker is not registered." };

  checks.storage = {
    status: storageSelfTest() ? "PASS" : "FAIL",
    detail: "In-process task storage write/read/delete probe."
  };

  const task = {
    id: makeTaskId(),
    title: "System Check",
    description: "Verify Habitat backend, brain, worker registry, task engine, and storage.",
    status: "running",
    owner: "Ax",
    worker: worker?.id || null,
    createdAt: nowIso(),
    delegatedAt: nowIso(),
    completedAt: null,
    verifiedAt: null,
    result: null,
    error: null
  };
  taskStore.set(task.id, task);

  try {
    const healthResponse = await fetch("http://127.0.0.1:" + port + "/health");
    const health = await healthResponse.json();
    checks.backendHealth = {
      status: healthResponse.ok && health.habitat === "online" && health.backend === "ready" ? "PASS" : "FAIL",
      detail: JSON.stringify(health)
    };

    const androidAccess = androidAccessStatus();
    checks.androidDeviceAccess = {
      status: androidAccess.status,
      detail: androidAccess.detail
    };

    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");

    worker.lastRunAt = nowIso();
    const workerResponse = await openRouterChat({
      model,
      messages: [
        { role: "system", content: "You are Habitat QA Worker reporting to Ax. Return RESULT, CHECKS, and ISSUES. Never claim device access you do not have." },
        { role: "user", content: "Perform a backend-only Habitat System Check. Verify the supplied health response and explain any checks that cannot be verified without Android/device tools. Health: " + JSON.stringify(health) }
      ]
    });
    const result = workerResponse.choices?.[0]?.message?.content || "";
    if (!result.trim()) throw new Error("QA worker returned an empty result.");

    task.result = result;
    task.status = "verified";
    task.completedAt = nowIso();
    task.verifiedAt = nowIso();
    checks.workerExecution = { status: "PASS", detail: "QA worker returned a non-empty verification report." };
  } catch (error) {
    task.status = "failed";
    task.error = String(error?.message || error);
    checks.workerExecution = { status: "FAIL", detail: task.error };
  }

  const failures = Object.entries(checks).filter(([, v]) => v.status === "FAIL");
  const report = [
    "HABITAT SYSTEM CHECK",
    "",
    ...Object.entries(checks).map(([name, v]) => name.toUpperCase() + ": " + v.status + " — " + v.detail),
    "",
    "TASK ENGINE: " + (taskStore.has(task.id) ? "PASS — real task record created (" + task.id + ")" : "FAIL"),
    "OVERALL: " + (failures.length === 0 && task.status === "verified" ? "VERIFIED" : "PARTIAL / BLOCKED"),
    "",
    "WORKER REPORT:",
    task.result || task.error || "No worker report."
  ].join("\n");

  return { task, checks, report };
}

app.get("/workers", (req, res) => {
  return res.json({
    ok: true,
    workers: Array.from(workerRegistry.values()).map(w => ({ ...w }))
  });
});

app.get("/storage/check", (req, res) => {
  const passed = storageSelfTest();
  return res.json({
    ok: passed,
    storage: passed ? "ready" : "failed",
    persistence: "process-local",
    detail: passed ? "write/read/delete passed" : "write/read/delete failed"
  });
});

app.post("/tasks", (req, res) => {
  const title = String(req.body?.title || "").trim();
  const description = String(req.body?.description || title).trim();
  if (!title) return res.status(400).json({ ok: false, error: "title required" });
  const task = {
    id: makeTaskId(), title, description, status: "planned", owner: "Ax",
    worker: null, createdAt: nowIso(), delegatedAt: null,
    completedAt: null, verifiedAt: null, result: null, error: null
  };
  taskStore.set(task.id, task);
  return res.json({ ok: true, task });
});

app.get("/tasks", (req, res) => {
  const tasks = Array.from(taskStore.values())
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return res.json({ ok: true, tasks });
});

app.get("/tasks/:id", (req, res) => {
  const task = taskStore.get(req.params.id);
  if (!task) return res.status(404).json({ ok: false, error: "task not found" });
  return res.json({ ok: true, task });
});

app.post("/tasks/:id/delegate", async (req, res) => {
  const task = taskStore.get(req.params.id);
  if (!task) return res.status(404).json({ ok: false, error: "task not found" });

  if (!apiKey) {
    task.status = "failed";
    task.error = "OPENROUTER_API_KEY is not configured.";
    return res.status(500).json({ ok: false, task });
  }

  task.status = "delegated";
  task.worker = workerRegistry.has("habitat-qa-worker") ? "habitat-qa-worker" : null;
  task.delegatedAt = nowIso();
  task.error = null;
  task.result = null;

  try {
    // Real backend checks first. These verify the service path itself rather
    // than pretending the server has Android/device access.
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const health = await healthResponse.json();
    const healthOk =
      healthResponse.ok &&
      health.habitat === "online" &&
      health.backend === "ready" &&
      health.brain === "ready";

    if (!healthOk) {
      task.status = "failed";
      task.error = "Habitat backend health verification failed.";
      task.result = JSON.stringify({ checks: { backendHealth: health } });
      return res.status(502).json({ ok: false, task });
    }

    // A real model-backed QA worker receives the assignment. It is explicitly
    // forbidden from claiming Android/device access it does not possess.
    const workerResponse = await openRouterChat({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are Habitat QA Worker, a real model-backed worker reporting to Ax. " +
            "Execute the assigned task using only information available in this request. " +
            "Return RESULT, CHECKS, and ISSUES. Never claim Android/device/tool access you do not have. " +
            "If the task requires device access, mark that portion UNVERIFIED rather than pretending it passed."
        },
        {
          role: "user",
          content:
            "Execute this Habitat task:\n" + task.title +
            "\n\n" + task.description +
            "\n\nServer health check already passed: " + JSON.stringify(health)
        }
      ]
    });

    const result = workerResponse.choices?.[0]?.message?.content || "";
    if (!result.trim()) {
      task.status = "failed";
      task.error = "Worker returned an empty result.";
      return res.status(502).json({ ok: false, task });
    }

    const androidAccess = androidAccessStatus();
    task.result = JSON.stringify({
      verification: {
        backendHealth: "PASS",
        modelWorker: "PASS",
        androidDeviceAccess: androidAccess.status
      },
      androidDevice: androidAccess.devices[0] || null,
      workerReport: result
    });

    // Verified means the checks we actually performed passed. It does not
    // mean Android/device access was magically available.
    task.status = "verified";
    task.completedAt = nowIso();
    task.verifiedAt = nowIso();

    return res.json({ ok: true, task });
  } catch (error) {
    task.status = "failed";
    task.error = String(error?.message || error);
    return res.status(502).json({ ok: false, task });
  }
});

app.post("/worker/claude", async (req, res) => {
  try {
    const task = String(req.body?.task || "").trim();

    if (!task) {
      return res.status(400).json({
        ok: false,
        worker: "claude",
        error: "task required"
      });
    }

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        worker: "claude",
        error: "OPENROUTER_API_KEY is not configured on the Habitat server."
      });
    }

    const workerModel = "anthropic/claude-sonnet-5";

    const workerSystemPrompt = `
You are Claude, a specialized worker inside Habitat.

Ax is the central intelligence and manager of Habitat.
You are a delegated worker, not the main brain.

Complete the assigned mission directly.
Return a concise, useful report for Ax.
Do not claim actions you did not actually perform.
If information is missing, state exactly what is missing.

Mission:
`;

    const response = await openRouterChat({
      model: workerModel,
      messages: [
        {
          role: "system",
          content: workerSystemPrompt
        },
        {
          role: "user",
          content: task
        }
      ]
    });

    const output =
      response.choices?.[0]?.message?.content || "";

    return res.json({
      ok: true,
      worker: "claude",
      model: workerModel,
      response: output
    });

  } catch (error) {
    console.error("HABITAT CLAUDE WORKER ERROR:", error);

    return res.status(500).json({
      ok: false,
      worker: "claude",
      error: "Claude worker error",
      details: String(error?.message || error)
    });
  }
});

app.post("/orchestrate/dropilot", async (req, res) => {
  try {
    const mission = String(req.body?.mission || "").trim();
    const storeContext = req.body?.storeContext || {};

    if (!mission) {
      return res.status(400).json({ ok: false, error: "mission required" });
    }

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "OPENROUTER_API_KEY is not configured on the Habitat server."
      });
    }

    const contextText = JSON.stringify(storeContext, null, 2);

    const roles = [
      {
        id: "scout",
        name: "PRODUCT SCOUT",
        mission:
          "Find the strongest product opportunities for DropPilot. Judge demand signals, problem/benefit clarity, margin room, impulse-buy potential, competition risk, shipping simplicity, and TikTok-demo potential. Do not invent live sales data."
      },
      {
        id: "listing",
        name: "LISTING OPTIMIZER",
        mission:
          "Audit the current DropPilot listing and design a conversion-focused title, hook, benefit bullets, offer structure, and product-page changes. Prioritize clarity and mobile/TikTok buyer behavior."
      },
      {
        id: "growth",
        name: "GROWTH OPERATOR",
        mission:
          "Design the fastest realistic path from zero orders to the first sale using free/low-cost TikTok content, creator outreach, offer testing, and a simple daily execution loop. Avoid vague advice."
      }
    ];

    const workerResults = await Promise.all(
      roles.map(async (role) => {
        const response = await openRouterChat({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are " + role.name + ", a specialist worker inside Habitat. " +
                "Ax is the manager. " + role.mission +
                " Return a concise report with: VERDICT, TOP 3 ACTIONS, RISKS, and ONE DATA POINT AX SHOULD VERIFY."
            },
            {
              role: "user",
              content:
                "DropPilot mission:\n" + mission +
                "\n\nCurrent store context:\n" + contextText
            }
          ]
        });

        return {
          id: role.id,
          name: role.name,
          status: "complete",
          response: response.choices?.[0]?.message?.content || ""
        };
      })
    );

    const synthesis = await openRouterChat({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are Ax, the DropPilot operator. Synthesize the worker reports into one execution order. " +
            "The store currently has zero orders. Optimize for getting the first sale, not building a perfect store. " +
            "Never claim an action was completed unless the context confirms it. " +
            "Return exactly these sections: DECISION, DO TODAY, PRODUCT MOVE, CONTENT MOVE, CREATOR MOVE, METRICS."
        },
        {
          role: "user",
          content:
            "MISSION:\n" + mission +
            "\n\nSTORE:\n" + contextText +
            "\n\nWORKER REPORTS:\n" +
            workerResults.map(w => "\n[" + w.name + "]\n" + w.response).join("\n")
        }
      ]
    });

    return res.json({
      ok: true,
      habitat: "online",
      project: "DropPilot AI",
      workers: workerResults,
      synthesis: synthesis.choices?.[0]?.message?.content || ""
    });