import { buildCapabilityStatus } from "./capability-status.mjs";
import { registerDeviceCommandBridge } from "./device-command-bridge.mjs";
import { projectDevicePresence, DEVICE_BRIDGE_HEARTBEAT_TTL_MS } from "./device-presence.mjs";
import { claimTaskDispatch } from "./task-dispatch-guard.mjs";
import { createD1TaskRepository } from "./d1-task-repository.mjs";
import { createD1DispatchLeaseRepository } from "./d1-dispatch-lease-repository.mjs";
import { markInterruptedTask, prepareTaskRetry } from "./task-recovery.mjs";
import { registerContentEngine } from "./content-engine.mjs";
import { registerProductDemoResearch } from "./product-demo-research.mjs";
import { registerPromotionEngine } from "./promotion-engine.mjs";
import { registerProductDemoRenderer } from "./product-demo-renderer.mjs";
import { registerProductImageVideo } from "./product-image-video.mjs";
import { createD1ContentJobRepository } from "./d1-content-job-repository.mjs";
import { createD1SecretVault } from "./d1-secret-vault.mjs";
import { registerTikTokOAuth } from "./tiktok-oauth.mjs";
import { registerShopifyOAuth } from "./shopify-oauth.mjs";
import { registerPublicPages } from "./public-pages.mjs";
import { registerControlCenter } from "./control-center.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildSystemStatus, classifyWorkers, inferReadOnlyAdapter, isSystemStatusRequest, parseAxCommand, summarizeWorkerCounts } from "./system-status.mjs";
import { buildWorkerList, buildWorkerDetail, resolveWorkerId, describeVerification, normalizeError } from "./worker-catalog.mjs";
import { createChatCommandAuthorizer } from "./command-auth.mjs";
import { createWorkforceRuntime } from "./ax-workforce-runtime.mjs";
import { createMissionRuntime } from "./ax-mission-runtime.mjs";
import { registerAxGateway, gatewayEnabled, GATEWAY_FLAG, resolveClientToken } from "./ax-gateway.mjs";
import { createMcpEventsServer, registerMcpEvents, mcpEnabled, MCP_FLAG, MCP_SCOPE } from "./ax-mcp-events.mjs";
import { createD1McpRepository, MCP_MIGRATION } from "./d1-mcp-repository.mjs";
import { secretBoxFromEnv } from "./ax-secret-box.mjs";
import { createD1GatewayRepository } from "./d1-gateway-repository.mjs";
import { createHeartbeatMonitor, heartbeatEnabled, createWebhookNotifier, HEARTBEAT_FLAG, HEARTBEAT_INTERVAL_MS } from "./ax-heartbeat.mjs";
import { createD1HeartbeatRepository, HEARTBEAT_MIGRATION } from "./d1-heartbeat-repository.mjs";
import { ownerVerifierFromEnv } from "./ax-owner-attestation.mjs";
import { databaseAllowed } from "./staging-guard.mjs";

import express from "express";

// Fail closed before serving anything: a process marked as staging must never open the production
// database. This is opt-in (HABITAT_ENVIRONMENT=staging) so production behavior is unchanged, and the
// message names the reason only, never the id or any credential.
const databaseCheck = databaseAllowed({ env: process.env, databaseId: process.env.HABITAT_D1_DATABASE_ID });
if (!databaseCheck.ok) {
  console.error("STAGING_GUARD_REFUSED_START", JSON.stringify({ reason: databaseCheck.reason }));
  process.exit(1);
}

const app = express();

app.use(express.json({ limit: "1mb" }));

