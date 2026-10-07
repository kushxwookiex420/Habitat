import express from "express";
import OpenAI from "openai";

const app = express();

app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 8080;

const apiKey = process.env.OPENROUTER_API_KEY;
const model = "openrouter/free";

if (!apiKey) {
  console.warn(
    "WARNING: OPENROUTER_API_KEY is not configured."
  );
}

const client = new OpenAI({
  apiKey,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://habitat-1-szzd.onrender.com",
    "X-Title": "Habitat Ax Core"
  }
});

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
    brain: apiKey ? "ready" : "missing_api_key",
    backend: "ready",
    provider: "openrouter",
    model,
    free_brain: true,
    message: "Habitat Ax Core backend is running."
  });
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
      await client.chat.completions.create({
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

    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");

    worker.lastRunAt = nowIso();
    const workerResponse = await client.chat.completions.create({
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
    const workerResponse = await client.chat.completions.create({
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

    task.result = JSON.stringify({
      verification: {
        backendHealth: "PASS",
        modelWorker: "PASS",
        androidDeviceAccess: "UNVERIFIED"
      },
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

    const response = await client.chat.completions.create({
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
        const response = await client.chat.completions.create({
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

    const synthesis = await client.chat.completions.create({
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
  } catch (error) {
    console.error("DROPPILOT ORCHESTRATION ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: "DropPilot orchestration error",
      details: String(error?.message || error)
    });
  }
});


app.post("/orchestrate/vicecity", async (req, res) => {
  try {
    const mission = String(req.body?.mission || "").trim();
    const channelContext = req.body?.channelContext || {};

    if (!mission) return res.status(400).json({ ok: false, error: "mission required" });
    if (!apiKey) return res.status(500).json({ ok: false, error: "OPENROUTER_API_KEY is not configured on the Habitat server." });

    const contextText = JSON.stringify(channelContext, null, 2);
    const roles = [
      { id: "research", name: "TOPIC SCOUT", job: "Choose the strongest GTA/Vice City story topic using evergreen interest, curiosity, searchability, and visual potential. Never invent current facts." },
      { id: "script", name: "SCRIPT EDITOR", job: "Create a tight 45-90 second narration structure with a strong first 7 seconds, calm delivery, and clear visual beats." },
      { id: "growth", name: "CHANNEL OPERATOR", job: "Create a repeatable free/low-cost publishing loop for YouTube Shorts/TikTok, including title, description idea, and up to five TikTok hashtags." }
    ];

    const reports = await Promise.all(roles.map(async role => {
      const out = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: "You are " + role.name + ", a worker reporting to Ax. " + role.job + " Return VERDICT, TOP 3 ACTIONS, RISKS, and ONE FACT TO VERIFY." },
          { role: "user", content: "Mission:\n" + mission + "\n\nChannel context:\n" + contextText }
        ]
      });
      return { id: role.id, name: role.name, status: "complete", response: out.choices?.[0]?.message?.content || "" };
    }));

    const synth = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are Ax, manager of the Vice City Files content operation. Turn worker reports into an execution-ready content packet. Never claim a video was generated, uploaded, or published unless an actual connected tool confirms it. Return exactly: DECISION, VIDEO CONCEPT, 7-SECOND HOOK, SCRIPT, SHOT LIST, TITLE, DESCRIPTION, HASHTAGS, NEXT ACTION." },
        { role: "user", content: "Mission:\n" + mission + "\n\nContext:\n" + contextText + "\n\nReports:\n" + reports.map(x => "[" + x.name + "]\n" + x.response).join("\n") }
      ]
    });

    return res.json({ ok: true, habitat: "online", project: "Vice City Files", workers: reports, synthesis: synth.choices?.[0]?.message?.content || "", executionState: "planned" });
  } catch (error) {
    console.error("VICE CITY ORCHESTRATION ERROR:", error);
    return res.status(500).json({ ok: false, error: "Vice City orchestration error", details: String(error?.message || error) });
  }
});

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `Habitat Ax Core listening on port ${port}`
    );
  }
);
