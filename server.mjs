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

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `Habitat Ax Core listening on port ${port}`
    );
  }
);