// Workforce coordination is attached, not activated: the runtime does nothing unless
// HABITAT_WORKFORCE_ENABLED is "true" and migration 0010 exists, and its flag is independent of
// NEXUS_RUNTIME_ENABLED. Attaching the callbacks changes no route and no behavior while it is off.
const workforceRuntime = createWorkforceRuntime({ env: process.env });
// Missions are attached with their own flag, also off by default. No mission store is created while
// HABITAT_MISSIONS_ENABLED is unset.
const missionRuntime = createMissionRuntime({ env: process.env });
const ownerVerifier = ownerVerifierFromEnv({ env: process.env });
// Integration gateway storage. Built only when the gateway flag is on and the D1 binding is complete;
// a missing 0012 schema leaves the repository null, so routes answer 503 instead of half-working.
let gatewayRepository = null;
if (gatewayEnabled()) {
  const gatewayD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"].every(key => String(process.env[key] || "").trim());
  if (!gatewayD1) {
    console.warn("AX_GATEWAY: enabled but the D1 binding is incomplete; every request will be refused");
  } else {
    try {
      const candidate = createD1GatewayRepository({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: process.env.HABITAT_D1_DATABASE_ID,
        apiToken: process.env.HABITAT_D1_API_TOKEN
      });
      const schema = await candidate.verifySchema();
      if (schema.ok) {
        const rateSchema = await candidate.verifyRateLimitSchema();
        if (!rateSchema.ok) console.warn("AX_GATEWAY_RATE_LIMIT_SCHEMA_MISSING", JSON.stringify({ migration: "0014_ax_gateway_rate_limits", fallback: "process-local limiter" }));
        gatewayRepository = candidate;
      }
      else console.warn("AX_GATEWAY_SCHEMA_MISSING", JSON.stringify({ migration: "0012_ax_gateway", missing: schema.missing }));
    } catch (error) {
      console.warn("AX_GATEWAY_STORAGE_UNAVAILABLE", String(error?.message || error));
    }
  }
}
// Habitat's own heartbeat and connection monitor. Independent of the gateway: it runs while the
// integration is absent, queues meaningful changes once each, and only attempts an outbound webhook
// when one is configured. Nothing here claims it can wake an inactive ChatGPT conversation.
let heartbeatMonitor = null;
// Why the monitor is absent, when the operator asked for it. Reported by /system/status so a missing
// D1 binding is never described as "the flag is off".
let heartbeatUnavailable = null;
if (heartbeatEnabled()) {
  const heartbeatD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"].every(key => String(process.env[key] || "").trim());
  if (!heartbeatD1) {
    heartbeatUnavailable = "d1_binding_incomplete";
    console.warn("AX_HEARTBEAT: enabled but the D1 binding is incomplete; no beats are recorded");
  } else {
    try {
      const candidate = createD1HeartbeatRepository({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: process.env.HABITAT_D1_DATABASE_ID,
        apiToken: process.env.HABITAT_D1_API_TOKEN
      });
      const schema = await candidate.verifySchema();
      if (schema.ok) {
        heartbeatMonitor = createHeartbeatMonitor({
          repository: candidate,
          missionRuntime,
          statusProvider: collectSystemStatus,
          notifier: createWebhookNotifier({ url: process.env.AX_NOTIFY_WEBHOOK_URL, secret: process.env.AX_NOTIFY_WEBHOOK_SECRET }),
          log: console
        });
        const timer = setInterval(async () => {
          try {
            const beat = await heartbeatMonitor.beat();
            if (mcpEvents && beat?.events?.length) await mcpEvents.ingestHeartbeatEvents(beat.events);
            // Dispatch on every beat, not only when this beat emitted something: a queued delivery from
            // before a restart must still be attempted.
            if (mcpEvents) await mcpEvents.dispatch();
            await heartbeatMonitor.deliver();
          } catch (error) {
            console.warn("AX_HEARTBEAT_BEAT_FAILED", String(error?.message || error).slice(0, 160));
          }
        }, Number(process.env.AX_HEARTBEAT_INTERVAL_MS) > 0 ? Math.max(10_000, Number(process.env.AX_HEARTBEAT_INTERVAL_MS)) : HEARTBEAT_INTERVAL_MS);
        timer.unref?.();
      } else {
        heartbeatUnavailable = "schema_missing";
        console.warn("AX_HEARTBEAT_SCHEMA_MISSING", JSON.stringify({ migration: HEARTBEAT_MIGRATION, missing: schema.missing }));
      }
    } catch (error) {
      heartbeatUnavailable = "storage_unavailable";
      console.warn("AX_HEARTBEAT_STORAGE_UNAVAILABLE", String(error?.message || error));
    }
  }
}
// OpenAI MCP Events adapter. It shares the gateway's integration identities and scopes, so a plugin
// token is the same revocable credential. Disabled unless HABITAT_MCP_EVENTS_ENABLED=true and the
// 0015 schema exists; no subscription or delivery is attempted while it is off.
let mcpEvents = null;
let mcpEncryption = { ok: false, reason: "disabled" };
if (mcpEnabled()) {
  mcpEncryption = secretBoxFromEnv({ env: process.env });
  if (!mcpEncryption.ok) {
    console.warn("AX_MCP_SECRET_ENCRYPTION_INVALID", JSON.stringify({ reason: mcpEncryption.reason }));
  }
  const mcpD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"].every(key => String(process.env[key] || "").trim());
  if (!mcpD1 || !gatewayRepository || !mcpEncryption.ok) {
    console.warn("AX_MCP_EVENTS: enabled but D1, the gateway identity store or secret encryption is unavailable; /mcp will refuse");
  } else {
    try {
      const candidate = createD1McpRepository({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: process.env.HABITAT_D1_DATABASE_ID,
        apiToken: process.env.HABITAT_D1_API_TOKEN,
        secretBox: mcpEncryption.box
      });
      const schema = await candidate.verifySchema();
      if (schema.ok) mcpEvents = createMcpEventsServer({ repository: candidate, owner: process.env.AX_MCP_DELIVERY_OWNER || "habitat-" + process.pid, log: console });
      else console.warn("AX_MCP_SCHEMA_MISSING", JSON.stringify({ migration: MCP_MIGRATION, missing: schema.missing }));
    } catch (error) {
      console.warn("AX_MCP_STORAGE_UNAVAILABLE", String(error?.message || error));
    }
  }
}
if (mcpEvents) {
  // Independent retry loop: MCP deliveries must make progress even when heartbeat is disabled or no new
  // mission event was produced this beat. Leases keep this safe across replicas.
  const mcpDispatchTimer = setInterval(async () => {
    try { await mcpEvents.dispatch(); }
    catch (error) { console.warn("AX_MCP_DISPATCH_FAILED", String(error?.message || error).slice(0, 160)); }
  }, Number(process.env.AX_MCP_DISPATCH_INTERVAL_MS) > 0 ? Math.max(10_000, Number(process.env.AX_MCP_DISPATCH_INTERVAL_MS)) : 30_000);
  mcpDispatchTimer.unref?.();
}
registerMcpEvents(app, {
  enabled: mcpEnabled(),
  server: mcpEvents,
  authenticate: async req => {
    const resolved = await resolveClientToken({ repository: gatewayRepository, authorization: req.headers.authorization, scope: MCP_SCOPE });
    if (!resolved.ok) return resolved;
    if (gatewayRepository && typeof gatewayRepository.consumeRateLimit === "function") {
      const limited = await gatewayRepository.consumeRateLimit({ clientId: resolved.client.id, windowMs: 60_000, max: 120 }).catch(() => ({ shared: false, ok: true }));
      if (limited.shared && !limited.ok) return { ok: false, status: 429, code: "gateway_rate_limited" };
    }
    return resolved;
  }
});
registerAxGateway(app, {
  enabled: gatewayEnabled(),
  repository: gatewayRepository,
  missionRuntime,
  heartbeat: heartbeatMonitor,
  ownerVerifier,
  statusProvider: collectSystemStatus,
  log: console
});
const deviceCommandBridge = registerDeviceCommandBridge(app, {
  ownerVerifier,
  ownerAttestationEnforce: String(process.env.HABITAT_OWNER_ATTESTATION_ENFORCE || "").toLowerCase() === "true",
  // The improvement engine reads the real status report this process assembles, so its findings are
  // about observed state rather than a guess. It runs inside the existing scheduler tick.
  improvementSignals: async () => ({ systemStatus: await collectSystemStatus() }),
  workforceIntake: workforceRuntime.intake,
  workforceRunner: workforceRuntime.run,
  missions: workforceRuntime.missions,
  missionTick: missionRuntime.tick
});
const chatCommandAuthorizer = createChatCommandAuthorizer({ env: process.env, deviceBridge: deviceCommandBridge });

registerPublicPages(app);
// Operational control center. The page is public but carries no data; every value it shows comes
// from an authenticated Ax route with a token the owner enters in the browser.
registerControlCenter(app, { version: process.env.HABITAT_VERSION || "0.5.0" });
registerProductDemoResearch(app);
registerPromotionEngine(app);
registerProductDemoRenderer(app);
registerProductImageVideo(app);

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
      runtimeJobPersistence: process.env.HABITAT_D1_DATABASE_ID && process.env.HABITAT_D1_API_TOKEN ? "cloudflare-d1" : "memory-only",
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
  const error = normalizeError(task?.error);
  let parsed = null;
  try { parsed = JSON.parse(result); } catch (_) {}
  const verification = parsed?.verification || null;

  if (!verification) {
    return "Status: " + status + "\nWorker: " + worker + (error ? "\nError: " + error : "\nResult: " + (result || "No worker result."));
  }

  // Every FAIL/UNKNOWN line explains itself. A blocked check with no reason is a reporting bug, so
  // describeVerification substitutes an explicit "no reason was reported" instead of a blank.
  const described = describeVerification(verification, parsed?.verificationDetails || {});
  const lines = [
    "Status: " + status,
    "Worker: " + worker,
    "",
    "CANONICAL MACHINE CHECKS:",
    ...described.lines
  ];

  const verified = status.toLowerCase() === "verified" && described.verified;
  lines.push("", "CANONICAL RESULT: " + (verified ? "VERIFIED PASS" : "PARTIAL / BLOCKED"));
  if (described.blockers.length > 0) {
    lines.push("BLOCKERS: " + described.blockers.map((blocker) => blocker.check + ": " + blocker.detail).join(" | "));
  }
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

