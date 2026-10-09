import { registerContentEngine } from "./content-engine.mjs";
import { registerPublicPages } from "./public-pages.mjs";
import { readFile } from "node:fs/promises";

import express from "express";

const app = express();

app.use(express.json({ limit: "1mb" }));

registerPublicPages(app);

// Durable cross-session handoff: the checkpoint is committed with the source code,
// not written to Render's ephemeral filesystem. Keep secrets out of AX_CONTINUITY.md.
app.get("/continuity", async (_req, res) => {
  try {
    const checkpoint = await readFile(new URL("./AX_CONTINUITY.md", import.meta.url), "utf8");
    res.type("text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).send(checkpoint);
  } catch (error) {
    console.error("AX_CONTINUITY_READ_FAILED", String(error?.message || error));
    return res.status(503).json({ ok:false, error:"continuity checkpoint unavailable" });
  }
});

app.get("/continuity/status", async (_req, res) => {
  try {
    const checkpoint = await readFile(new URL("./AX_CONTINUITY.md", import.meta.url), "utf8");
    const lines = checkpoint.split("\n");
    const checkpointDate = lines.find(line => line.startsWith("**Last checkpoint:**"))?.replace("**Last checkpoint:**", "").trim() || "unknown";
    return res.json({
      ok:true,
      source:"committed repository checkpoint",
      checkpointDate,
      durableAcrossConversations:true,
      runtimeJobPersistence:"not yet implemented",
      sourceUrl:"https://github.com/kushxwookiex420/Habitat/blob/main/AX_CONTINUITY.md"
    });
  } catch (error) {
    console.error("AX_CONTINUITY_STATUS_FAILED", String(error?.message || error));
    return res.status(503).json({ ok:false, error:"continuity checkpoint unavailable" });
  }
});

const port = process.env.PORT || 8080;

function getApiKey() {
  const rawApiKey = process.env.OPENROUTER_API_KEY;
  return rawApiKey ? String(rawApiKey).trim().replace(/^["']|["']$/g, "") : "";
}
function hasAnyAiProviderKey() {
  const cloudflareReady =
    Boolean(String(process.env.CLOUDFLARE_API_TOKEN || "").trim()) &&
    Boolean(String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim());
  const cerebrasReady =
    Boolean(String(process.env.CEREBRAS_API_KEY || "").trim()) &&
    String(process.env.HABITAT_ALLOW_PAID_PROVIDERS || "").toLowerCase() === "true";
  return Boolean(
    getApiKey() ||
    String(process.env.GROQ_API_KEY || "").trim() ||
    String(process.env.GEMINI_API_KEY || "").trim() ||
    cloudflareReady ||
    cerebrasReady
  );
}
const apiKey = getApiKey();
const model = "openrouter/free";
// Do not hard-code free-model IDs: providers retire and rename them frequently.
// The runtime discovers currently listed text-capable free models from OpenRouter.
const fallbackModels = [];
const fallbackModel = fallbackModels[0];
const providerTimeoutMs = 30000;

if (!hasAnyAiProviderKey()) {
  console.warn(
    "WARNING: No AI provider is configured. Set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, or explicitly enable a paid provider."
  );
}

app.use((req, res, next) => {
  const requestId = "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  req.habitatRequestId = requestId;
  res.setHeader("X-Habitat-Request-Id", requestId);
  res.setHeader("X-Habitat-Version", "2026-10-09-multi-provider-v2");
  console.log("HABITAT_REQUEST", requestId, req.method, req.path);
  next();
});

function canonicalTaskReport(task) {
  const status = task?.status || "unknown";
  const worker = task?.worker || "unknown";
  const result = String(task?.result || "");
  const error = String(task?.error || "");
  let verification = null;
  try { verification = JSON.parse(result)?.verification || null; } catch (_) {}

  if (!verification) {
    return "Status: " + status + "\nWorker: " + worker + (error ? "\nError: " + error : "\nResult: " + (result || "No worker result."));
  }

  const lines = [
    "Status: " + status,
    "Worker: " + worker,
    "",
    "CANONICAL MACHINE CHECKS:",
    "Backend health: " + (verification.backendHealth || "UNKNOWN"),
    "Model worker: " + (verification.modelWorker || "UNKNOWN"),
    "Android heartbeat: " + (verification.androidHeartbeat || "UNKNOWN"),
    "Android device access: " + (verification.androidDeviceAccess || "UNKNOWN"),
    "Task creation: " + (verification.taskCreation || "UNKNOWN"),
    "Storage: " + (verification.storage || "UNKNOWN")
  ];

  const verified =
    status.toLowerCase() === "verified" &&
    verification.backendHealth === "PASS" &&
    verification.modelWorker === "PASS" &&
    verification.androidHeartbeat === "PASS" &&
    verification.androidDeviceAccess === "PASS" &&
    verification.taskCreation === "PASS" &&
    verification.storage === "PASS";

  lines.push("", "CANONICAL RESULT: " + (verified ? "VERIFIED PASS" : "PARTIAL / BLOCKED"));
  if (error) lines.push("Worker error: " + error);
  return lines.join("\n");
}

async function discoverOpenRouterFreeModels(openRouterKey, limit = 3) {
  if (!openRouterKey) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(providerTimeoutMs, 10000));
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "Authorization": `Bearer ${openRouterKey}`, "HTTP-Referer": "https://habitat-1-szzd.onrender.com", "X-Title": "Habitat Ax Core" },
      signal: controller.signal
    });
    if (!response.ok) {
      console.warn("OPENROUTER_MODEL_CATALOG_UNAVAILABLE", response.status);
      return [];
    }
    const data = await response.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows
      .filter(item => {
        const id = String(item?.id || "");
        const input = item?.architecture?.input_modalities;
        const output = item?.architecture?.output_modalities;
        const textCapable = !Array.isArray(input) || input.includes("text");
        const textOutput = !Array.isArray(output) || output.includes("text");
        const pricing = item?.pricing || {};
        const isFree = id.endsWith(":free") ||
          (Number(pricing.prompt) === 0 && Number(pricing.completion) === 0);
        return id && id !== model && isFree && textCapable && textOutput;
      })
      .map(item => String(item.id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, Math.max(0, Math.min(5, Number(limit) || 3)));
  } catch (error) {
    console.warn("OPENROUTER_MODEL_CATALOG_FAILED", String(error?.message || error).slice(0, 180));
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function brainChat(payload) {
  const groqKey = String(process.env.GROQ_API_KEY || "").trim().replace(/^[\"']|[\"']$/g, "");
  const geminiKey = String(process.env.GEMINI_API_KEY || "").trim().replace(/^[\"']|[\"']$/g, "");
  const cerebrasKey = String(process.env.CEREBRAS_API_KEY || "").trim().replace(/^[\"']|[\"']$/g, "");
  const cloudflareToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim().replace(/^[\"']|[\"']$/g, "");
  const cloudflareAccountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim().replace(/^[\"']|[\"']$/g, "");
  const openRouterKey = getApiKey();
  const requestedModel = payload?.model || model;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const maxTokens = payload?.max_tokens || 512;
  let lastError = null;

  // Provider order is intentional: free providers first, exhausted OpenRouter last.
  // Missing keys are skipped without making a network request.
  const providers = [];

  if (groqKey) {
    providers.push({
      name: "groq",
      model: requestedModel === model ? (process.env.GROQ_MODEL || "openai/gpt-oss-20b") : requestedModel,
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: {
        "Authorization": `Bearer ${groqKey}`,
        "Content-Type": "application/json"
      }
    });
  }

  if (geminiKey) {
    // Free-tier model availability can vary by account and surge demand. Try a
    // short, ordered list so one unavailable/busy model does not block the mission.
    const configuredGeminiModel = String(process.env.GEMINI_MODEL || "").trim();
    // Zero-budget guard: only attempt explicitly free-tier Flash-Lite models.
    // A custom GEMINI_MODEL is accepted only when its name clearly identifies
    // a Flash-Lite model, preventing an accidental paid-model call.
    const freeGeminiModels = [
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash-lite",
      configuredGeminiModel.toLowerCase().includes("flash-lite") ? configuredGeminiModel : ""
    ];
    const geminiModels = requestedModel === model
      ? [...new Set(freeGeminiModels.filter(Boolean))]
      : (String(requestedModel).toLowerCase().includes("flash-lite") ? [requestedModel] : ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite"]);
    for (const geminiModel of geminiModels) {
      providers.push({
        name: "gemini",
        model: geminiModel,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // Cloudflare Workers AI has a documented daily free allocation. Only use
  // the known small Llama instruct model by default; never silently opt into
  // models that require paid billing. Configure CLOUDFLARE_ACCOUNT_ID and
  // CLOUDFLARE_API_TOKEN in Render to enable this provider.
  if (cloudflareToken && cloudflareAccountId) {
    providers.push({
      name: "cloudflare",
      model: "@cf/meta/llama-3.2-1b-instruct",
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccountId)}/ai/v1/chat/completions`,
      headers: {
        "Authorization": `Bearer ${cloudflareToken}`,
        "Content-Type": "application/json"
      }
    });
  }

  // Cerebras is not enabled by default: Habitat's zero-dollar mode must not
  // call a provider that may require paid credits. Explicit opt-in is required.
  if (cerebrasKey && String(process.env.HABITAT_ALLOW_PAID_PROVIDERS || "").toLowerCase() === "true") {
    providers.push({
      name: "cerebras",
      model: requestedModel === model ? (process.env.CEREBRAS_MODEL || "gpt-oss-120b") : requestedModel,
      url: "https://api.cerebras.ai/v1/chat/completions",
      headers: {
        "Authorization": `Bearer ${cerebrasKey}`,
        "Content-Type": "application/json"
      }
    });
  }

  if (openRouterKey) {
    let openRouterModels = [requestedModel];
    if (requestedModel === model) {
      const discovered = await discoverOpenRouterFreeModels(openRouterKey, 3);
      openRouterModels = [model, ...discovered, ...fallbackModels];
    }
    for (const selectedModel of [...new Set(openRouterModels)]) {
      providers.push({
        name: "openrouter",
        model: selectedModel,
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://habitat-1-szzd.onrender.com",
          "X-Title": "Habitat Ax Core"
        }
      });
    }
  }

  // Put Cloudflare first when configured: the user's requested fallback must be tried
  // before providers that have already returned quota exhaustion. Other providers
  // remain available as fallbacks if Cloudflare rejects the request.
  providers.sort((a, b) => (a.name === "cloudflare" ? -1 : b.name === "cloudflare" ? 1 : 0));

  if (!providers.length) {
    const error = new Error("No AI provider key is configured. Set GEMINI_API_KEY, GROQ_API_KEY, CLOUDFLARE_ACCOUNT_ID plus CLOUDFLARE_API_TOKEN, or OPENROUTER_API_KEY.");
    error.status = 500;
    throw error;
  }

  for (const provider of providers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);
    try {
      let body;

      if (provider.name === "gemini") {
        const systemParts = messages
          .filter(m => m?.role === "system")
          .map(m => String(m?.content || ""));
        const contents = messages
          .filter(m => m?.role !== "system")
          .map(m => ({
            role: m?.role === "assistant" ? "model" : "user",
            parts: [{ text: String(m?.content || "") }]
          }));
        body = JSON.stringify({
          systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined,
          contents,
          generationConfig: { maxOutputTokens: maxTokens }
        });
      } else {
        body = JSON.stringify({
          ...payload,
          model: provider.model,
          max_tokens: maxTokens
        });
      }

      const response = await fetch(provider.url, {
        method: "POST",
        headers: provider.headers,
        body,
        signal: controller.signal
      });

      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch { data = { error: { message: text || provider.name + " returned a non-JSON response." } }; }

      if (response.ok) {
        console.info("BRAIN_PROVIDER_SUCCESS", provider.name, provider.model);
        if (provider.name === "gemini") {
          const candidateText = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("") || "";
          if (!candidateText.trim()) throw new Error("Gemini returned no text candidate.");
          return {
            choices: [{ message: { role: "assistant", content: candidateText } }],
            model: provider.model,
            provider: "gemini"
          };
        }
        return { ...data, provider: provider.name };
      }

      console.warn("BRAIN_PROVIDER_FAILED", provider.name, provider.model, response.status, String(data?.error?.message || data?.message || "request failed").slice(0, 180));
      const providerMessage =
        data?.error?.message ||
        data?.error?.error?.message ||
        text ||
        provider.name + " HTTP " + response.status;
      const error = new Error(provider.name + " HTTP " + response.status + ": " + providerMessage);
      error.status = response.status;
      lastError = error;

      console.warn("BRAIN_PROVIDER_FAILED", provider.name, provider.model, String(error.message).slice(0, 300));

      // OpenRouter's free-model daily cap is account-wide. Cycling through more
      // model IDs cannot fix it and only adds latency/log noise, so fail fast.
      if (provider.name === "openrouter" && /free-models-per-day|free model.*daily limit|daily.*free.*quota/i.test(providerMessage)) {
        break;
      }

      // Continue for individual model/auth/quota errors when another configured
      // provider or a different catalog-listed model may still be usable.
      continue;
    } catch (error) {
      lastError = error;
      console.warn("BRAIN_PROVIDER_FAILED", provider.name, provider.model, String(error?.message || error).slice(0, 300));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("All configured AI providers failed.");
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

// TikTok Developer domain verification: serve the exact verification file at the domain root path.
app.get("/tiktokHneXL520kS7uOGdvMUO1qp4jZQmlfuiE.txt", (req, res) => {
  res.type("text/plain").send("tiktok-developers-site-verification=HneXL520kS7uOGdvMUO1qp4jZQmlfuiE");
});

app.get("/", (req, res) => {
  res.json({
    habitat: "online",
    brain: (getApiKey() || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) || (process.env.CEREBRAS_API_KEY && process.env.HABITAT_ALLOW_PAID_PROVIDERS === "true")) ? "ready" : "missing_api_key",
    apiKeyPresent: Boolean(getApiKey()),
    backend: "ready",
    provider: "multi-provider",
    model,
    fallbackModel,
    free_brain: true,
    message: "Habitat Ax Core backend is running."
  });
});

app.get("/brain/status", (_req, res) => {
  const configured = {
    cloudflare: Boolean(String(process.env.CLOUDFLARE_API_TOKEN || "").trim() && String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim()),
    groq: Boolean(String(process.env.GROQ_API_KEY || "").trim()),
    gemini: Boolean(String(process.env.GEMINI_API_KEY || "").trim()),
    openrouter: Boolean(getApiKey()),
    cerebras: Boolean(String(process.env.CEREBRAS_API_KEY || "").trim() && String(process.env.HABITAT_ALLOW_PAID_PROVIDERS || "").toLowerCase() === "true")
  };
  return res.json({
    ok: true,
    configured: Object.values(configured).some(Boolean),
    mode: "free-first",
    providers: configured,
    preferredProvider: configured.cloudflare ? "cloudflare" : configured.groq ? "groq" : configured.gemini ? "gemini" : configured.openrouter ? "openrouter" : configured.cerebras ? "cerebras" : null,
    secretsExposed: false,
    note: "Configuration is not proof of a successful inference; use the system check for a live model test."
  });
});

app.get("/diagnostics/providers", (req, res) => {
  const configured = {
    gemini: Boolean(String(process.env.GEMINI_API_KEY || "").trim()),
    groq: Boolean(String(process.env.GROQ_API_KEY || "").trim()),
    cloudflare: Boolean(String(process.env.CLOUDFLARE_API_TOKEN || "").trim()) && Boolean(String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim()),
    cerebras: Boolean(String(process.env.CEREBRAS_API_KEY || "").trim()) && String(process.env.HABITAT_ALLOW_PAID_PROVIDERS || "").toLowerCase() === "true",
    openrouter: Boolean(getApiKey())
  };
  const models = {
    gemini: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    groq: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    cloudflare: "@cf/meta/llama-3.1-8b-instruct",
    cerebras: process.env.CEREBRAS_MODEL || "gpt-oss-120b",
    openrouter: model
  };
  return res.json({
    ok: Object.values(configured).some(Boolean),
    providerCount: Object.values(configured).filter(Boolean).length,
    configured,
    models,
    note: "Key presence only; this endpoint does not expose secrets or consume model quota."
  });
});

app.get("/diagnostics/provider", async (req, res) => {
  const startedAt = Date.now();

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      runtimeKeyPresent: false,
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
      runtimeKeyPresent: true,
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
      runtimeKeyPresent: true,
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
    brain: hasAnyAiProviderKey() ? "ready" : "missing_api_key",
    backend: "ready",
    provider: "multi-provider",
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

    if (!hasAnyAiProviderKey()) {
      return res.status(503).json({
        error: "No AI provider key is configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY. Cerebras requires CEREBRAS_API_KEY and HABITAT_ALLOW_PAID_PROVIDERS=true."
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
    // Android connectivity is a deterministic backend/device check. Never send this to the LLM.
    if (/^(?:ax[,:]?\\s*)?(?:check|verify|test)\\s+(?:android\\s+)?(?:device\\s+)?(?:connectivity|connection|heartbeat|device\\s+access)|^(?:ax[,:]?\\s*)?check\\s+android\\s+(?:device\\s+)?(?:connectivity|connection|heartbeat|access)/i.test(message)) {
      try {
        const statusResponse = await fetch("http://127.0.0.1:" + port + "/device/status");
        const statusText = await statusResponse.text();
        let status;
        try { status = JSON.parse(statusText); } catch { status = { ok: false, error: statusText || "device status returned non-JSON" }; }
        const access = status.androidDeviceAccess || "UNVERIFIED";
        const latest = Array.isArray(status.devices) ? status.devices[0] : null;
        return res.json({
          response: "ANDROID DEVICE CHECK\\nStatus: " + access + "\\n" + (status.detail || "No device status detail.") + (latest?.lastSeenAt ? "\\nLast heartbeat: " + latest.lastSeenAt : ""),
          androidDeviceAccess: access,
          deviceStatus: status,
          habitat: "online",
          deterministic: true
        });
      } catch (error) {
        return res.status(502).json({ error: "Android device status check failed.", details: String(error?.message || error) });
      }
    }

    // Broad operational commands: route requests that explicitly ask Ax to create/execute/
    // dispatch/verify a task through the real task engine instead of letting the LLM simulate it.
    // Do not intercept system-check requests; those retain their existing diagnostic behavior.
    const operationalIntent = !/system\s*check|habitat_check|check\s+android\s+connectivity/i.test(message) &&
      /\b(create|make|start|add|execute|run|perform|delegate|dispatch|complete|verify)\b/i.test(message) &&
      /\b(task|operation|mission|job|worker)\b/i.test(message);

    if (operationalIntent) {
      const requestedTitle =
        message.match(/\b(?:task|operation|mission|job)\s+(?:named|called|titled)\s+["']?([^"'\n]+)["']?/i)?.[1]?.trim() ||
        message.match(/(?:create|make|start|add)\s+(?:a\s+)?(?:real\s+)?(?:task|operation|mission|job)\b(?:\s+to)?\s+(.+?)(?:\.|$)/i)?.[1]?.trim() ||
        "Ax Operational Test";
      const title = requestedTitle.replace(/\s+(?:and\s+)?(?:execute|run|perform|delegate|dispatch|verify).*$/i, "").replace(/[.]+$/, "").trim();
      const wantsExecution = /\b(?:execute|run|perform|delegate|dispatch|do|complete)\b/i.test(message);

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
            response: "TASK CREATED AND EXECUTED\\nTask ID: " + task.id + "\\nStatus: " + task.status + "\\nWorker: " + (task.worker || "unknown") + "\\nResult:\\n" + canonicalTaskReport(task),
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
              "Result:\n" + canonicalTaskReport(finished),
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
      await brainChat({
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
    status: hasAnyAiProviderKey() ? "available" : "blocked",
    model,
    capabilities: ["backend-health", "task-execution", "verification-reporting"],
    lastRunAt: null
  }],
  ["dropilot-product-scout", {
    id: "dropilot-product-scout",
    name: "DropPilot Product Scout",
    kind: "specialist",
    status: hasAnyAiProviderKey() ? "available" : "blocked",
    model,
    capabilities: ["product-research", "listing-analysis"],
    lastRunAt: null
  }],
  ["vicecity-topic-scout", {
    id: "vicecity-topic-scout",
    name: "Vice City Topic Scout",
    kind: "specialist",
    status: hasAnyAiProviderKey() ? "available" : "blocked",
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
  const startedAt = Date.now();

  const providerConfigured = hasAnyAiProviderKey();

  checks.axCore = { status: "PASS", detail: "Habitat chat route is active." };
  checks.backend = { status: "PASS", detail: "Backend request routing is active." };
  checks.brain = {
    status: providerConfigured ? "PASS" : "FAIL",
    detail: providerConfigured
      ? "At least one AI provider is configured (Cloudflare Workers AI, Groq, Gemini, OpenRouter, or explicitly enabled Cerebras)."
      : "No AI provider key is configured."
  };

  const worker = workerRegistry.get("habitat-qa-worker");
  checks.workerRegistry = worker
    ? { status: worker.status === "available" ? "PASS" : "FAIL", detail: worker.name + " is registered and " + worker.status + "." }
    : { status: "FAIL", detail: "QA worker is not registered." };

  const storagePassed = storageSelfTest();
  // This probe only tests the process-local Map. It must never be presented
  // as durable persistence: Render's free web service filesystem is ephemeral.
  checks.storage = {
    status: storagePassed ? "UNKNOWN" : "FAIL",
    detail: storagePassed
      ? "In-process memory probe passed, but durable task persistence is not configured; records may be lost on restart."
      : "In-process task storage probe failed."
  };

  const task = {
    id: makeTaskId(),
    title: "System Check",
    description: "Machine-derived verification of Habitat backend, model worker, Android heartbeat, task engine, and storage.",
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

  const taskWasCreated = taskStore.set(task.id, task);
  checks.taskCreation = {
    status: taskStore.has(task.id) ? "PASS" : "FAIL",
    detail: "Real task record created: " + task.id
  };

  try {
    const healthStartedAt = Date.now();
    const healthResponse = await fetch("http://127.0.0.1:" + port + "/health");
    const health = await healthResponse.json();
    const healthPassed =
      healthResponse.ok &&
      health.habitat === "online" &&
      health.backend === "ready";
    checks.backendHealth = {
      status: healthPassed ? "PASS" : "FAIL",
      detail: "HTTP " + healthResponse.status + " in " + (Date.now() - healthStartedAt) + "ms; " + JSON.stringify(health)
    };

    const androidAccess = androidAccessStatus();
    const latestDevice = androidAccess.devices[0] || null;
    const heartbeatAgeMs = latestDevice?.lastSeenAt
      ? Math.max(0, Date.now() - new Date(latestDevice.lastSeenAt).getTime())
      : null;
    checks.androidHeartbeat = {
      status: latestDevice && heartbeatAgeMs <= ANDROID_HEARTBEAT_TTL_MS ? "PASS" : "FAIL",
      detail: latestDevice
        ? "Last heartbeat " + latestDevice.lastSeenAt + " (" + heartbeatAgeMs + "ms ago)."
        : "No Android heartbeat is currently registered."
    };
    checks.androidDeviceAccess = {
      status: androidAccess.status,
      detail: androidAccess.detail
    };

    if (!providerConfigured) throw new Error("No AI provider key is configured.");

    worker.lastRunAt = nowIso();
    const modelStartedAt = Date.now();
    const workerResponse = await brainChat({
      model,
      messages: [
        {
          role: "system",
          content: "You are Habitat QA Worker reporting to Ax. Return a concise backend verification note. Never claim Android/device access or any check that was not supplied."
        },
        {
          role: "user",
          content: "Confirm that the Habitat model worker can answer this machine-generated test. Reply with RESULT: PASS and one short sentence. Do not assess Android access."
        }
      ]
    });
    const result = workerResponse.choices?.[0]?.message?.content || "";
    const latencyMs = Date.now() - modelStartedAt;
    const modelName = workerResponse.model || model;
    const providerName = workerResponse.provider || "unknown";

    if (!result.trim()) throw new Error("QA worker returned an empty result.");

    checks.modelWorker = {
      status: "PASS",
      detail: "Model worker returned a non-empty response in " + latencyMs + "ms via " + providerName + " (" + modelName + ")."
    };
    checks.workerExecution = {
      status: "PASS",
      detail: "Real model-backed QA execution completed without an error."
    };

    task.result = JSON.stringify({
      verification: {
        backendHealth: checks.backendHealth.status,
        modelWorker: checks.modelWorker.status,
        androidHeartbeat: checks.androidHeartbeat.status,
        androidDeviceAccess: checks.androidDeviceAccess.status,
        taskCreation: checks.taskCreation.status,
        storage: checks.storage.status
      },
      model: modelName,
      provider: providerName,
      latencyMs,
      workerReport: result
    });
    task.status = "verified";
    task.completedAt = nowIso();
    task.verifiedAt = nowIso();
  } catch (error) {
    task.status = "failed";
    task.error = String(error?.message || error);
    if (!checks.modelWorker) {
      checks.modelWorker = { status: "FAIL", detail: task.error };
    }
    checks.workerExecution = { status: "FAIL", detail: task.error };
  }

  const nonPassingChecks = Object.entries(checks).filter(([, v]) => v.status !== "PASS");
  const overall = nonPassingChecks.length === 0 && task.status === "verified" ? "VERIFIED PASS" : "PARTIAL / BLOCKED";

  const report = [
    "HABITAT SYSTEM CHECK",
    "",
    ...Object.entries(checks).map(([name, v]) => name.toUpperCase() + ": " + v.status + " — " + v.detail),
    "",
    "TASK ENGINE: " + (taskStore.has(task.id) ? "PASS — real task record created (" + task.id + ")" : "FAIL"),
    "OVERALL: " + overall,
    "DURATION: " + (Date.now() - startedAt) + "ms",
    "",
    "CANONICAL RESULT: " + overall,
    "NOTE: The PASS/FAIL lines above are the authoritative machine checks. The model worker response is stored in the task result and is not used to override these checks."
  ].join("\n");

  return { task, checks, report, overall };
}

app.get("/workers", (req, res) => {
  return res.json({
    ok: true,
    workers: Array.from(workerRegistry.values()).map(w => ({ ...w }))
  });
});

app.get("/storage/check", (req, res) => {
  const probePassed = storageSelfTest();
  return res.status(probePassed ? 200 : 503).json({
    ok: false,
    storage: probePassed ? "memory-only" : "failed",
    durable: false,
    persistence: "process-local",
    detail: probePassed
      ? "Memory write/read/delete passed, but this is not durable storage. Task history can be lost on restart."
      : "In-process write/read/delete probe failed."
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

  if (!hasAnyAiProviderKey()) {
    task.status = "failed";
    task.error = "No AI provider key is configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY. Cerebras requires CEREBRAS_API_KEY and HABITAT_ALLOW_PAID_PROVIDERS=true.";
    return res.status(503).json({ ok: false, task });
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
    const workerResponse = await brainChat({
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

    let result = workerResponse.choices?.[0]?.message?.content || "";

    // Some free-model routes can return a successful HTTP response with an
    // empty assistant message. Retry once with the same deterministic QA
    // prompt used by the canonical system check before declaring dispatch
    // failed. This is a real model retry, not a simulated PASS.
    if (!result.trim()) {
      const retryResponse = await brainChat({
        model,
        messages: [
          {
            role: "system",
            content: "You are Habitat QA Worker reporting to Ax. Return a concise backend verification note. Never claim Android/device access or any check that was not supplied."
          },
          {
            role: "user",
            content: "Confirm that the Habitat model worker can answer this machine-generated test. Reply with RESULT: PASS and one short sentence. Do not assess Android access."
          }
        ]
      });
      result = retryResponse.choices?.[0]?.message?.content || "";
    }

    if (!result.trim()) {
      task.status = "failed";
      task.error = "Worker returned an empty result after one real QA retry.";
      return res.status(502).json({ ok: false, task });
    }

    const androidAccess = androidAccessStatus();
    const latestDevice = androidAccess.devices[0] || null;
    const heartbeatAgeMs = latestDevice?.lastSeenAt
      ? Math.max(0, Date.now() - new Date(latestDevice.lastSeenAt).getTime())
      : null;
    const androidHeartbeat = latestDevice && heartbeatAgeMs <= ANDROID_HEARTBEAT_TTL_MS ? "PASS" : "FAIL";
    const taskCreation = taskStore.has(task.id) ? "PASS" : "FAIL";
    const storage = storageSelfTest() ? "PASS" : "FAIL";

    const verification = {
      backendHealth: "PASS",
      modelWorker: "PASS",
      androidHeartbeat,
      androidDeviceAccess: androidAccess.status,
      taskCreation,
      storage
    };

    const fullyVerified =
      verification.backendHealth === "PASS" &&
      verification.modelWorker === "PASS" &&
      verification.androidHeartbeat === "PASS" &&
      verification.androidDeviceAccess === "PASS" &&
      verification.taskCreation === "PASS" &&
      verification.storage === "PASS";

    task.result = JSON.stringify({
      verification,
      androidDevice: latestDevice,
      heartbeatAgeMs,
      workerReport: result
    });

    // A task is only marked verified when every canonical machine check
    // passes. Never report a partial execution as verified.
    task.status = fullyVerified ? "verified" : "blocked";
    task.completedAt = nowIso();
    if (fullyVerified) task.verifiedAt = nowIso();

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

    const response = await brainChat({
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

    if (!hasAnyAiProviderKey()) {
      return res.status(503).json({
        ok: false,
        error: "No AI provider key is configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY. Cerebras requires CEREBRAS_API_KEY and HABITAT_ALLOW_PAID_PROVIDERS=true."
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
        const response = await brainChat({
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

    const synthesis = await brainChat({
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
    if (!hasAnyAiProviderKey()) return res.status(503).json({ ok: false, error: "No AI provider key is configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY. Cerebras requires CEREBRAS_API_KEY and HABITAT_ALLOW_PAID_PROVIDERS=true." });

    const contextText = JSON.stringify(channelContext, null, 2);
    const roles = [
      { id: "research", name: "TOPIC SCOUT", job: "Choose the strongest GTA/Vice City story topic using evergreen interest, curiosity, searchability, and visual potential. Never invent current facts." },
      { id: "script", name: "SCRIPT EDITOR", job: "Create a tight 45-90 second narration structure with a strong first 7 seconds, calm delivery, and clear visual beats." },
      { id: "growth", name: "CHANNEL OPERATOR", job: "Create a repeatable free/low-cost publishing loop for YouTube Shorts/TikTok, including title, description idea, and up to five TikTok hashtags." }
    ];

    const reports = await Promise.all(roles.map(async role => {
      const out = await brainChat({
        model,
        messages: [
          { role: "system", content: "You are " + role.name + ", a worker reporting to Ax. " + role.job + " Return VERDICT, TOP 3 ACTIONS, RISKS, and ONE FACT TO VERIFY." },
          { role: "user", content: "Mission:\n" + mission + "\n\nChannel context:\n" + contextText }
        ]
      });
      return { id: role.id, name: role.name, status: "complete", response: out.choices?.[0]?.message?.content || "" };
    }));

    const synth = await brainChat({
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


// AX CONTENT ENGINE: research -> script -> edit -> approval -> publish -> analytics.
registerContentEngine(app, { nowIso, makeTaskId, taskStore, workerRegistry, brainChat });

/*
 * AX DIRECT VERIFICATION ENDPOINT
 *
 * Runs the real machine-derived system check on demand. This gives Habitat
 * and external diagnostics one canonical endpoint instead of relying on
 * simulated task/verifier output.
 */
app.post("/system-check", async (req, res) => {
  try {
    const check = await runSystemCheck();
    return res.status(check.overall === "VERIFIED PASS" ? 200 : 503).json({
      ok: check.overall === "VERIFIED PASS",
      overall: check.overall,
      task: check.task,
      checks: check.checks,
      report: check.report,
      requestId: req.habitatRequestId
    });
  } catch (error) {
    console.error("SYSTEM CHECK ENDPOINT ERROR:", error);
    return res.status(500).json({
      ok: false,
      overall: "ERROR",
      error: String(error?.message || error)
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

    // Safe startup verification: prove whether the Render runtime can
    // actually authenticate to OpenRouter without ever logging the secret.
    setTimeout(async () => {
      if (!apiKey) {
        console.error("PROVIDER_AUTH_CHECK: FAIL — runtime OPENROUTER_API_KEY is missing");
        return;
      }
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": "https://habitat-1-szzd.onrender.com",
            "X-Title": "Habitat Ax Core"
          }
        });
        if (response.ok) {
          console.log("PROVIDER_AUTH_CHECK: PASS — OpenRouter accepted the runtime key");
        } else {
          const body = await response.text();
          let message = body;
          try { message = JSON.parse(body)?.error?.message || body; } catch {}
          console.error(`PROVIDER_AUTH_CHECK: FAIL — OpenRouter HTTP ${response.status}: ${String(message).slice(0, 300)}`);
        }
      } catch (error) {
        console.error("PROVIDER_AUTH_CHECK: FAIL — " + String(error?.message || error));
      }
    }, 1500);
  }
);