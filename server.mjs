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

1. DropPilot AI
2. Vice City Files
3. Habitat

Core execution loop:

UNDERSTAND
PLAN
ACT
OBSERVE
VERIFY
STORE RESULT

You are not merely a chatbot.

You are the intelligence layer coordinating Habitat.

Be direct, natural, practical, and useful.
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

    const output =
      response.choices?.[0]?.message?.content || "";

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