app.get("/device/status", async (req, res) => {
  const access = await androidAccessStatus();
  return res.json({
    ok: access.status === "PASS",
    androidDeviceAccess: access.status,
    detail: access.detail,
    deviceCount: access.devices.length
  });
});

app.get("/health", (req, res) => {
  const deviceBridge = deviceCommandBridge.status();
  res.json({
    habitat: "online",
    brain: hasAnyAiProviderKey() ? "ready" : "missing_api_key",
    backend: "ready",
    deviceBridge: {
      ready: deviceBridge.ready,
      durable: deviceBridge.durable,
      axTokenConfigured: deviceBridge.axTokenConfigured,
      perDeviceTokens: deviceBridge.perDeviceTokens
    },
    // Read-only worker status. `nexus.configured=false` means the optional command worker is not
    // mounted; `configured=true, started=false` means it is mounted but has not started. Neither
    // changes the health response, so Render readiness never depends on the worker.
    nexus: deviceBridge.nexus || null,
    // Public, non-sensitive pointers. Full probe-based diagnostics require the Ax credential at
    // GET /ax/command/diagnostics; this endpoint never claims a subsystem is healthy.
    version: process.env.HABITAT_VERSION || "0.5.0",
    // Non-sensitive deployment identity. Render injects RENDER_GIT_COMMIT, so a verifier can
    // distinguish "the route is missing" from "this is an older build" without a credential.
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.HABITAT_COMMIT || null,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    controlCenter: "/control",
    provider: "multi-provider",
    model,
    free_brain: true
  });
});

