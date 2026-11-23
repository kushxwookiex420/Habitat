import test from "node:test";
import assert from "node:assert/strict";
import {
  createAxRelay,
  deriveIdempotencyKey,
  normalizeBaseUrl,
  redact,
  validateEnvelope
} from "../scripts/ax-relay.mjs";

const TOKEN = "axcmd_relay_test_0123456789";
const BASE = "https://habitat.example.test";

function relayWith(payload, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(payload); }
    };
  };
  return { relay: createAxRelay({ baseUrl: BASE, token: TOKEN, fetchImpl }), calls };
}

test("the origin must be HTTPS unless it is loopback", () => {
  assert.equal(normalizeBaseUrl("https://habitat.example.test/"), "https://habitat.example.test");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeBaseUrl("http://habitat.example.test"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@habitat.example.test"), /must not embed credentials/);
  assert.throws(() => normalizeBaseUrl(""), /HABITAT_BASE_URL/);
});

test("the token is required and comes from the caller, never from the envelope", () => {
  assert.throws(() => createAxRelay({ baseUrl: BASE, token: "" }), /HABITAT_AX_COMMAND_TOKEN/);
});

test("an envelope accepts only the documented fields", () => {
  assert.throws(() => validateEnvelope({ kind: "note", body: "hi", from: "nexus" }), /Unknown field\(s\): from/);
  assert.throws(() => validateEnvelope({ kind: "approval", body: "hi" }), /kind must be one of/);
  assert.throws(() => validateEnvelope({ kind: "task", body: "hi" }), /objective is required/);
  assert.throws(() => validateEnvelope({ kind: "note", body: "x".repeat(4001) }), /body exceeds/);
  assert.throws(() => validateEnvelope({ kind: "note", body: "hi", correlationId: "../etc/passwd" }), /correlationId/);
  const normalized = validateEnvelope({ kind: "note", body: "hi", correlationId: "cor_1" });
  assert.equal(normalized.kind, "note");
  assert.match(normalized.idempotencyKey, /^relay:[a-f0-9]{32}$/);
});

test("the derived idempotency key is stable for identical envelopes and changes with the body", () => {
  const first = deriveIdempotencyKey({ kind: "note", body: "same", correlationId: "cor_1" });
  const reordered = deriveIdempotencyKey({ correlationId: "cor_1", body: "same", kind: "note" });
  const second = deriveIdempotencyKey({ kind: "note", body: "different", correlationId: "cor_1" });
  assert.equal(first, reordered);
  assert.notEqual(first, second);
  const provided = validateEnvelope({ kind: "note", body: "same", idempotencyKey: "explicit-key" });
  assert.equal(provided.idempotencyKey, "explicit-key");
});

test("send posts the envelope with the bearer credential and reports a replay", async () => {
  const { relay, calls } = relayWith({
    ok: true,
    replayed: true,
    correlationId: "cor_1",
    message: { id: "msg_1", status: "queued", correlationId: "cor_1" }
  });
  const outcome = await relay.send({ kind: "note", body: "hello", correlationId: "cor_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE + "/ax/command/messages");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.authorization, "Bearer " + TOKEN);
  assert.equal(calls[0].body.from, undefined, "direction is decided by the server, never the envelope");
  assert.equal(calls[0].body.kind, "note");
  assert.equal(outcome.id, "msg_1");
  assert.equal(outcome.replayed, true);
});

test("a dry run validates and derives a key without any network call", async () => {
  const { relay, calls } = relayWith({});
  const outcome = await relay.send({ kind: "task", body: "check", objective: "report health", adapter: "runtime.health" }, { dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(outcome.dryRun, true);
  assert.match(outcome.envelope.idempotencyKey, /^relay:/);
});

test("an HTTP failure surfaces the server code without printing the token", async () => {
  const { relay } = relayWith({ ok: false, code: "invalid_token", error: "Ax command authentication required." }, 401);
  await assert.rejects(() => relay.send({ kind: "note", body: "hello" }), error => {
    assert.equal(error.code, "invalid_token");
    assert.equal(error.status, 401);
    assert.equal(String(error.message).includes(TOKEN), false);
    return true;
  });
});

test("the brief is redacted and bounded", async () => {
  const { relay, calls } = relayWith({
    ok: true,
    messages: [
      {
        id: "msg_1",
        kind: "note",
        status: "queued",
        correlationId: "cor_1",
        body: "leaked " + TOKEN + " here",
        evidence: []
      }
    ]
  });
  const text = await relay.brief({ limit: 5 });
  assert.equal(calls[0].url, BASE + "/ax/command/messages?limit=5");
  assert.equal(text.includes(TOKEN), false);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /cannot approve work/);
  assert.ok(text.length <= 6000);
});

test("thread reads one correlation id and refuses path-like input", async () => {
  const { relay, calls } = relayWith({ ok: true, messages: [{ id: "msg_1", correlationId: "cor_1", kind: "note", status: "queued", body: "x" }], awaitingDecision: [] });
  const text = await relay.thread("cor_1");
  assert.equal(calls[0].url, BASE + "/ax/command/messages/thread/cor_1");
  assert.match(text, /# Thread cor_1/);
  await assert.rejects(() => relay.thread("../admin"), /correlationId/);
});

test("redaction covers the credential shapes the channel stores", () => {
  assert.equal(redact("Bearer abcdefghijklmnop").includes("abcdefghijklmnop"), false);
  assert.equal(redact("sk-abcdefgh12345678").includes("sk-abcdefgh"), false);
  assert.equal(redact("ghp_abcdefghijklmnopqrst").includes("ghp_"), false);
});
