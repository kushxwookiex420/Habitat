import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import express from "express";
import { createGatewayRepository } from "../d1-gateway-repository.mjs";
import { issueClientToken, resolveClientToken } from "../ax-gateway.mjs";
import { registerMcpEvents } from "../ax-mcp-events.mjs";
import { createMcpRepository } from "../d1-mcp-repository.mjs";
import {
  createMcpEventsServer, EVENT_NAMES, MCP_SCOPE, signWebhook, verifyWebhookSignature, decodeSecret,
  validateCallbackUrl, subscriptionIdFor, canonicalJson
} from "../ax-mcp-events.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const START = Date.parse("2026-11-24T18:00:00.000Z");
const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const SECRET_TWO = "whsec_" + Buffer.alloc(32, 9).toString("base64");

function db() {
  const database = new DatabaseSync(":memory:");
  const query = async (sql, params = []) => {
    const statement = database.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
  return { database, query };
}

async function callbackReceiver({ failFirst = 0, alwaysFail = false } = {}) {
  const received = [];
  const verifications = [];
  let failures = failFirst;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (parsed?.type === "verification") {
        verifications.push({ challenge: parsed.challenge, url: req.url });
        const signature = verifyWebhookSignature({ secret: SECRET, id: req.headers["webhook-id"], timestamp: req.headers["webhook-timestamp"], body, signature: req.headers["webhook-signature"], now: START });
        res.writeHead(signature.ok ? 200 : 400, { "content-type": "application/json" });
        return res.end(JSON.stringify(signature.ok ? { challenge: parsed.challenge } : { error: "bad signature" }));
      }
      received.push({ headers: req.headers, body, parsed });
      if (alwaysFail || failures > 0) {
        if (!alwaysFail) failures -= 1;
        res.writeHead(500);
        return res.end("fail");
      }
      res.writeHead(202);
      res.end("ok");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return {
    received, verifications,
    url: "http://127.0.0.1:" + server.address().port + "/callback",
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function harness({ receiver = null, allowInsecureCallbacks = true } = {}) {
  const { database, query } = db();
  const clock = { value: START };
  const repo = createMcpRepository({ query, now: () => new Date(clock.value).toISOString() });
  await repo.initialize();
  const server = createMcpEventsServer({
    repository: repo,
    now: () => clock.value,
    allowInsecureCallbacks,
    retryBaseMs: 1000,
    maxAttempts: 5,
    log: quiet
  });
  return { database, repo, server, clock, receiver };
}

let seq = 0;
async function subscribe(h, receiver, overrides = {}) {
  seq += 1;
  const result = await h.server.handleRpc({
    jsonrpc: "2.0", id: seq, method: "events/subscribe",
    params: {
      name: "mission.completed",
      arguments: { project: "habitat" },
      delivery: { mode: "webhook", url: receiver.url, secret: SECRET },
      cursor: null,
      ...overrides
    }
  }, { principal: "gw-alpha" });
  return result;
}

test("initialize advertises events and negotiates a supported protocol version", async () => {
  const h = await harness();
  const init = await h.server.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.capabilities.events, {});
  assert.equal(init.result.serverInfo.name, "habitat-ax");

  const unknown = await h.server.handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(unknown.result.protocolVersion, "2025-06-18");

  const discover = await h.server.handleRpc({ jsonrpc: "2.0", id: 3, method: "server/discover" });
  assert.equal(discover.result.resultType, "complete");
  assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discover.result.capabilities.events, {});
  h.database.close();
});

test("events/list exposes the catalog with delivery modes and filters", async () => {
  const h = await harness();
  const listed = await h.server.handleRpc({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} });
  const names = listed.result.events.map(event => event.name);
  for (const name of ["mission.created", "mission.started", "mission.completed", "mission.failed", "verification.completed", "approval.required", "approval.resolved", "worker.unavailable", "recovery.required", "deployment.status.changed", "security.incident", "business.operation.changed", "heartbeat.reconnect"]) {
    assert.ok(names.includes(name), "missing " + name);
  }
  const completed = listed.result.events.find(event => event.name === "mission.completed");
  assert.deepEqual(completed.delivery, ["webhook"]);
  assert.ok(completed.inputSchema.properties.project);
  assert.ok(completed.payloadSchema);
  assert.equal(listed.result.nextCursor, undefined);
  h.database.close();
});