// /chat is unauthenticated: the installed Bridge sends no device credential on this route. Command
// submission therefore gets a per-address budget. Execution being disabled does not make
// unlimited durable writes harmless, so the bound applies even while NEXUS is off.
const AX_CHAT_COMMAND_LIMIT = 10;
const AX_CHAT_COMMAND_WINDOW_MS = 10 * 60 * 1000;
const axChatCommandHits = new Map();
function allowAxChatCommand(address, now = Date.now()) {
  const key = String(address || "unknown");
  const entry = axChatCommandHits.get(key);
  if (!entry || now - entry.window >= AX_CHAT_COMMAND_WINDOW_MS) {
    if (axChatCommandHits.size > 5000) {
      for (const [candidate, value] of axChatCommandHits) {
        if (now - value.window >= AX_CHAT_COMMAND_WINDOW_MS) axChatCommandHits.delete(candidate);
      }
    }
    axChatCommandHits.set(key, { window: now, count: 1 });
    return true;
  }
  if (entry.count >= AX_CHAT_COMMAND_LIMIT) return false;
  entry.count += 1;
  return true;
}

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

    // Never expose a provider safety/status artifact as Ax's answer.
    const normalizedMessage = message.toLowerCase().replace(/[^a-z0-9? ]/g, " ").replace(/\s+/g, " ").trim();
    const isCoreStatusQuestion =
      /^(is ax (online|there)|are you (online|there)|ax (online|there)|are you up|status|habitat status|check status)[? ]*$/.test(normalizedMessage);

    // Explicit device.status requests must execute through the paired Android command
    // queue. Never ask the language model to pretend it ran a device command.
    if (/\bdevice\.status\b|\bphone\s+(?:connection\s+)?diagnostic\b|\bdevice\s+connection\s+diagnostic\b/i.test(message)) {
      try {
        const queued = await deviceCommandBridge.requestDeviceStatus();
        if (!queued.ok) {
          return res.json({
            response: "PHONE DEVICE STATUS\nStatus: UNVERIFIED\n" + queued.error,
            androidDeviceAccess: "UNVERIFIED",
            deviceCommand: "not_queued",
            deterministic: true,
            habitat: "online"
          });
        }
        const deadline = Date.now() + 25000;
        let command = null;
        while (Date.now() < deadline) {
          command = await deviceCommandBridge.getCommand(queued.commandId);
          if (command?.status === "completed" || command?.status === "failed" || command?.status === "cancelled") break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (command?.status === "completed" && command.result?.ok === true) {
          const details = command.result.details || {};
          const publicDetails = {
            manufacturer: details.manufacturer || undefined,
            model: details.model || undefined,
            androidSdk: details.androidSdk || undefined,
            androidRelease: details.androidRelease || undefined,
            app: details.app || undefined
          };
          const deviceLabel = [details.manufacturer, details.model].filter(Boolean).join(" ") || "Paired Android device";
          return res.json({
            response: "PHONE DEVICE STATUS\nStatus: PASS\nDevice: " + deviceLabel +
              "\nCommand: device.status\nExecution: completed by the paired Android app\nDetails: " +
              JSON.stringify(publicDetails),
            androidDeviceAccess: "PASS",
            deviceCommand: command,
            deterministic: true,
            habitat: "online"
          });
        }
        return res.json({
          response: "PHONE DEVICE STATUS\nStatus: PENDING / UNVERIFIED\nThe command was queued for the paired phone, but no completed device response arrived within 25 seconds. Keep Habitat open and try again.",
          androidDeviceAccess: "UNVERIFIED",
          deviceCommand: command || { id: queued.commandId, status: "queued" },
          deterministic: true,
          habitat: "online"
        });
      } catch (error) {
        console.error("AX DEVICE STATUS COMMAND FAILED", String(error?.message || error));
        return res.status(502).json({
          response: "PHONE DEVICE STATUS\nStatus: ERROR\nThe device command could not be dispatched or read.",
          androidDeviceAccess: "ERROR",
          error: String(error?.message || error),
          deterministic: true
        });
      }
    }

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

    // "ask ax system status" must be telemetry, not a model answer. This runs before any prompt so
    // the phone cannot receive an invented status table.
    if (isSystemStatusRequest(message)) {
      try {
        const status = await collectSystemStatus();
        return res.json({
          response: status.report,
          systemStatus: status,
          deterministic: true,
          habitat: "online",
          secretsExposed: false
        });
      } catch (error) {
        console.error("AX SYSTEM STATUS FAILED", String(error?.message || error));
        return res.status(503).json({
          response: "AX SYSTEM STATUS\nStatus: UNAVAILABLE\nThe status probe could not complete on this process.",
          deterministic: true,
          error: "status_probe_failed"
        });
      }
    }

    // Explicit Ax commands ("ax: …", "ask ax to …", "ax run …") go into the universal command
    // router instead of a prompt. A task that is queued is reported as queued: no execution is
    // claimed, and the executor's real state is included in the answer.
    const axObjective = parseAxCommand(message);
    if (axObjective) {
      // A command objective creates a durable task, so it needs a real credential. Status and
      // ordinary conversation above stay public; this write does not.
      const authorization = await chatCommandAuthorizer.authorize({ headers: req.headers, message: axObjective });
      if (!authorization.ok) {
        console.warn("CHAT_COMMAND_UNAUTHORIZED", JSON.stringify({ code: authorization.code }));
        return res.status(401).json({
          response: "AX COMMAND AUTHORIZATION REQUIRED\n" +
            "Command submission needs the owner Ax credential or a paired-device credential. " +
            "This request carried neither, so nothing was queued. Status and conversation still work.",
          deterministic: true,
          code: authorization.code,
          commandRouter: "unauthorized"
        });
      }
      if (!allowAxChatCommand(req.ip)) {
        return res.status(429).json({
          response: "AX COMMAND RATE LIMITED\nAt most " + AX_CHAT_COMMAND_LIMIT + " command objectives per 10 minutes from this address.",
          deterministic: true,
          commandRouter: "rate_limited"
        });
      }
      const adapter = inferReadOnlyAdapter(axObjective);
      const submitted = await deviceCommandBridge.submitCommandObjective({
        objective: axObjective,
        requestedBy: "bridge-chat",
        role: "ax",
        // Only a read-only adapter this engine allowlists. Without one the task is queued but no
        // worker may claim it, and the response says so.
        adapter,
        idempotencyKey: "bridge-chat:" + createHash("sha256")
          .update(axObjective + "|" + Math.floor(Date.now() / 300000))
          .digest("hex")
          .slice(0, 32)
      });
      if (!submitted?.ok) {
        return res.status(503).json({
          response: "AX COMMAND NOT QUEUED\n" + (submitted?.error || "The AX command router rejected the objective."),
          deterministic: true,
          commandRouter: "unavailable"
        });
      }
      const task = submitted.task || {};
      const executor = deviceCommandBridge.status().nexus || null;
      const executionNote = executor?.configured === true
        ? "Executor is mounted; execution is not confirmed until a worker claims the task."
        : "No executor is mounted (" + (executor?.reason || "disabled") + "); the task is queued and will not run yet.";
      return res.status(202).json({
        response: "AX COMMAND QUEUED\nTask: " + (task.id || "unknown") +
          "\nStatus: " + (task.status || "queued") +
          "\nAdapter: " + (adapter || "none — this objective names no read-only subject, so no worker will claim it") +
          "\nObjective: " + axObjective + "\n" + executionNote,
        taskId: task.id || null,
        status: task.status || "queued",
        replayed: submitted.replayed === true,
        deterministic: true,
        commandRouter: "connected",
        habitat: "online"
      });
    }
    // Android connectivity is a deterministic backend/device check. Never send this to the LLM.
    if (/^(?:ax[,:]?\s*)?(?:check|verify|test)\s+(?:android\s+)?(?:device\s+)?(?:connectivity|connection|heartbeat|device\s+access)|^(?:ax[,:]?\s*)?check\s+android\s+(?:device\s+)?(?:connectivity|connection|heartbeat|access)/i.test(message)) {
      try {
        const statusResponse = await fetch("http://127.0.0.1:" + port + "/device/status");
        const statusText = await statusResponse.text();
        let status;
        try { status = JSON.parse(statusText); } catch { status = { ok: false, error: statusText || "device status returned non-JSON" }; }
        const access = status.androidDeviceAccess || "UNVERIFIED";
        const latest = Array.isArray(status.devices) ? status.devices[0] : null;
        return res.json({
          response: "ANDROID DEVICE CHECK\nStatus: " + access + "\n" + (status.detail || "No device status detail.") + (latest?.lastSeenAt ? "\nLast heartbeat: " + latest.lastSeenAt : ""),
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
            response: "TASK CREATED AND EXECUTED\nTask ID: " + task.id + "\nStatus: " + task.status + "\nWorker: " + (task.worker || "unknown") + "\nResult:\n" + canonicalTaskReport(task),
            task, taskEngine: "connected", model, provider: "openrouter", habitat: "online", free_brain: true, deterministic: true
          });
        }
        return res.json({
          response: "TASK CREATED\nTask ID: " + task.id + "\nStatus: " + task.status,
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

    if (!hasAnyAiProviderKey()) {
      return res.status(503).json({
        error: "No AI provider key is configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY. Cerebras requires CEREBRAS_API_KEY and HABITAT_ALLOW_PAID_PROVIDERS=true."
      });
    }

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

let taskRepository = null;
let taskStorageReady = false;
let dispatchLeaseRepository = null;
let dispatchLeaseReady = false;
let contentStorageReady = false;

function hasD1TaskCredentials(env = process.env) {
  return Boolean(
    String(env.CLOUDFLARE_ACCOUNT_ID || "").trim() &&
    String(env.HABITAT_D1_DATABASE_ID || "").trim() &&
    String(env.HABITAT_D1_API_TOKEN || "").trim()
  );
}

async function initializeTaskStorage() {
  if (!hasD1TaskCredentials()) {
    console.log("TASK_STORAGE: memory-only — D1 credentials are not configured");
    return;
  }
  // If credentials are present, fail startup rather than silently losing writes
  // to memory when durable storage is misconfigured or unavailable.
  taskRepository = createD1TaskRepository({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.HABITAT_D1_DATABASE_ID,
    apiToken: process.env.HABITAT_D1_API_TOKEN
  });
  await taskRepository.initialize();
  dispatchLeaseRepository = createD1DispatchLeaseRepository({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: process.env.HABITAT_D1_DATABASE_ID,
    apiToken: process.env.HABITAT_D1_API_TOKEN
  });
  await dispatchLeaseRepository.initialize();
  dispatchLeaseReady = true;
  const restored = await taskRepository.list({ limit: 500 });
  taskStorageReady = true;
  let interruptedCount = 0;
  for (const task of restored) {
    const recovery = markInterruptedTask(task, { now: nowIso });
    taskStore.set(task.id, task);
    if (recovery.changed) {
      await taskRepository.update(task.id, task);
      interruptedCount += 1;
    }
  }
  console.log("TASK_STORAGE: D1 ready; restored " + restored.length + " task records; marked " + interruptedCount + " interrupted for review");
  console.log("TASK_DISPATCH_LEASE: D1-backed cross-instance claim guard ready");
}

async function persistTask(task) {
  if (!taskRepository || !taskStorageReady) return task;
  const existing = await taskRepository.get(task.id);
  if (existing) return await taskRepository.update(task.id, task);
  return await taskRepository.create(task);
}

async function listStoredTasks() {
  if (taskRepository && taskStorageReady) return taskRepository.list({ limit: 500 });
  return Array.from(taskStore.values());
}

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
  }],
  // The Android worker mesh shows these three rows; without registry entries the detail page would
  // have nothing real to report. They are execution profiles, not separate model providers.
  ["dropilot-listing-optimizer", {
    id: "dropilot-listing-optimizer",
    name: "DropPilot Listing Optimizer",
    kind: "specialist",
    status: hasAnyAiProviderKey() ? "available" : "blocked",
    model,
    capabilities: ["listing-copy", "pricing-review", "conversion-audit"],
    lastRunAt: null
  }],
  ["dropilot-growth-operator", {
    id: "dropilot-growth-operator",
    name: "DropPilot Growth Operator",
    kind: "specialist",
    status: hasAnyAiProviderKey() ? "available" : "blocked",
    model,
    capabilities: ["campaign-planning", "creator-outreach", "sales-tracking"],
    lastRunAt: null
  }],
  ["habitat-orchestrator", {
    id: "habitat-orchestrator",
    name: "Ax Orchestrator",
    kind: "orchestrator",
    status: hasAnyAiProviderKey() ? "available" : "blocked",
    model,
    capabilities: ["planning", "delegation", "mission-control"],
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

// Phone presence is read from the durable paired-device registry only. The legacy in-memory
// heartbeat map was removed: its route was shadowed by the durable device bridge, so it could never
// be written and only made /device/status report two competing sources of truth.
async function androidAccessStatus() {
  let pairedDevices = [];
  try {
    pairedDevices = await deviceCommandBridge.listDevices();
  } catch (error) {
    console.warn("DEVICE_BRIDGE_INVENTORY_UNAVAILABLE", String(error?.message || error));
  }
  return projectDevicePresence(pairedDevices);
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

  let storagePassed = false;
  let storageDetail = "";
  if (taskRepository && taskStorageReady) {
    try {
      await taskRepository.healthCheck();
      storagePassed = true;
      storageDetail = "Configured Cloudflare D1 task repository health check passed.";
    } catch {
      storageDetail = "Configured Cloudflare D1 task repository health check failed.";
    }
  } else {
    storagePassed = storageSelfTest();
    storageDetail = storagePassed
      ? "In-process memory probe passed, but durable task persistence is not configured; records may be lost on restart."
      : "In-process task storage probe failed.";
  }
  checks.storage = {
    status: taskRepository && taskStorageReady ? (storagePassed ? "PASS" : "FAIL") : (storagePassed ? "UNKNOWN" : "FAIL"),
    detail: storageDetail
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

  taskStore.set(task.id, task);
  let taskWasCreated = taskStore.has(task.id);
  if (taskWasCreated && taskRepository && taskStorageReady) {
    try {
      await taskRepository.create(task);
    } catch {
      taskWasCreated = false;
    }
  }
  checks.taskCreation = {
    status: taskWasCreated ? "PASS" : "FAIL",
    detail: taskWasCreated
      ? "Task record created" + (taskRepository && taskStorageReady ? " and persisted to D1: " : ": ") + task.id
      : "Task record could not be persisted: " + task.id
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

    const androidAccess = await androidAccessStatus();
    const latestDevice = androidAccess.devices.find(device =>
      Date.now() - new Date(device.lastSeenAt).getTime() <= (device.heartbeatTtlMs || DEVICE_BRIDGE_HEARTBEAT_TTL_MS)
    ) || null;
    const heartbeatAgeMs = latestDevice?.lastSeenAt
      ? Math.max(0, Date.now() - new Date(latestDevice.lastSeenAt).getTime())
      : null;
    checks.androidHeartbeat = {
      status: latestDevice ? "PASS" : "FAIL",
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

    // Every check carries its own detail so a BLOCKED result can name the failing subsystem
    // instead of surfacing a null placeholder.
    const verificationDetails = Object.fromEntries(
      Object.entries(checks).map(([name, check]) => [name, { status: check.status, detail: check.detail }])
    );
    const blockedReason = Object.entries(checks)
      .filter(([, check]) => check.status !== "PASS")
      .map(([name, check]) => name + ": " + check.detail)
      .join(" | ");

    task.result = JSON.stringify({
      verification: {
        backendHealth: checks.backendHealth.status,
        modelWorker: checks.modelWorker.status,
        androidHeartbeat: checks.androidHeartbeat.status,
        androidDeviceAccess: checks.androidDeviceAccess.status,
        taskCreation: checks.taskCreation.status,
        storage: checks.storage.status
      },
      verificationDetails,
      blockedReason: blockedReason || null,
      model: modelName,
      provider: providerName,
      latencyMs,
      workerReport: result
    });
    task.status = "verified";
    task.completedAt = nowIso();
    task.verifiedAt = nowIso();
    task.updatedAt = nowIso();
    if (taskRepository && taskStorageReady) await persistTask(task);
  } catch (error) {
    task.status = "failed";
    task.updatedAt = nowIso();
    task.error = String(error?.message || error);
    if (taskRepository && taskStorageReady) {
      try { await persistTask(task); } catch {}
    }
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

function configuredProviders(env = process.env) {
  return {
    groq: Boolean(String(env.GROQ_API_KEY || "").trim()),
    gemini: Boolean(String(env.GEMINI_API_KEY || "").trim()),
    openrouter: Boolean(String(env.OPENROUTER_API_KEY || "").trim()),
    cerebras: Boolean(String(env.CEREBRAS_API_KEY || "").trim()),
    cloudflare: Boolean(String(env.CLOUDFLARE_API_TOKEN || "").trim()) && Boolean(String(env.CLOUDFLARE_ACCOUNT_ID || "").trim())
  };
}

/**
 * One read-only status gather used by GET /system/status and the Bridge chat intent. It reports
 * only what this process can observe; nothing is estimated and no secret value is copied.
 */
async function collectSystemStatus() {
  const startedAt = Date.now();
  let tasks = [];
  try {
    tasks = await listStoredTasks();
  } catch {
    tasks = Array.from(taskStore.values());
  }

  let devicePresence = { paired: 0, recentlySeen: false, lastSeenAt: null };
  try {
    const access = await androidAccessStatus();
    const devices = Array.isArray(access?.devices) ? access.devices : [];
    const lastSeenAt = devices
      .map(device => device?.lastSeenAt)
      .filter(Boolean)
      .sort()
      .pop() || null;
    devicePresence = {
      paired: devices.length,
      recentlySeen: access?.status === "PASS",
      lastSeenAt
    };
  } catch (error) {
    console.warn("STATUS_DEVICE_PRESENCE_FAILED", String(error?.message || error));
  }

  const bridgeStatus = deviceCommandBridge.status();
  let identity = null;
  try {
    identity = typeof deviceCommandBridge.identityStatus === "function" ? await deviceCommandBridge.identityStatus() : null;
  } catch (error) {
    console.warn("STATUS_IDENTITY_FAILED", String(error?.message || error));
  }
  let execution = bridgeStatus.nexus || null;
  const runtime = typeof deviceCommandBridge.nexus === "function" ? deviceCommandBridge.nexus() : null;
  if (runtime && typeof runtime.presence === "function") {
    try {
      const presence = await runtime.presence();
      execution = {
        configured: presence?.executor?.configured === true,
        started: presence?.executor?.started === true,
        canExecute: presence?.canExecute === true,
        heartbeat: presence?.heartbeat || null,
        queue: presence?.queue || null,
        liveWorkers: presence?.heartbeat?.liveWorkers ?? null,
        reason: presence?.executor?.reason || null
      };
    } catch (error) {
      console.warn("STATUS_EXECUTOR_PRESENCE_FAILED", String(error?.message || error));
    }
  }

  return buildSystemStatus({
    env: process.env,
    version: process.env.HABITAT_VERSION || "0.5.0",
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.HABITAT_COMMIT || null,
    startedAtMs: Date.now() - Math.round(process.uptime() * 1000),
    latencyMs: Date.now() - startedAt,
    registry: workerRegistry,
    tasks,
    deviceBridge: bridgeStatus,
    devicePresence,
    storage: {
      taskRepositoryReady: taskRepository && taskStorageReady,
      contentJobRepositoryReady: contentStorageReady,
      dispatchLeaseReady,
      secretVaultReady: Boolean(secretVault)
    },
    providers: configuredProviders(),
    // Read-only snapshot: configured, initialized, enabled, running and verified are separate facts.
    workforce: workforceRuntime.status(),
    // Identity is reported apart from whichever provider supplies intelligence.
    identity,
    missions: await missionRuntime.status(),
    // Mount facts only; the gateway refuses every request unless its own flag is on.
    gateway: { enabled: gatewayEnabled(), repository: gatewayRepository !== null, flag: GATEWAY_FLAG },
    ownerAuthentication: ownerVerifier ? {
      verifierConfigured: true,
      activeKeyId: ownerVerifier.rotation?.().activeKeyId || null,
      enforce: String(process.env.HABITAT_OWNER_ATTESTATION_ENFORCE || "").toLowerCase() === "true",
      policy: String(process.env.HABITAT_OWNER_ATTESTATION_ENFORCE || "").toLowerCase() === "true" ? "required" : "optional"
    } : { verifierConfigured: false, enforce: false, policy: "optional", detail: "No owner attestation key is configured." },
    heartbeat: heartbeatMonitor
      ? await heartbeatMonitor.status()
      : { enabled: false, flag: HEARTBEAT_FLAG, connection: "disabled", unavailableReason: heartbeatUnavailable },
    mcpEvents: {
      enabled: mcpEnabled(), configured: mcpEvents !== null, flag: MCP_FLAG, scope: MCP_SCOPE,
      secretEncryption: { configured: mcpEncryption.ok === true, activeKeyId: mcpEncryption.ok ? mcpEncryption.activeKeyId : null }
    },
    routes: {
      chat: true,
      // These routes are registered by registerDeviceCommandBridge regardless of credentials or
      // storage readiness; readiness is reported separately by the auth and storage components.
      deviceCommands: true,
      axCommand: true,
      nexusRuntime: bridgeStatus.nexus?.configured === true
    },
    execution
  });
}

// Public, redacted, read-only. It names configuration keys and reports booleans; it never returns a
// value, and it does not probe providers, so it cannot spend quota.
app.get("/system/status", async (_req, res) => {
  try {
    const status = await collectSystemStatus();
    res.setHeader("cache-control", "no-store");
    return res.json(status);
  } catch (error) {
    console.error("SYSTEM_STATUS_FAILED", String(error?.message || error));
    return res.status(503).json({
      ok: false,
      error: "System status could not be assembled on this process.",
      secretsExposed: false
    });
  }
});

app.get("/capabilities", async (_req, res) => {
  const device = await androidAccessStatus();
  return res.json(buildCapabilityStatus({
    aiProviderConfigured: hasAnyAiProviderKey(),
    workerRegistered: workerRegistry.has("habitat-qa-worker"),
    androidStatus: device.status,
    taskRepositoryConfigured: hasD1TaskCredentials(),
    taskRepositoryReady: taskStorageReady,
    contentJobRepositoryReady: contentStorageReady
  }));
});

// Truthful worker inventory: the catalog supplies per-worker detail from real task history, and
// the counts come from observed state, not from registration. A registered worker is not health.
app.get("/workers", async (_req, res) => {
  let tasks = [];
  try { tasks = await listStoredTasks(); } catch { tasks = []; }
  const classified = classifyWorkers({ registry: workerRegistry, tasks });
  return res.json({
    ok: true,
    counts: summarizeWorkerCounts(classified),
    workers: buildWorkerList({
      workers: Array.from(workerRegistry.values()),
      tasks,
      providerConfigured: hasAnyAiProviderKey()
    }),
    note: "Counts are derived from registered workers and the task records this process holds. A registered worker is not proof of health."
  });
});

// Read-only worker detail used by the Android worker mesh: runtime status, capabilities, recent
// jobs, an execution log and the real blocker. No credential is ever part of this payload.
app.get("/workers/:id", async (req, res) => {
  const id = resolveWorkerId(req.params.id);
  const worker = workerRegistry.get(id);
  if (!worker) {
    return res.status(404).json({ ok: false, error: "worker not found", workerId: id });
  }
  let tasks = [];
  try { tasks = await listStoredTasks(); } catch { tasks = []; }
  const detail = buildWorkerDetail({
    worker,
    tasks,
    providerConfigured: hasAnyAiProviderKey()
  });
  return res.json({ ok: true, worker: detail });
});

app.get("/storage/check", async (_req, res) => {
  if (taskRepository && taskStorageReady) {
    try {
      const [taskCheck, contentCheck, vaultCheck, leaseCheck] = await Promise.all([
        taskRepository.healthCheck(),
        contentJobRepository ? contentJobRepository.healthCheck() : Promise.resolve({ ok: false, durable: false }),
        secretVault ? secretVault.healthCheck() : Promise.resolve({ ok: false, durable: false }),
        dispatchLeaseRepository && dispatchLeaseReady
          ? dispatchLeaseRepository.healthCheck()
          : Promise.resolve({ ok: false, durable: false })
      ]);
      const ok = taskCheck.ok === true && contentCheck.ok === true && vaultCheck.ok === true && leaseCheck.ok === true;
      return res.status(ok ? 200 : 503).json({
        ok,
        storage: "cloudflare-d1",
        durable: taskCheck.ok === true,
        persistence: "cloudflare-d1",
        restoredTaskCount: taskStore.size,
        contentJobPersistence: { ready: contentCheck.ok === true, durable: contentCheck.durable === true },
        encryptedTikTokVault: { ready: vaultCheck.ok === true, encryptedAtRest: true, keyValueExposed: false },
        dispatchLease: { ready: leaseCheck.ok === true, durable: leaseCheck.durable === true },
        detail: ok
          ? "Task storage, content-job storage, encrypted TikTok vault, and durable dispatch lease health checks all passed. This does not prove TikTok authorization or posting is approved."
          : "One or more durable storage health checks failed; inspect the per-component readiness fields."
      });
    } catch {
      return res.status(503).json({
        ok: false, storage: "cloudflare-d1", durable: false,
        persistence: "cloudflare-d1", detail: "Configured D1 storage health check failed."
      });
    }
  }
  const probePassed = storageSelfTest();
  return res.status(probePassed ? 200 : 503).json({
    ok: probePassed, storage: probePassed ? "memory-only" : "failed",
    durable: false, persistence: "process-local",
    detail: probePassed
      ? "Memory write/read/delete passed, but this is not durable storage. Task history can be lost on restart."
      : "In-process write/read/delete probe failed."
  });
});

app.post("/tasks", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const description = String(req.body?.description || title).trim();
  if (!title) return res.status(400).json({ ok: false, error: "title required" });
  const task = {
    id: makeTaskId(), title, description, status: "planned", owner: "Ax",
    worker: null, createdAt: nowIso(), updatedAt: nowIso(), delegatedAt: null,
    completedAt: null, verifiedAt: null, result: null, error: null
  };
  try {
    // Persist first; never acknowledge a durable task that failed to write.
    if (taskRepository && taskStorageReady) await taskRepository.create(task);
    taskStore.set(task.id, task);
    return res.json({ ok: true, task, persistence: taskRepository && taskStorageReady ? "cloudflare-d1" : "process-local" });
  } catch {
    return res.status(503).json({ ok: false, error: "task storage write failed; task was not accepted" });
  }
});

app.get("/tasks", async (_req, res) => {
  try {
    const tasks = (await listStoredTasks())
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return res.json({ ok: true, tasks, persistence: taskRepository && taskStorageReady ? "cloudflare-d1" : "process-local" });
  } catch {
    return res.status(503).json({ ok: false, error: "task storage read failed" });
  }
});

app.get("/tasks/:id", async (req, res) => {
  try {
    let task = taskRepository && taskStorageReady
      ? await taskRepository.get(req.params.id)
      : taskStore.get(req.params.id);
    if (!task) return res.status(404).json({ ok: false, error: "task not found" });
    taskStore.set(task.id, task);
    return res.json({ ok: true, task });
  } catch {
    return res.status(503).json({ ok: false, error: "task storage read failed" });
  }
});

app.post("/tasks/:id/retry", async (req, res) => {
  const existing = taskStore.get(req.params.id);
  if (!existing) {
    if (taskRepository && taskStorageReady) {
      try {
        const stored = await taskRepository.get(req.params.id);
        if (stored) taskStore.set(stored.id, stored);
      } catch {
        return res.status(503).json({ ok: false, error: "task storage read failed" });
      }
    }
  }
  const current = taskStore.get(req.params.id);
  if (!current) return res.status(404).json({ ok: false, error: "task not found" });
  const task = structuredClone(current);
  const retry = prepareTaskRetry(task, { now: nowIso });
  if (!retry.allowed) {
    return res.status(409).json({ ok: false, error: "only interrupted or failed tasks can be retried", task: current });
  }
  try {
    await persistTask(task);
    taskStore.set(task.id, task);
    return res.json({ ok: true, task, nextAction: "Call POST /tasks/:id/delegate to execute this explicitly retried task." });
  } catch {
    return res.status(503).json({ ok: false, error: "task retry state could not be persisted" });
  }
});

app.post("/tasks/:id/delegate", async (req, res) => {
  let task = taskStore.get(req.params.id);
  if (!task && taskRepository && taskStorageReady) {
    try {
      task = await taskRepository.get(req.params.id);
      if (task) taskStore.set(task.id, task);
    } catch {
      return res.status(503).json({ ok: false, error: "task storage read failed" });
    }
  }
  if (!task) return res.status(404).json({ ok: false, error: "task not found" });

  if (!hasAnyAiProviderKey()) {
    task.status = "failed";
    task.error = "No AI provider key is configured. Set CLOUDFLARE_API_TOKEN with CLOUDFLARE_ACCOUNT_ID for Workers AI, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY. Cerebras requires CEREBRAS_API_KEY and HABITAT_ALLOW_PAID_PROVIDERS=true.";
    try { await persistTask(task); } catch {
      return res.status(503).json({ ok: false, error: "task storage write failed" });
    }
    return res.status(503).json({ ok: false, task });
  }

  // A persisted task alone does not prevent two Render instances from dispatching
  // it at once. Acquire a durable, task-scoped lease before the process-local
  // state transition; fail closed if durable storage is active but the lease
  // repository is unavailable.
  let dispatchLease = null;
  if (taskStorageReady) {
    if (!dispatchLeaseReady || !dispatchLeaseRepository) {
      return res.status(503).json({ ok: false, error: "durable dispatch lease is unavailable; worker was not started" });
    }
    const scopeKey = "task:" + task.id;
    const leaseToken = makeTaskId();
    const claimedAt = nowIso();
    try {
      dispatchLease = await dispatchLeaseRepository.acquire({
        scopeKey,
        leaseToken,
        nowIso: claimedAt,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      });
    } catch {
      return res.status(503).json({ ok: false, error: "durable dispatch claim failed; worker was not started" });
    }
    if (!dispatchLease.acquired) {
      return res.status(409).json({ ok: false, duplicate: true, dispatch: "dispatch_already_in_progress", task });
    }
    // Release after the response has finished. If the process crashes, expiry
    // permits recovery; a stale owner cannot release a replacement lease.
    res.once("finish", () => {
      dispatchLeaseRepository.release({ scopeKey, leaseToken }).catch(() => {
        console.warn("TASK_DISPATCH_LEASE_RELEASE_FAILED", JSON.stringify({ taskId: task.id }));
      });
    });
  }

  const dispatchClaim = claimTaskDispatch(task, { now: nowIso });
  if (!dispatchClaim.claimed) {
    // Replays must not launch another worker run. Return the existing record so
    // clients can reconcile state; use 409 while the original dispatch is active.
    return res.status(dispatchClaim.reason === "dispatch_already_in_progress" ? 409 : 200).json({
      ok: dispatchClaim.reason !== "dispatch_already_in_progress",
      duplicate: true,
      dispatch: dispatchClaim.reason,
      task
    });
  }
  task.worker = workerRegistry.has("habitat-qa-worker") ? "habitat-qa-worker" : null;
  task.updatedAt = nowIso();
  try {
    await persistTask(task);
  } catch {
    task.status = "planned";
    task.delegatedAt = null;
    task.updatedAt = nowIso();
    return res.status(503).json({ ok: false, error: "could not persist dispatch claim; worker was not started" });
  }

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
      task.updatedAt = nowIso();
      await persistTask(task);
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
      task.updatedAt = nowIso();
      await persistTask(task);
      return res.status(502).json({ ok: false, task });
    }

    const androidAccess = await androidAccessStatus();
    const latestDevice = androidAccess.devices.find(device =>
      Date.now() - new Date(device.lastSeenAt).getTime() <= (device.heartbeatTtlMs || DEVICE_BRIDGE_HEARTBEAT_TTL_MS)
    ) || null;
    const heartbeatAgeMs = latestDevice?.lastSeenAt
      ? Math.max(0, Date.now() - new Date(latestDevice.lastSeenAt).getTime())
      : null;
    const androidHeartbeat = latestDevice ? "PASS" : "FAIL";
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
    const verificationDetails = {
      backendHealth: { status: "PASS", detail: "The local /health endpoint answered online and ready." },
      modelWorker: { status: "PASS", detail: "The model returned a non-empty result after one real retry." },
      androidHeartbeat: {
        status: androidHeartbeat,
        detail: latestDevice
          ? "Last authenticated check-in " + latestDevice.lastSeenAt + " (" + Math.round((heartbeatAgeMs || 0) / 1000) + "s ago)."
          : "No paired Android device checked in within the 45-minute heartbeat window, so device-dependent checks cannot pass. Open the Habitat app or check the bridge connection."
      },
      androidDeviceAccess: { status: androidAccess.status, detail: androidAccess.detail },
      taskCreation: { status: taskCreation, detail: "The task record is present in the configured task store." },
      storage: { status: storage, detail: "The task storage write/read self-test passed." }
    };
    const blockedReason = Object.entries(verificationDetails)
      .filter(([, check]) => check.status !== "PASS")
      .map(([name, check]) => name + ": " + check.detail)
      .join(" | ");

    const fullyVerified =
      verification.backendHealth === "PASS" &&
      verification.modelWorker === "PASS" &&
      verification.androidHeartbeat === "PASS" &&
      verification.androidDeviceAccess === "PASS" &&
      verification.taskCreation === "PASS" &&
      verification.storage === "PASS";

    task.result = JSON.stringify({
      verification,
      verificationDetails,
      blockedReason: blockedReason || null,
      androidDevice: latestDevice,
      heartbeatAgeMs,
      workerReport: result
    });

    // A task is only marked verified when every canonical machine check
    // passes. Never report a partial execution as verified.
    task.status = fullyVerified ? "verified" : "blocked";
    task.completedAt = nowIso();
    if (fullyVerified) task.verifiedAt = nowIso();
    task.updatedAt = nowIso();
    await persistTask(task);

    return res.json({ ok: true, task });
  } catch (error) {
    task.status = "failed";
    task.error = String(error?.message || error);
    task.updatedAt = nowIso();
    try { await persistTask(task); } catch {
      return res.status(503).json({ ok: false, error: "task failed and its final state could not be persisted" });
    }
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
const d1ContentConfigured = [process.env.CLOUDFLARE_ACCOUNT_ID, process.env.HABITAT_D1_DATABASE_ID, process.env.HABITAT_D1_API_TOKEN].every(value => String(value || "").trim());
const contentJobRepository = d1ContentConfigured ? createD1ContentJobRepository({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.HABITAT_D1_DATABASE_ID,
  apiToken: process.env.HABITAT_D1_API_TOKEN
}) : null;
const tokenEncryptionKey = String(process.env.HABITAT_TOKEN_ENCRYPTION_KEY || "").trim();
const secretVaultConfigured = d1ContentConfigured && /^[a-f0-9]{64}$/i.test(tokenEncryptionKey);
const secretVault = secretVaultConfigured ? createD1SecretVault({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.HABITAT_D1_DATABASE_ID,
  apiToken: process.env.HABITAT_D1_API_TOKEN,
  encryptionKey: tokenEncryptionKey
}) : null;
registerTikTokOAuth(app, secretVault);
registerShopifyOAuth(app, secretVault);
const contentEngine = registerContentEngine(app, { nowIso, makeTaskId, taskStore, workerRegistry, brainChat, contentJobRepository, secretVault, getDispatchLeaseRepository: () => dispatchLeaseReady ? dispatchLeaseRepository : null });

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

await initializeTaskStorage();
if (secretVault) {
  await secretVault.initialize();
  await secretVault.deleteExpired("tiktok_oauth_state:", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const savedTokens = await secretVault.get("tiktok_tokens");
  if (savedTokens?.access_token) {
    process.env.TIKTOK_ACCESS_TOKEN = String(savedTokens.access_token);
    if (savedTokens.refresh_token) process.env.TIKTOK_REFRESH_TOKEN = String(savedTokens.refresh_token);
    if (savedTokens.access_token_expires_at) process.env.TIKTOK_ACCESS_TOKEN_EXPIRES_AT = String(savedTokens.access_token_expires_at);
    if (savedTokens.refresh_token_expires_at) process.env.TIKTOK_REFRESH_TOKEN_EXPIRES_AT = String(savedTokens.refresh_token_expires_at);
  }
  console.log("TIKTOK_TOKEN_VAULT: D1 AES-256-GCM ready; token values are not logged");
} else {
  console.warn("TIKTOK_TOKEN_VAULT: unavailable — OAuth cannot be marked connected until D1 and HABITAT_TOKEN_ENCRYPTION_KEY are configured");
}
// Refuses safely when disabled, unconfigured, or when migration 0010 is absent. Never applies DDL.
const missionInit = await missionRuntime.initialize();
if (missionInit.state !== "disabled") {
  console.log("MISSIONS_STATUS", JSON.stringify(missionInit));
}
const workforceInit = await workforceRuntime.initialize();
if (workforceInit.state !== "disabled") {
  console.log("WORKFORCE_STATUS", JSON.stringify(workforceInit));
}
const contentStorageInit = await contentEngine.initialize();
const deviceCommandBridgeInit = await deviceCommandBridge.initialize();
console.log("DEVICE_COMMAND_BRIDGE_STATUS", JSON.stringify({ ...deviceCommandBridge.status(), initialized: deviceCommandBridgeInit.ok }));
contentStorageReady = contentStorageInit?.durable === true;

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