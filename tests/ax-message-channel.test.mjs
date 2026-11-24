import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createD1AxMessageRepository } from "../d1-ax-message-repository.mjs";
import { createMessageChannel, redactMessageText } from "../ax-message-channel.mjs";

/**
 * Mission 14 — the Ax <-> NEXUS message channel.
 *
 * Real: the D1 repository (against node:sqlite through a D1-shaped transport), the channel state
 * machine, idempotency, rate limiting, redaction, the HTTP routes and both credentials.
 * Simulated: nothing. No model call is made and none is needed.
 */

const COMMAND_TOKEN = "axcmd_" + "c".repeat(30);
const BRIDGE_TOKEN = "axbridge_" + "b".repeat(30);
const NEXUS_TOKEN = "axnexus_" + "n".repeat(30);

const quiet = { log() {}, warn() {}, error() {} };

function d1Fetch({ db }) {
  return async (url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const statement = db.prepare(sql);
    const rows = /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)
      ? statement.all(...params)
      : (statement.run(...params), []);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
}

async function harness({ rateMax = 30, allowedAdapters = ["runtime.health", "repo.inspect"] } = {}) {
  const db = new DatabaseSync(":memory:");
  const fetchImpl = d1Fetch({ db });
  const repository = createD1AxMessageRepository({
    accountId: "acct-m14",
    databaseId: "db-m14",
    apiToken: "d1_token_m14",
    fetchImpl
  });
  await repository.initialize();
  const audits = [];
  const notifications = [];
  const channel = createMessageChannel({
    repository,
    allowedAdapters,
    rateMax,
    rateWindowMs: 60_000,
    security: { record: async entry => { audits.push(entry); } },
    notifications: { record: async entry => { notifications.push(entry); } },
    log: quiet
  });
  return { db, repository, channel, audits, notifications };
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); },
    use() {}
  };
}

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "registered route: " + key);
  const res = recorder();
  const request = { headers: {}, query: {}, params: {}, body: {}, ...req };
  for (const handler of handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function mount(channel) {
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: {
      HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN,
      HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN,
      AX_NEXUS_TOKEN: NEXUS_TOKEN
    },
    repository: null,
    registry: { summary: () => ({ tools: [] }) },
    messageProvider: () => channel
  });
  return app;
}

const axAuth = { authorization: "Bearer " + COMMAND_TOKEN };
const nexusAuth = { "x-nexus-token": NEXUS_TOKEN };

// ------------------------------------------------------------------ domain behaviour

test("submission is durable and idempotent, and the correlation id is retrievable", async () => {
  const h = await harness();
  const first = await h.channel.submit({
    kind: "task",
    body: "Check the runtime",
    objective: "report runtime health",
    adapter: "runtime.health",
    correlationId: "cor-m14-unit-1",
    idempotencyKey: "unit-key-1"
  });
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(first.message.status, "queued");
  assert.equal(first.message.from, "ax");
  assert.equal(first.message.to, "nexus");
  assert.equal(first.correlationId, "cor-m14-unit-1");

  const duplicate = await h.channel.submit({
    kind: "task",
    body: "Check the runtime",
    objective: "report runtime health",
    adapter: "runtime.health",
    correlationId: "cor-m14-unit-1",
    idempotencyKey: "unit-key-1"
  });
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal((await h.channel.list({ limit: 50 })).length, 1);
});

test("a message may only name an allowlisted read-only adapter and needs an idempotency key", async () => {
  const h = await harness();
  const forbidden = await h.channel.submit({ kind: "task", body: "x", objective: "x", adapter: "shell.exec", idempotencyKey: "k1" });
  assert.equal(forbidden.code, "adapter_not_allowed");
  assert.equal((await h.channel.list({ limit: 10 })).length, 0, "a refused message is not stored");

  const noAdapter = await h.channel.submit({ kind: "task", body: "x", objective: "x", adapter: null, idempotencyKey: "k2" });
  assert.equal(noAdapter.code, "adapter_required");

  const noKey = await h.channel.submit({ kind: "task", body: "x", objective: "x", adapter: "runtime.health" });
  assert.equal(noKey.code, "idempotency_key_required");

  const badKind = await h.channel.submit({ kind: "execute", body: "x", idempotencyKey: "k3" });
  assert.equal(badKind.code, "invalid_kind");

  const empty = await h.channel.submit({ kind: "note", body: "   ", idempotencyKey: "k4" });
  assert.equal(empty.code, "invalid_body");
});

test("secrets are redacted before a message is persisted", async () => {
  const h = await harness();
  const created = await h.channel.submit({
    kind: "note",
    body: "token sk-abcdefghijklmnop and Bearer abcdefghijklmnop should vanish",
    idempotencyKey: "redact-1"
  });
  assert.equal(created.ok, true);
  assert.equal(created.message.body.includes("sk-abcdefghijklmnop"), false);
  assert.match(created.message.body, /\[redacted\]/);
  assert.match(redactMessageText("axcmd_" + "z".repeat(20)), /\[redacted\]/);
});

