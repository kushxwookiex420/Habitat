import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { createGatewayRepository } from "../d1-gateway-repository.mjs";
import { issueClientToken, registerAxGateway } from "../ax-gateway.mjs";
import { createWorkforceV1Repository } from "../d1-workforce-v1-repository.mjs";
import { createWorkforceV1 } from "../ax-workforce-v1.mjs";

/**
 * Habitat workforce contract over real HTTP.
 *
 * The routes are the dashboard's only source of truth, so what is checked here is the shape an operator
 * will rely on: status totals, worker details, live assignments, heartbeat ages, recovery history and the
 * mission-to-worker link. Mutations need the write scope; reads need the read scope.
 */

const quiet = { log() {}, warn() {}, error() {} };
const START = Date.parse("2026-11-24T18:00:00.000Z");
let NOW = START;
const now = () => NOW;

function sqliteQuery(db) {
  return async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    if (/\breturning\b/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
}

async function harness() {
  const db = new DatabaseSync(":memory:");
  const query = sqliteQuery(db);
  const gatewayRepository = createGatewayRepository({ query, now: () => new Date(NOW).toISOString() });
  await gatewayRepository.initialize();
  const leasesRepository = createWorkforceV1Repository({ query, now: () => new Date(NOW).toISOString() });
  await leasesRepository.initialize();
  const leases = createWorkforceV1({ repository: leasesRepository, now, log: quiet });

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerAxGateway(app, {
    enabled: true,
    repository: gatewayRepository,
    workforceV1: leases,
    rateLimit: { windowMs: 60_000, max: 600 },
    now,
    log: quiet,
    statusProvider: async () => ({ version: "test", components: { workforce: { state: "running" } } })
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  server.unref();
  return { db, leases, gatewayRepository, server, base: "http://127.0.0.1:" + server.address().port };
}

async function token(h, scopes) {
  const issued = await issueClientToken({ repository: h.gatewayRepository, label: "Dashboard", scopes, now: () => new Date(NOW).toISOString() });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return issued.token;
}

function mutation() {
  return { "x-ax-nonce": "n" + Math.random().toString(36).slice(2) + NOW.toString(36), "x-ax-timestamp": String(NOW) };
}

async function call(h, method, path, { bearer = null, body = null } = {}) {
  const response = await fetch(h.base + path, {
    method,
    headers: {
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      ...(body !== null && method !== "GET" ? { "content-type": "application/json", ...mutation() } : {})
    },
    body: body === null ? undefined : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() };
}

test("every workforce route refuses an unauthenticated caller", async () => {
  const h = await harness();
  for (const route of ["/ax/v1/workforce", "/ax/v1/workforce/workers", "/ax/v1/workforce/assignments", "/ax/v1/workforce/health", "/ax/v1/workforce/recovery"]) {
    const response = await call(h, "GET", route);
    assert.equal(response.status, 401, route);
    assert.equal(response.json.code, "gateway_token_required");
  }
  h.server.close();
  h.db.close();
});

test("registration, heartbeat, status, assignments, recovery and mission links are served with the right scopes", async () => {
  NOW = START;
  const h = await harness();
  const reader = await token(h, ["workforce:read"]);
  const writer = await token(h, ["workforce:read", "workforce:write"]);

  // A read-only client cannot mutate the workforce.
  const forbidden = await call(h, "POST", "/ax/v1/workforce/workers", {
    bearer: reader,
    body: { id: "worker-a", capabilities: ["engineering"] }
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, "gateway_scope_required");

  const registered = await call(h, "POST", "/ax/v1/workforce/workers", {
    bearer: writer,
    body: { id: "worker-a", label: "Engineering A", specialty: "engineering", capabilities: ["engineering", "repo_analysis"], maxConcurrent: 2 }
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  assert.equal(registered.json.worker.id, "worker-a");
  assert.equal(registered.json.created, true);

  const worker = await call(h, "GET", "/ax/v1/workforce/workers/worker-a", { bearer: reader });
  assert.equal(worker.status, 200);
  assert.equal(worker.json.worker.health.status, "healthy");
  assert.equal(worker.json.assignments.length, 0);

  const unknown = await call(h, "GET", "/ax/v1/workforce/workers/worker-missing", { bearer: reader });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, "worker_unknown");

  const lease = await h.leases.acquire({ taskId: "msn_dash.t1", missionId: "msn_dash", workerId: "worker-a", requires: ["engineering"] });
  assert.equal(lease.ok, true);

  const status = await call(h, "GET", "/ax/v1/workforce", { bearer: reader });
  assert.equal(status.status, 200);
  assert.equal(status.json.workforce.workers.total, 1);
  assert.equal(status.json.workforce.activeAssignments.count, 1);
  assert.equal(status.json.workforce.activeAssignments.items[0].missionId, "msn_dash");
  assert.equal(status.json.workforce.migration, "0018_ax_workforce_v1");
  assert.equal(status.json.workforce.leases.active, 1);

  const assignments = await call(h, "GET", "/ax/v1/workforce/assignments", { bearer: reader });
  assert.equal(assignments.json.count, 1);
  assert.equal(assignments.json.assignments[0].workerId, "worker-a");

  const linked = await call(h, "GET", "/ax/v1/workforce/missions/msn_dash", { bearer: reader });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.json.workers, ["worker-a"]);
  assert.equal(linked.json.tasks[0].taskId, "msn_dash.t1");
  assert.equal(linked.json.tasks[0].active, true);

  // The heartbeat is what the dashboard reads to decide whether a worker is alive.
  const beaten = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/heartbeat", { bearer: writer, body: { state: "online" } });
  assert.equal(beaten.status, 200);
  assert.equal(beaten.json.health.status, "healthy");
  NOW = START + 5 * 60_000;
  const stale = await call(h, "GET", "/ax/v1/workforce/health", { bearer: reader });
  assert.equal(stale.status, 200);
  assert.equal(stale.json.health.unresponsiveWorkers, 1);
  assert.equal(stale.json.workers.byHealth.stalled, 1);
  assert.equal(stale.json.heartbeat[0].workerId, "worker-a");
  assert.equal(stale.json.heartbeat[0].status, "stalled");

  // Recovery history is queryable per mission and survives the sweep.
  const swept = await h.leases.expireAbandonedLeases();
  assert.equal(swept.ok, true);
  const recovery = await call(h, "GET", "/ax/v1/workforce/recovery?missionId=msn_dash", { bearer: reader });
  assert.equal(recovery.status, 200);
  assert.ok(recovery.json.events.some((event) => event.kind === "lease.expired"), JSON.stringify(recovery.json));

  // A stalled worker is told to come back: the heartbeat restores availability before the next claim.
  const recalled = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/heartbeat", { bearer: writer, body: { state: "online" } });
  assert.equal(recalled.status, 200);
  assert.equal(recalled.json.health.status, "healthy");

  // Deregistration is refused while a live lease exists, and allowed with force.
  const second = await h.leases.acquire({ taskId: "msn_dash.t2", missionId: "msn_dash", workerId: "worker-a", requires: ["engineering"] });
  assert.equal(second.ok, true, JSON.stringify(second));
  const guarded = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/deregister", { bearer: writer, body: { reason: "maintenance" } });
  assert.equal(guarded.status, 409);
  assert.equal(guarded.json.code, "worker_has_active_leases");
  const forced = await call(h, "POST", "/ax/v1/workforce/workers/worker-a/deregister", { bearer: writer, body: { reason: "retired", force: true } });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.worker.state, "deregistered");

  h.server.close();
  h.db.close();
});

test("the workforce routes answer 503 when no lease layer is attached", async () => {
  const db = new DatabaseSync(":memory:");
  const query = sqliteQuery(db);
  const gatewayRepository = createGatewayRepository({ query, now });
  await gatewayRepository.initialize();
  const app = express();
  app.use(express.json());
  registerAxGateway(app, { enabled: true, repository: gatewayRepository, workforceV1: null, now, log: quiet });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  server.unref();
  const base = "http://127.0.0.1:" + server.address().port;
  const issued = await issueClientToken({ repository: gatewayRepository, label: "Dashboard", scopes: ["workforce:read"], now: () => new Date(NOW).toISOString() });
  const response = await fetch(base + "/ax/v1/workforce", { headers: { authorization: "Bearer " + issued.token } });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "workforce_leases_not_attached");
  server.close();
  db.close();
});
