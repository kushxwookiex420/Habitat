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

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `Habitat Ax Core listening on port ${port}`
    );
  }
);
