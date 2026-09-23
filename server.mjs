import express from "express";
import OpenAI from "openai";

const app = express();

app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 8080;

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.warn("WARNING: OPENAI_API_KEY is not configured.");
}

const client = new OpenAI({
  apiKey
});

/*
 * HABITAT AX CORE BACKEND
 *
 * Endpoints:
 *   GET  /health
 *   POST /chat
 */

app.get("/", (req, res) => {
  res.json({
    habitat: "online",
    brain: "ready",
    message: "Habitat Ax Core backend is running."
  });
});

app.get("/health", (req, res) => {
  res.json({
    habitat: "online",
    brain: apiKey ? "ready" : "missing_api_key",
    backend: "ready",
    model: "gpt-5.6-luna"
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

    const history = Array.isArray(
      req.body?.history
    )
      ? req.body.history
      : [];

    const recentHistory = history.slice(-20);

    const context = recentHistory
      .map(item => {
        const user = String(
          item?.user || ""
        );

        const assistant = String(
          item?.assistant || ""
        );

        return (
          `USER: ${user}\n` +
          `AX: ${assistant}`
        );
      })
      .join("\n\n");

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

Be direct, natural, and useful.
`;

    const prompt = context
      ? `
Previous Habitat conversation:

${context}

CURRENT USER COMMAND:

${message}
`
      : message;

    if (!apiKey) {
      return res.status(500).json({
        error:
          "OPENAI_API_KEY is not configured on the Habitat server."
      });
    }

    const response =
      await client.responses.create({
        model: "gpt-5.6-luna",
        instructions: systemPrompt,
        input: prompt
      });

    const output =
      response.output_text || "";

    res.json({
      response: output,
      model: "gpt-5.6-luna",
      habitat: "online"
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

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `Habitat Ax Core listening on port ${port}`
    );
  }
);
