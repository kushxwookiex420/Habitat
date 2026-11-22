#!/usr/bin/env node
/**
 * Ax relay — an external, token-holding client for the Ax command channel.
 *
 * Purpose: ChatGPT on a personal plan cannot call Habitat. This relay is the honest alternative:
 * it runs where a secret can live (a computer or an agent workspace), reads the authenticated
 * channel, prints a compact brief that can be pasted into ChatGPT, and sends a single envelope
 * that ChatGPT wrote back. ChatGPT never receives the token and no request travels from OpenAI
 * to Habitat; the owner is the transport. That limitation is stated, not hidden.
 *
 * Safety properties:
 *   - the token comes from HABITAT_AX_COMMAND_TOKEN only (never argv, never a file),
 *   - the origin must be HTTPS unless it is loopback,
 *   - an envelope may contain only the documented fields; `from` and unknown fields are refused,
 *   - an idempotency key is derived deterministically from the envelope when absent, so a repeated
 *     send replays instead of duplicating work,
 *   - output is redacted defensively before it is printed.
 *
 * It cannot approve anything: /ax/command/tasks/approve and the NEXUS surface are never called.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENVELOPE_FIELDS = Object.freeze(["kind", "body", "objective", "adapter", "correlationId", "idempotencyKey", "project"]);
const KINDS = Object.freeze(["task", "question", "note"]);
const LIMITS = Object.freeze({ body: 4000, objective: 2000, correlation: 120, idempotency: 160, project: 40, adapter: 120, brief: 6000 });

export function redact(value, max = 4000) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\bax(?:cmd|bridge|nexus)_[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/x-owner-device-token"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}/gi, "x-owner-device-token: [redacted]")
    .slice(0, Math.max(0, max));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/** Canonical JSON so two identical envelopes derive the same key regardless of property order. */
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function deriveIdempotencyKey(envelope) {
  const { idempotencyKey, ...rest } = envelope || {};
  return "relay:" + createHash("sha256").update(canonical(rest), "utf8").digest("hex").slice(0, 32);
}

export function validateEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_envelope", "The envelope must be a JSON object.");
  const unknown = Object.keys(input).filter(key => !ENVELOPE_FIELDS.includes(key));
  if (unknown.length) fail("invalid_envelope", "Unknown field(s): " + unknown.join(", ") + ". Allowed: " + ENVELOPE_FIELDS.join(", ") + ".");
  if (!KINDS.includes(input.kind)) fail("invalid_kind", "kind must be one of " + KINDS.join(", ") + ".");
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) fail("invalid_body", "body is required.");
  if (body.length > LIMITS.body) fail("invalid_body", "body exceeds " + LIMITS.body + " characters.");
  const envelope = { kind: input.kind, body };
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (input.kind === "task" && !objective) fail("invalid_objective", "objective is required for kind=task.");
  if (objective) {
    if (objective.length > LIMITS.objective) fail("invalid_objective", "objective exceeds " + LIMITS.objective + " characters.");
    envelope.objective = objective;
  }
  if (input.adapter !== undefined && input.adapter !== null && input.adapter !== "") {
    if (typeof input.adapter !== "string" || input.adapter.length > LIMITS.adapter) fail("invalid_adapter", "adapter must be a short string.");
    envelope.adapter = input.adapter.trim();
  }
  if (input.correlationId !== undefined && input.correlationId !== null && input.correlationId !== "") {
    if (typeof input.correlationId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(input.correlationId)) {
      fail("invalid_correlation_id", "correlationId must match [A-Za-z0-9._:-] and be at most 120 characters.");
    }
    envelope.correlationId = input.correlationId;
  }
  if (input.project !== undefined && input.project !== null && input.project !== "") {
    if (typeof input.project !== "string" || input.project.length > LIMITS.project) fail("invalid_project", "project must be a short string.");
    envelope.project = input.project.trim();
  }
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && input.idempotencyKey !== "") {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length > LIMITS.idempotency) {
      fail("invalid_idempotency_key", "idempotencyKey must be at most " + LIMITS.idempotency + " characters.");
    }
    envelope.idempotencyKey = input.idempotencyKey.trim();
  }
  envelope.idempotencyKey = envelope.idempotencyKey || deriveIdempotencyKey(envelope);
  return envelope;
}

export function normalizeBaseUrl(value) {
  const text = String(value || "").trim();
  if (!text) fail("missing_origin", "Set HABITAT_BASE_URL (or pass --base) to the Habitat origin.");
  let url;
  try { url = new URL(text); } catch { fail("invalid_origin", "The origin is not a valid absolute URL."); }
  if (url.username || url.password) fail("invalid_origin", "The origin must not embed credentials.");
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    fail("insecure_origin", "The origin must be HTTPS; plain HTTP is accepted only for loopback.");
  }
  if (url.search || url.hash) fail("invalid_origin", "The origin must not carry a query or fragment.");
  return url.toString().replace(/\/+$/, "");
}