test("subscribe verifies the callback, persists the subscription and returns a refresh time", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  const subscribed = await subscribe(h, receiver);
  assert.equal(subscribed.error, undefined, JSON.stringify(subscribed.error));
  assert.match(subscribed.result.id, /^sub_/);
  assert.ok(Date.parse(subscribed.result.refreshBefore) > START);
  assert.equal(subscribed.result.cursor, null);
  assert.equal(subscribed.result.truncated, false);
  assert.equal(receiver.verifications.length, 1);
  assert.doesNotMatch(JSON.stringify(subscribed.result), /whsec_/);

  const stored = await h.repo.getSubscription(subscribed.result.id);
  assert.equal(stored.principal, "gw-alpha");
  assert.equal(stored.name, "mission.completed");
  assert.equal(stored.secret, SECRET);
  h.database.close();
  await receiver.close();
});

test("subscribe is idempotent and refresh extends an existing subscription", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  const first = await subscribe(h, receiver);
  h.clock.value += 60_000;
  const second = await subscribe(h, receiver);
  assert.equal(second.result.id, first.result.id);
  assert.ok(Date.parse(second.result.refreshBefore) > Date.parse(first.result.refreshBefore));
  const all = await h.repo.listSubscriptions({});
  assert.equal(all.length, 1, "a repeated subscribe must not create a second row");
  h.database.close();
  await receiver.close();
});

test("a callback that does not echo the challenge is refused with -32015", async () => {
  const refusing = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ challenge: "wrong" })); });
  await new Promise(resolve => refusing.listen(0, "127.0.0.1", resolve));
  const receiver = { url: "http://127.0.0.1:" + refusing.address().port + "/callback", received: [], verifications: [], close: () => new Promise(resolve => refusing.close(resolve)) };
  const h = await harness({ receiver });
  const result = await subscribe(h, receiver, { name: "mission.created" });
  assert.equal(result.error.code, -32015);
  assert.equal(result.error.data.reason, "challenge_failed");
  assert.equal((await h.repo.listSubscriptions({})).length, 0);
  h.database.close();
  await receiver.close();
});

test("invalid secrets, unsupported events and insecure callbacks are rejected", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  const badSecret = await subscribe(h, receiver, { delivery: { mode: "webhook", url: receiver.url, secret: "whsec_short" } });
  assert.equal(badSecret.error.code, -32602);
  assert.equal(badSecret.error.data.reason, "secret_invalid");

  const unknownEvent = await subscribe(h, receiver, { name: "comment.created" });
  assert.equal(unknownEvent.error.code, -32602);
  assert.equal(unknownEvent.error.data.reason, "event_unknown");

  const strict = createMcpEventsServer({ repository: h.repo, now: () => h.clock.value, allowInsecureCallbacks: false, log: quiet });
  const httpRejected = await strict.handleRpc({ jsonrpc: "2.0", id: 9, method: "events/subscribe", params: { name: "mission.completed", arguments: {}, delivery: { mode: "webhook", url: "http://127.0.0.1:9/callback", secret: SECRET } } }, { principal: "gw-alpha" });
  assert.equal(httpRejected.error.code, -32602);
  assert.equal(httpRejected.error.data.reason, "https_required");
  h.database.close();
  await receiver.close();
});

test("unauthenticated subscriptions and cross-account unsubscribe are refused or isolated", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  const anonymous = await h.server.handleRpc({ jsonrpc: "2.0", id: 1, method: "events/subscribe", params: { name: "mission.completed", arguments: {}, delivery: { mode: "webhook", url: receiver.url, secret: SECRET } } });
  assert.equal(anonymous.error.code, -32001);

  const subscribed = await subscribe(h, receiver);
  const cross = await h.server.handleRpc({ jsonrpc: "2.0", id: 2, method: "events/unsubscribe", params: { name: "mission.completed", arguments: { project: "habitat" }, delivery: { mode: "webhook", url: receiver.url } } }, { principal: "gw-beta" });
  assert.deepEqual(cross.result, {});
  assert.equal((await h.repo.getSubscription(subscribed.result.id)).revokedAt, null, "another principal must not revoke it");
  h.database.close();
  await receiver.close();
});

test("delivery signs the exact body, respects filters and never duplicates", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  await subscribe(h, receiver);

  await h.server.emit({ name: "mission.completed", data: { project: "other", missionId: "msn_other", status: "completed" } });
  assert.equal((await h.server.dispatch()).delivered, 0, "a non-matching project must not be delivered");

  const emitted = await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_1", status: "completed", summary: "done" } });
  assert.equal(emitted.queued, 1);
  const dispatched = await h.server.dispatch();
  assert.equal(dispatched.delivered, 1);
  assert.equal(receiver.received.length, 1);
  const payload = receiver.received[0];
  assert.equal(payload.parsed.name, "mission.completed");
  assert.equal(payload.parsed.data.missionId, "msn_1");
  assert.equal(payload.parsed.eventId, emitted.event.eventId);
  assert.equal(payload.headers["x-mcp-subscription-id"].startsWith("sub_"), true);
  const verified = verifyWebhookSignature({ secret: SECRET, id: payload.headers["webhook-id"], timestamp: payload.headers["webhook-timestamp"], body: payload.body, signature: payload.headers["webhook-signature"], now: START });
  assert.equal(verified.ok, true);

  assert.equal((await h.server.dispatch()).attempted, 0);
  assert.equal(receiver.received.length, 1);
  h.database.close();
  await receiver.close();
});