test("the rate limit refuses the burst without storing the refused message", async () => {
  const h = await harness({ rateMax: 2 });
  for (let i = 0; i < 2; i += 1) {
    const ok = await h.channel.submit({ kind: "note", body: "note " + i, idempotencyKey: "rate-" + i });
    assert.equal(ok.ok, true);
  }
  const limited = await h.channel.submit({ kind: "note", body: "third", idempotencyKey: "rate-3" });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.retryAfterMs, 60_000);
  assert.equal((await h.channel.list({ limit: 20 })).length, 2);
});

test("acknowledge, progress and evidence-backed completion form one retrievable thread", async () => {
  const h = await harness();
  const submitted = await h.channel.submit({
    kind: "task",
    body: "health please",
    objective: "report runtime health",
    adapter: "runtime.health",
    correlationId: "cor-m14-unit-2",
    idempotencyKey: "unit-key-2"
  });
  const id = submitted.message.id;

  assert.equal((await h.channel.acknowledge({ id, executor: "nexus-test" })).message.status, "acknowledged");
  assert.equal((await h.channel.progress({ id, note: "adapter running", percent: 40 })).message.status, "working");

  const noEvidence = await h.channel.complete({ id, summary: "done" });
  assert.equal(noEvidence.code, "evidence_required");
  assert.equal((await h.channel.get(id)).status, "working");

  const completed = await h.channel.complete({
    id,
    summary: "runtime healthy",
    evidence: ["runtime: ok uptime=10s", { summary: "queue: 0 pending" }],
    taskId: "cmd_unit_1"
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.message.status, "completed");
  assert.equal(completed.message.result.evidence.length, 2);

  // A repeated completion is a replay, not a rewrite.
  const again = await h.channel.complete({ id, summary: "other", evidence: ["other"] });
  assert.equal(again.replayed, true);
  assert.equal(again.message.result.summary, "runtime healthy");

  const thread = await h.channel.thread({ correlationId: "cor-m14-unit-2" });
  assert.equal(thread.ok, true);
  assert.equal(thread.count, 1);
  assert.equal(thread.terminal[0].status, "completed");

  const history = await h.repository.list({ correlationId: "cor-m14-unit-2", order: "oldest" });
  assert.equal(history.length, 1);
  assert.ok(history[0].timeline.length >= 3, "the timeline keeps every transition");
  assert.ok(h.audits.some(entry => entry.category === "ax.message.submitted"));
  assert.ok(h.audits.some(entry => entry.category === "ax.message.completed"));
  assert.ok(h.notifications.some(entry => entry.type === "ax.message.completed"));
});

test("NEXUS can ask Ax a question and Ax can answer it", async () => {
  const h = await harness();
  const asked = await h.channel.ask({
    correlationId: "cor-m14-question",
    question: "Should the objective use a paid provider?",
    options: ["yes", "no"],
    objectiveId: "obj_demo"
  });
  assert.equal(asked.ok, true);
  assert.equal(asked.message.from, "nexus");

  const thread = await h.channel.thread({ correlationId: "cor-m14-question" });
  assert.equal(thread.awaitingDecision.length, 1);
  assert.deepEqual(thread.awaitingDecision[0].options, ["yes", "no"]);

  const submitted = await h.channel.submit({
    kind: "question",
    body: "context",
    correlationId: "cor-m14-question",
    idempotencyKey: "question-context-1"
  });
  assert.equal(submitted.ok, true);

  const answered = await h.channel.answer({ id: asked.message.id, answer: "no", by: "ax" });
  assert.equal(answered.ok, true);
  assert.equal(answered.message.status, "answered");
  assert.equal((await h.channel.thread({ correlationId: "cor-m14-question" })).awaitingDecision.length, 0);

  // A NEXUS question cannot be answered twice, and an Ax submission cannot be answered.
  assert.equal((await h.channel.answer({ id: asked.message.id, answer: "yes" })).replayed, true);
  assert.equal((await h.channel.answer({ id: submitted.message.id, answer: "yes" })).code, "invalid_direction");
});

test("a retryable failure returns to the queue and the attempt limit dead-letters it", async () => {
  const h = await harness();
  const submitted = await h.channel.submit({
    kind: "task",
    body: "health",
    objective: "report runtime health",
    adapter: "runtime.health",
    idempotencyKey: "retry-1"
  });
  const id = submitted.message.id;
  const first = await h.channel.fail({ id, code: "executor_unavailable", message: "engine not mounted", retryable: true });
  assert.equal(first.message.status, "queued");
  assert.equal(first.message.attempts, 1);

  await h.channel.fail({ id, code: "executor_unavailable", retryable: true });
  const last = await h.channel.fail({ id, code: "executor_unavailable", retryable: true });
  assert.equal(last.message.status, "dead_letter");
  assert.equal(last.message.attempts, 3);
  assert.ok(h.audits.some(entry => entry.category === "ax.message.dead_letter"));
});

test("drain submits once, completes from real task state and never re-executes", async () => {
  const h = await harness();
  await h.channel.submit({
    kind: "task",
    body: "health",
    objective: "report runtime health",
    adapter: "runtime.health",
    correlationId: "cor-drain",
    idempotencyKey: "drain-1"
  });

  let executions = 0;
  const task = { id: "cmd_drain_1", status: "queued" };
  const execute = async () => { executions += 1; return { ok: true, taskId: task.id }; };
  const check = async () => (task.status === "done"
    ? { status: "done", result: { summary: "healthy", evidence: ["runtime: ok"] } }
    : { status: "working" });

  const first = await h.channel.drain({ execute, check });
  assert.equal(first.submitted, 1);
  assert.equal(executions, 1);
  const [afterSubmit] = await h.channel.list({ status: "working", limit: 10 });
  assert.equal(afterSubmit.taskId, task.id);

  // A tick while the task is still running must not resubmit it.
  const running = await h.channel.drain({ execute, check });
  assert.equal(running.submitted, 0);
  assert.equal(executions, 1);

  task.status = "done";
  const finished = await h.channel.drain({ execute, check });
  assert.equal(finished.completed, 1);
  const thread = await h.channel.thread({ correlationId: "cor-drain" });
  assert.equal(thread.terminal[0].status, "completed");
  assert.deepEqual(thread.terminal[0].result.evidence, ["runtime: ok"]);

  // Nothing is left to claim.
  const idle = await h.channel.drain({ execute, check });
  assert.equal(idle.examined, 0);
});

// ------------------------------------------------------------------ HTTP surface and auth

test("Ax submits and reads; only the NEXUS credential may acknowledge or complete", async () => {
  const h = await harness();
  const app = mount(h.channel);

  const anonymous = await invoke(app, "POST /ax/command/messages", { body: { kind: "note", body: "x", idempotencyKey: "route-anon" } });
  assert.equal(anonymous.statusCode, 401);

  const submitted = await invoke(app, "POST /ax/command/messages", {
    headers: axAuth,
    body: {
      kind: "task",
      body: "check runtime",
      objective: "report runtime health",
      adapter: "runtime.health",
      correlationId: "cor-route",
      idempotencyKey: "route-1",
      // An injected direction must be ignored: the authenticated surface decides it.
      from: "nexus"
    }
  });
  assert.equal(submitted.statusCode, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.message.from, "ax");
  const id = submitted.body.message.id;

  const replay = await invoke(app, "POST /ax/command/messages", {
    headers: axAuth,
    body: { kind: "task", body: "check runtime", objective: "report runtime health", adapter: "runtime.health", correlationId: "cor-route", idempotencyKey: "route-1" }
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.message.id, id);

  // Ax may not touch the NEXUS surface, with either Ax credential.
  for (const token of [COMMAND_TOKEN, BRIDGE_TOKEN]) {
    const refused = await invoke(app, "POST /ax/nexus/messages/:id/acknowledge", {
      headers: { authorization: "Bearer " + token },
      params: { id }
    });
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.body.code, "invalid_nexus_token");
  }

  const acknowledged = await invoke(app, "POST /ax/nexus/messages/:id/acknowledge", {
    headers: nexusAuth,
    params: { id },
    body: { executor: "nexus-test" }
  });
  assert.equal(acknowledged.statusCode, 200);
  assert.equal(acknowledged.body.message.status, "acknowledged");

  const completed = await invoke(app, "POST /ax/nexus/messages/:id/complete", {
    headers: nexusAuth,
    params: { id },
    body: { summary: "healthy", evidence: ["runtime: ok"], taskId: "cmd_route_1" }
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.message.status, "completed");

  const thread = await invoke(app, "GET /ax/command/messages/thread/:correlationId", {
    headers: axAuth,
    params: { correlationId: "cor-route" }
  });
  assert.equal(thread.statusCode, 200);
  assert.equal(thread.body.terminal[0].status, "completed");
  assert.equal(thread.body.messages[0].from, "ax");

  const ask = await invoke(app, "POST /ax/nexus/messages/ask", {
    headers: nexusAuth,
    body: { correlationId: "cor-route", question: "Proceed?", options: ["yes", "no"] }
  });
  assert.equal(ask.statusCode, 201);
  const answered = await invoke(app, "POST /ax/command/messages/:id/answer", {
    headers: axAuth,
    params: { id: ask.body.message.id },
    body: { answer: "yes" }
  });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.body.message.status, "answered");

  // The NEXUS surface fails closed when its credential is not configured at all.
  const unconfigured = makeApp();
  registerUniversalCommandRoutes(unconfigured, {
    env: { HABITAT_AX_COMMAND_TOKEN: COMMAND_TOKEN },
    registry: { summary: () => ({}) },
    messageProvider: () => h.channel
  });
  const closed = await invoke(unconfigured, "GET /ax/nexus/inbox", {});
  assert.equal(closed.statusCode, 503);
  assert.equal(closed.body.code, "nexus_auth_unconfigured");
});
