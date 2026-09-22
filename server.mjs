import express from "express";
import OpenAI from "openai";

const app = express();

app.use(express.json({ limit: "1mb" }));

const port =
  process.env.PORT || 8080;

const client =
  new OpenAI({
    apiKey:
      process.env.OPENAI_API_KEY
  });

app.get("/health", (req, res) => {

  res.json({
    habitat: "online",
    brain: "ready",
    backend: "ready"
  });

});

app.post("/chat", async (req, res) => {

  try {

    const message =
      String(
        req.body?.message || ""
      ).trim();

    if (!message) {

      return res.status(400).json({
        error: "message required"
      });

    }

    const history =
      Array.isArray(
        req.body?.history
      )
        ? req.body.history
        : [];

    const recentHistory =
      history.slice(-20);

    const context =
      recentHistory
        .map(item =>
          `USER: ${item.user}\nAUDREY: ${item.assistant}`
        )
        .join("\n\n");

    const prompt =
      context
        ? `Previous Habitat memory:\n\n${context}\n\nUSER NOW:\n${message}`
        : message;

    const response =
      await client.responses.create({

        model:
          "gpt-5.6-luna",

        instructions:
          "You are Audrey, the AI companion and intelligence layer for Habitat. Be helpful, direct, natural, and remember that Habitat is the user's personal AI environment.",

        input:
          prompt
      });

    res.json({
      response:
        response.output_text
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        "AI backend error"
    });

  }

});

app.listen(
  port,
  "0.0.0.0",
  () => {

    console.log(
      `Habitat backend listening on ${port}`
    );

  }
);