test("a tampered signature or body fails Standard Webhooks verification", () => {
  const body = JSON.stringify({ eventId: "evt_1", name: "mission.created" });
  const signature = signWebhook({ secret: SECRET, id: "evt_1", timestamp: "100", body });
  assert.equal(verifyWebhookSignature({ secret: SECRET, id: "evt_1", timestamp: "100", body, signature, now: 100_000 }).ok, true);
  assert.equal(verifyWebhookSignature({ secret: SECRET_TWO, id: "evt_1", timestamp: "100", body, signature, now: 100_000 }).ok, false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, id: "evt_2", timestamp: "100", body, signature, now: 100_000 }).ok, false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, id: "evt_1", timestamp: "100", body: body + " ", signature, now: 100_000 }).ok, false);
  assert.equal(verifyWebhookSignature({ secret: SECRET, id: "evt_1", timestamp: "100", body, signature, now: 1_000_000 }).code, "timestamp_invalid");
  assert.equal(decodeSecret("not-a-secret"), null);
});

test("unsubscribe stops delivery and is idempotent", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  await subscribe(h, receiver);
  const stopped = await h.server.handleRpc({ jsonrpc: "2.0", id: 2, method: "events/unsubscribe", params: { name: "mission.completed", arguments: { project: "habitat" }, delivery: { mode: "webhook", url: receiver.url } } }, { principal: "gw-alpha" });
  assert.deepEqual(stopped.result, {});
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_2" } });
  assert.equal((await h.server.dispatch()).delivered, 0);
  const again = await h.server.handleRpc({ jsonrpc: "2.0", id: 3, method: "events/unsubscribe", params: { name: "mission.completed", arguments: { project: "habitat" }, delivery: { mode: "webhook", url: receiver.url } } }, { principal: "gw-alpha" });
  assert.deepEqual(again.result, {});
  h.database.close();
  await receiver.close();
});

test("expired subscriptions stop delivering and expired rows are cleaned up", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  const subscribed = await subscribe(h, receiver, { ttlMs: 60_000 });
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_3" } });
  h.clock.value += 61_000;
  const dispatched = await h.server.dispatch();
  assert.equal(dispatched.delivered, 0);
  assert.equal(receiver.received.length, 0);
  assert.ok((await h.repo.getSubscription(subscribed.result.id)).revokedAt, "the expired subscription is revoked");
  h.database.close();
  await receiver.close();
});

test("secret rotation signs with both keys during the grace window", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  const first = await subscribe(h, receiver);
  const rotated = await subscribe(h, receiver, { delivery: { mode: "webhook", url: receiver.url, secret: SECRET_TWO } });
  assert.equal(rotated.result.id, first.result.id);
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_4" } });
  await h.server.dispatch();
  const headers = receiver.received[0].headers;
  const signatures = headers["webhook-signature"].split(" ");
  assert.equal(signatures.length, 2);
  const body = receiver.received[0].body;
  const results = signatures.map(signature => ({
    old: verifyWebhookSignature({ secret: SECRET, id: headers["webhook-id"], timestamp: headers["webhook-timestamp"], body, signature, now: START }).ok,
    new: verifyWebhookSignature({ secret: SECRET_TWO, id: headers["webhook-id"], timestamp: headers["webhook-timestamp"], body, signature, now: START }).ok
  }));
  assert.ok(results.some(result => result.old), "the previous key must verify one signature");
  assert.ok(results.some(result => result.new), "the new key must verify one signature");
  h.database.close();
  await receiver.close();
});

test("subscription state and queued deliveries survive a restart", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  await subscribe(h, receiver);
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_restart" } });

  const restarted = createMcpEventsServer({ repository: h.repo, now: () => h.clock.value, allowInsecureCallbacks: true, log: quiet });
  const dispatched = await restarted.dispatch();
  assert.equal(dispatched.delivered, 1);
  assert.equal(receiver.received.length, 1);
  h.database.close();
  await receiver.close();
});

test("cursor replay recovers events that predate the subscription", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  const emitted = await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_before" } });
  const subscribed = await subscribe(h, receiver, { cursor: 0 });
  assert.equal(subscribed.result.cursor, 0);
  assert.equal(subscribed.result.replayed, 1);
  await h.server.dispatch();
  assert.equal(receiver.received.length, 1);
  assert.equal(receiver.received[0].parsed.eventId, emitted.event.eventId);
  h.database.close();
  await receiver.close();
});