function formatMessage(message) {
  const lines = [];
  const tag = [message.kind, message.status].filter(Boolean).join(" / ");
  lines.push("- " + redact(message.id, 120) + " [" + redact(tag, 80) + "] correlation=" + redact(message.correlationId, 120));
  if (message.objective) lines.push("  objective: " + redact(message.objective, 300));
  if (message.body) lines.push("  body: " + redact(message.body, 500));
  if (message.answer?.body) lines.push("  answer: " + redact(message.answer.body, 300));
  if (message.result?.summary) lines.push("  result: " + redact(message.result.summary, 400));
  for (const item of Array.isArray(message.evidence) ? message.evidence.slice(0, 5) : []) {
    lines.push("  evidence: " + redact(item, 300));
  }
  if (message.error?.message) lines.push("  error: " + redact(message.error.message, 300));
  return lines.join("\n");
}

export function createAxRelay({ baseUrl, token, fetchImpl = fetch } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const credential = String(token || "").trim();
  if (!credential) fail("missing_token", "Set HABITAT_AX_COMMAND_TOKEN in the environment; it is never read from a flag or a file.");

  async function call(method, route, body = null) {
    const response = await fetchImpl(base + route, {
      method,
      headers: {
        authorization: "Bearer " + credential,
        accept: "application/json",
        ...(body === null ? {} : { "content-type": "application/json" })
      },
      ...(body === null ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: redact(text, 400) }; }
    if (!response.ok) {
      const error = new Error("Habitat answered " + response.status + ": " + redact(parsed?.error || parsed?.code || "request failed", 300));
      error.code = parsed?.code || "request_failed";
      error.status = response.status;
      throw error;
    }
    return parsed;
  }

  async function brief({ limit = 20 } = {}) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
    const listed = await call("GET", "/ax/command/messages?limit=" + bounded);
    const messages = Array.isArray(listed?.messages) ? listed.messages : [];
    const lines = [
      "# Habitat Ax brief (" + (messages.length) + " message(s))",
      "",
      "Read-only snapshot. To act, reply with one JSON object using only these fields:",
      '{"kind":"task|question|note","body":"...","objective":"...","adapter":"...","correlationId":"..."}',
      "The owner's relay sends it with the Ax token. You cannot approve work; an approval needs the owner's paired device.",
      ""
    ];
    for (const message of messages) lines.push(formatMessage(message));
    if (!messages.length) lines.push("No messages yet.");
    return redact(lines.join("\n"), LIMITS.brief);
  }

  async function thread(correlationId) {
    if (typeof correlationId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(correlationId)) {
      fail("invalid_correlation_id", "correlationId must match [A-Za-z0-9._:-] and be at most 120 characters.");
    }
    const result = await call("GET", "/ax/command/messages/thread/" + encodeURIComponent(correlationId));
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const lines = ["# Thread " + correlationId, ""];
    for (const message of messages) lines.push(formatMessage(message));
    for (const decision of Array.isArray(result?.awaitingDecision) ? result.awaitingDecision : []) {
      lines.push("AWAITING DECISION: " + redact(decision.body || decision.id, 400));
    }
    if (!messages.length) lines.push("No messages in this thread.");
    return redact(lines.join("\n"), LIMITS.brief);
  }

  async function send(input, { dryRun = false } = {}) {
    const envelope = validateEnvelope(input);
    if (dryRun) return { dryRun: true, envelope };
    const result = await call("POST", "/ax/command/messages", envelope);
    return {
      id: result?.message?.id || null,
      status: result?.message?.status || null,
      correlationId: result?.correlationId || result?.message?.correlationId || null,
      replayed: result?.replayed === true,
      taskId: result?.message?.taskId || null
    };
  }

  return { baseUrl: base, brief, thread, send, validateEnvelope, deriveIdempotencyKey };
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = name => {
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    args.splice(index, value === undefined || value.startsWith("--") ? 1 : 2);
    return value ?? true;
  };
  const baseFlag = flag("--base");
  const limitFlag = flag("--limit");
  const dryRun = args.includes("--dry-run");
  if (dryRun) args.splice(args.indexOf("--dry-run"), 1);
  const [command, target] = args;
  if (!command) {
    process.stderr.write("Usage: ax-relay <brief|thread|send> [...]\n");
    process.exitCode = 2;
    return;
  }

  const origin = baseFlag || process.env.HABITAT_BASE_URL || "";
  const relay = createAxRelay({ baseUrl: origin, token: process.env.HABITAT_AX_COMMAND_TOKEN });

  if (command === "brief") {
    process.stdout.write((await relay.brief({ limit: limitFlag ? Number(limitFlag) : 20 })) + "\n");
    return;
  }
  if (command === "thread") {
    if (!target) fail("missing_correlation_id", "Usage: ax-relay thread <correlationId>");
    process.stdout.write((await relay.thread(target)) + "\n");
    return;
  }
  if (command === "send") {
    if (!target) fail("missing_file", "Usage: ax-relay send <envelope.json> [--dry-run]");
    const parsed = JSON.parse(await readFile(path.resolve(target), "utf8"));
    const outcome = await relay.send(parsed, { dryRun });
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
    return;
  }
  process.stderr.write("Usage: ax-relay <brief|thread|send> [...]\n");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv);
  } catch (error) {
    process.stderr.write("ax-relay: " + redact(error?.message || error, 400) + "\n");
    process.exitCode = error?.code === "missing_token" || error?.code === "missing_origin" ? 2 : 1;
  }
}

export const RELAY_FILE = fileURLToPath(import.meta.url);