test("retry exhaustion marks a delivery dead after bounded attempts", async () => {
  const receiver = await callbackReceiver({ alwaysFail: true });
  const h = await harness({ receiver });
  await subscribe(h, receiver);
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_dead" } });
  let last = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await h.server.dispatch();
    h.clock.value += 60 * 60_000;
  }
  assert.equal(last.dead, 1);
  const deliveries = await h.repo.listDeliveries({});
  assert.equal(deliveries[0].status, "dead");
  assert.equal(deliveries[0].attempts, 5);
  assert.equal(receiver.received.length, 5);
  h.database.close();
  await receiver.close();
});

test("a failed callback is retried and recovers without losing the event", async () => {
  const receiver = await callbackReceiver({ failFirst: 1 });
  const h = await harness({ receiver });
  await subscribe(h, receiver);
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_recover" } });
  const first = await h.server.dispatch();
  assert.equal(first.failed, 1);
  h.clock.value += 60_000;
  const second = await h.server.dispatch();
  assert.equal(second.delivered, 1);
  assert.equal(receiver.received.length, 2);
  h.database.close();
  await receiver.close();
});

test("heartbeat events map to catalog events and the reconnect trigger is preserved", async () => {
  const receiver = await callbackReceiver();
  const h = await harness({ receiver });
  await subscribe(h, receiver, { name: "mission.completed" });
  const emitted = await h.server.ingestHeartbeatEvents([
    { id: "evt_hb_1", kind: "mission_status", payload: { missionId: "msn_hb", status: "completed", objective: "done" } }
  ]);
  assert.ok(emitted.some(item => item.event?.name === "mission.completed"));
  await h.server.dispatch();
  assert.equal(receiver.received.length, 1);

  const connection = await h.server.emit({
    name: "heartbeat.reconnect",
    data: { trigger: "AX RECONNECT — HABITAT HEARTBEAT.", health: { status: "ok" }, active: [], completed: [], failed: [], pendingTasks: [], approvals: [], recommendedAction: "Call getHeartbeat through the gateway." }
  });
  assert.equal(connection.ok, true);
  h.database.close();
  await receiver.close();
});

test("the HTTP endpoint requires a gateway token with the MCP events scope", async () => {
  const h = await harness();
  const gateway = createGatewayRepository({ query: h.database ? (async (sql, params = []) => {
    const statement = h.database.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  }) : null, now: () => new Date(START).toISOString() });
  await gateway.initialize();
  const scoped = await issueClientToken({ repository: gateway, label: "MCP", scopes: ["mcp:events"], now: () => new Date(START).toISOString() });
  const unscoped = await issueClientToken({ repository: gateway, label: "Read only", scopes: ["status:read"], now: () => new Date(START).toISOString() });

  const app = express();
  app.use(express.json());
  registerMcpEvents(app, {
    enabled: true,
    server: h.server,
    authenticate: req => resolveClientToken({ repository: gateway, authorization: req.headers.authorization, scope: MCP_SCOPE, now: () => START }),
    log: quiet
  });
  const httpServer = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  httpServer.unref();
  const base = "http://127.0.0.1:" + httpServer.address().port;

  const anonymous = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list" }) });
  assert.equal(anonymous.status, 401);
  const wrongScope = await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + unscoped.token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list" }) });
  assert.equal(wrongScope.status, 403);
  const initialized = await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + scoped.token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } }) });
  assert.equal(initialized.status, 200);
  assert.deepEqual((await initialized.json()).result.capabilities, { events: {} });
  const notification = await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + scoped.token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notification.status, 202);
  h.database.close();
  await new Promise(resolve => httpServer.close(resolve));
});

test("subscription IDs are deterministic over canonical arguments but separated by principal", () => {
  const a = subscriptionIdFor({ principal: "gw-a", name: "mission.created", argsCanonical: canonicalJson({ project: "habitat", mission_id: "m1" }), url: "https://example.com/cb" });
  const b = subscriptionIdFor({ principal: "gw-a", name: "mission.created", argsCanonical: canonicalJson({ mission_id: "m1", project: "habitat" }), url: "https://example.com/cb" });
  const c = subscriptionIdFor({ principal: "gw-b", name: "mission.created", argsCanonical: canonicalJson({ project: "habitat", mission_id: "m1" }), url: "https://example.com/cb" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(MCP_SCOPE);
  assert.ok(EVENT_NAMES.includes("heartbeat.reconnect"));
  validateCallbackUrl("https://example.com/cb").then(result => assert.equal(result.ok, true));
});
