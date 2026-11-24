import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { buildMissionEnvironment } from "../mission-harness.mjs";

/**
 * These are HTTP tests: a real node:http server, real sockets, real `fetch`, the real route handlers and the
 * real `requireAx` guard. The only thing that differs from production is the storage behind the D1-shaped
 * query (SQLite on disk) and the app's route table, which is the same interface the real service uses.
 */

const TOKEN = "mission_http_" + "t".repeat(28);
const ROOT = process.cwd();

function makeApp() {
  const routes = new Map();
  const compile = (pattern) => {
    const names = [];
    const regex = new RegExp("^" + pattern.replace(/:[A-Za-z0-9_]+/g, (match) => {
      names.push(match.slice(1));
      return "([^/]+)";
    }) + "$");
    return { regex, names };
  };
  return {
    routes,
    get(pattern, ...handlers) { routes.set("GET " + pattern, { ...compile(pattern), handlers }); },
    post(pattern, ...handlers) { routes.set("POST " + pattern, { ...compile(pattern), handlers }); }
  };
}

async function startServer({ provider = null } = {}) {
  const app = makeApp();
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_COMMAND_TOKEN: TOKEN },
    missionProvider: () => provider
  });

  const server = http.createServer(async (raw, res) => {
    const url = new URL(raw.url, "http://127.0.0.1");
    let body = "";
    for await (const chunk of raw) body += chunk;
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = null; }
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      setHeader() { return this; },
      json(payload) {
        const text = JSON.stringify(payload);
        res.writeHead(this.statusCode, { "content-type": "application/json" });
        res.end(text);
        return this;
      }
    };
    // Match by method and compiled pattern, so parameterised routes are real routes.
    let entry = null;
    let match = null;
    for (const [key, candidate] of app.routes) {
      if (key.split(" ")[0] !== raw.method) continue;
      const found = candidate.regex.exec(url.pathname);
      if (found) { entry = candidate; match = found; break; }
    }
    if (!entry) return response.status(404).json({ ok: false, code: "not_found" });
    const params = {};
    entry.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
    const request = {
      method: raw.method,
      path: url.pathname,
      originalUrl: raw.url,
      headers: raw.headers,
      query: Object.fromEntries(url.searchParams.entries()),
      params,
      body: parsed,
      ip: "127.0.0.1"
    };
    let index = 0;
    const next = async () => {
      if (index >= entry.handlers.length) return;
      const handler = entry.handlers[index];
      index += 1;
      return handler(request, response, next);
    };
    try {
      await next();
    } catch (error) {
      if (!res.writableEnded) response.status(500).json({ ok: false, code: "handler_threw", error: String(error?.message || error) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    base: "http://127.0.0.1:" + port,
    close: () => new Promise((resolve) => {
      // fetch keeps sockets alive; closing them explicitly keeps a real HTTP test from hanging on teardown.
      server.closeAllConnections?.();
      server.close(resolve);
    })
  };
}

async function call(base, method, path, { token = TOKEN, body = null } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json() };
}

let dirCounter = 0;
async function workspace() {
  dirCounter += 1;
  return mkdtemp(path.join(os.tmpdir(), "habitat-mission-http-" + process.pid + "-" + dirCounter + "-"));
}

const OBJECTIVE = "Assess the repository tests and verify the priority policy suite";
const CRITERIA = ["Tests tree analysed", "Priority suite verified"];
const TASKS = [
  { id: "t1", title: "Analyse the repository tests tree", requires: ["engineering"], dependsOn: [], criteria: [0] },
  { id: "t2", title: "Run tests/ax-priority-policy.test.mjs", requires: ["testing"], dependsOn: ["t1"], criteria: [1] }
];

test("HTTP: unauthorized and unconfigured requests are refused before any work", async () => {
  const base = await workspace();
  const env = await buildMissionEnvironment({ rootDir: ROOT, artifactsDir: path.join(base, "artifacts"), dbPath: path.join(base, "db.sqlite") });
  const server = await startServer({ provider: env.pipeline && {
    submit: (spec) => env.pipeline.submit(spec),
    run: (id, options) => env.pipeline.run(id, options),
    get: async (id) => { const loaded = await env.missions.get(id); return loaded ? loaded.record : null; },
    events: (id) => env.missions.events(id)
  } });
  try {
    const anonymous = await call(server.base, "POST", "/ax/missions", { token: null, body: { objective: OBJECTIVE, acceptanceCriteria: CRITERIA } });
    assert.equal(anonymous.status, 401);
    const wrong = await call(server.base, "POST", "/ax/missions", { token: "nope", body: { objective: OBJECTIVE, acceptanceCriteria: CRITERIA } });
    assert.equal(wrong.status, 401);

    const unconfigured = await startServer({ provider: null });
    try {
      const response = await call(unconfigured.base, "POST", "/ax/missions", { body: { objective: OBJECTIVE, acceptanceCriteria: CRITERIA } });
      assert.equal(response.status, 503);
      assert.equal(response.json.code, "mission_pipeline_unavailable");
      assert.match(response.json.error, /HABITAT_WORKFORCE_ENABLED/);
    } finally {
      await unconfigured.close();
    }
  } finally {
    await server.close();
    await env.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("HTTP: an authenticated objective becomes a durable, verified, retrievable mission", async () => {
  const base = await workspace();
  const artifacts = path.join(base, "artifacts");
  const dbPath = path.join(base, "db.sqlite");
  const env = await buildMissionEnvironment({ rootDir: ROOT, artifactsDir: artifacts, dbPath });
  const provider = {
    submit: (spec) => env.pipeline.submit(spec),
    run: (id, options) => env.pipeline.run(id, options),
    get: async (id) => { const loaded = await env.missions.get(id); return loaded ? loaded.record : null; },
    events: (id) => env.missions.events(id)
  };
  const server = await startServer({ provider });
  try {
    const created = await call(server.base, "POST", "/ax/missions", { body: {
      objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "http-1", constraints: ["test-run"]
    } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.mission.status, "planned");
    const missionId = created.json.mission.missionId;

    // A duplicate request is a replay of the same durable mission.
    const duplicate = await call(server.base, "POST", "/ax/missions", { body: {
      objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "http-1"
    } });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.replay, true);
    assert.equal(duplicate.json.mission.missionId, missionId);

    const run = await call(server.base, "POST", "/ax/missions/" + missionId + "/run", { body: { maxRounds: 3 } });
    assert.equal(run.status, 200, JSON.stringify(run.json));
    assert.equal(run.json.run.status, "completed");

    const fetched = await call(server.base, "GET", "/ax/missions/" + missionId);
    assert.equal(fetched.status, 200);
    const mission = fetched.json.mission;
    assert.equal(mission.status, "completed");
    assert.equal(mission.tasks.length, 2);
    for (const task of mission.tasks) {
      assert.equal(task.status, "completed");
      assert.equal(task.verifierAgentId, "worker-verifier");
      assert.ok(task.evidence.length > 0);
      assert.ok(task.verificationEvidence.length > 0);
    }
    assert.ok(fetched.json.events.some((event) => event.type === "mission.completed"));

    // A mission that survived the server's own lifetime is retrieved after a real restart below.
    await server.close();

    const env2 = await buildMissionEnvironment({ rootDir: ROOT, artifactsDir: artifacts, dbPath });
    const server2 = await startServer({ provider: {
      submit: (spec) => env2.pipeline.submit(spec),
      run: (id, options) => env2.pipeline.run(id, options),
      get: async (id) => { const loaded = await env2.missions.get(id); return loaded ? loaded.record : null; },
      events: (id) => env2.missions.events(id)
    } });
    try {
      const after = await call(server2.base, "GET", "/ax/missions/" + missionId);
      assert.equal(after.status, 200, "the mission is readable from a new process on the same store");
      assert.equal(after.json.mission.status, "completed");
      assert.deepEqual(after.json.mission.tasks.map((task) => task.verifierAgentId), ["worker-verifier", "worker-verifier"]);
      assert.ok(after.json.mission.tasks.every((task) => task.evidence.length > 0), "evidence survived the restart");
      const rerun = await call(server2.base, "POST", "/ax/missions/" + missionId + "/run", { body: {} });
      assert.equal(rerun.status, 200);
      const stillOne = await call(server2.base, "POST", "/ax/missions", { body: {
        objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "http-1"
      } });
      assert.equal(stillOne.json.mission.missionId, missionId, "no second mission after restart");
    } finally {
      await server2.close();
      await env2.close();
    }
  } finally {
    if (typeof env.close === "function") { try { env.close(); } catch {} }
    await rm(base, { recursive: true, force: true });
  }
});

test("HTTP: approval-required work never starts through the API", async () => {
  const base = await workspace();
  const env = await buildMissionEnvironment({ rootDir: ROOT, artifactsDir: path.join(base, "artifacts"), dbPath: path.join(base, "db.sqlite") });
  const server = await startServer({ provider: {
    submit: (spec) => env.pipeline.submit(spec),
    run: (id, options) => env.pipeline.run(id, options),
    get: async (id) => { const loaded = await env.missions.get(id); return loaded ? loaded.record : null; },
    events: (id) => env.missions.events(id)
  } });
  try {
    const refused = await call(server.base, "POST", "/ax/missions", { body: {
      objective: "Deploy the service to production",
      acceptanceCriteria: ["It is deployed"],
      tasks: [{ id: "a1", title: "Deploy to production", requires: ["engineering"], criteria: [0] }]
    } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, "approval_required_for_task");

    const gated = await call(server.base, "POST", "/ax/missions", { body: {
      objective: "Deploy the service to production",
      acceptanceCriteria: ["It is deployed"],
      tasks: [{ id: "a1", title: "Deploy to production", requires: ["engineering"], criteria: [0], approvalRequired: true }]
    } });
    assert.equal(gated.status, 201);
    const missionId = gated.json.mission.missionId;
    const run = await call(server.base, "POST", "/ax/missions/" + missionId + "/run", { body: {} });
    assert.equal(run.status, 200);
    assert.equal(run.json.run.status, "approval_required");
    const fetched = await call(server.base, "GET", "/ax/missions/" + missionId);
    assert.equal(fetched.json.mission.tasks[0].status, "pending");
    assert.equal(fetched.json.mission.tasks[0].agentId, null);
  } finally {
    await server.close();
    await env.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("HTTP: a dishonest verifier cannot produce a completed mission", async () => {
  const base = await workspace();
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(base, "artifacts"),
    dbPath: path.join(base, "db.sqlite"),
    verifierOverride: async () => ({ ok: false, evidence: ["verifier:criteria_not_met"], tests: { ran: 1, passed: 0, failed: 1 } })
  });
  const server = await startServer({ provider: {
    submit: (spec) => env.pipeline.submit(spec),
    run: (id, options) => env.pipeline.run(id, options),
    get: async (id) => { const loaded = await env.missions.get(id); return loaded ? loaded.record : null; },
    events: (id) => env.missions.events(id)
  } });
  try {
    const created = await call(server.base, "POST", "/ax/missions", { body: { objective: OBJECTIVE, acceptanceCriteria: CRITERIA, tasks: TASKS } });
    const missionId = created.json.mission.missionId;
    const run = await call(server.base, "POST", "/ax/missions/" + missionId + "/run", { body: { maxRounds: 2 } });
    assert.equal(run.status, 200);
    assert.notEqual(run.json.run.status, "completed");
    const fetched = await call(server.base, "GET", "/ax/missions/" + missionId);
    assert.notEqual(fetched.json.mission.status, "completed");
  } finally {
    await server.close();
    await env.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("HTTP: an approval authorises one action, and the API refuses a changed one", async () => {
  const base = await workspace();
  // The owner attestation is a test double here; the production verifier still requires a real signature.
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(base, "artifacts"),
    dbPath: path.join(base, "db.sqlite"),
    ownerVerifier: { verify: () => ({ ok: true, code: "test_attestation" }) }
  });
  const provider = {
    submit: (spec) => env.pipeline.submit(spec),
    run: (id, options) => env.pipeline.run(id, options),
    approve: (spec) => env.missions.approve(spec),
    get: async (id) => { const loaded = await env.missions.get(id); return loaded ? loaded.record : null; },
    events: (id) => env.missions.events(id)
  };
  const server = await startServer({ provider });
  const DEPLOY = {
    id: "d1",
    title: "Deploy to production",
    requires: ["engineering"],
    criteria: [0],
    approvalRequired: true,
    action: "deploy release 4.2.0",
    target: "staging",
    params: { region: "iad", replicas: 2 }
  };
  try {
    // 1. A signed owner decision lets the bound action run, and the mission verifies to completion.
    const created = await call(server.base, "POST", "/ax/missions", { body: {
      objective: "Deploy release 4.2.0 to staging", acceptanceCriteria: ["Release prepared"], tasks: [DEPLOY], idempotencyKey: "approve-http-1"
    } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const missionId = created.json.mission.missionId;
    const parked = await call(server.base, "POST", "/ax/missions/" + missionId + "/run", { body: {} });
    assert.equal(parked.json.run.status, "approval_required");
    const pending = await call(server.base, "GET", "/ax/missions/" + missionId);
    assert.equal(pending.json.mission.tasks[0].status, "pending", "the action did not run before approval");

    const decided = await call(server.base, "POST", "/ax/missions/" + missionId + "/approve", { body: { decision: "approve", taskId: "d1", reason: "release window agreed" } });
    assert.equal(decided.status, 200, JSON.stringify(decided.json));
    assert.equal(decided.json.mission.status, "running", "a signature releases the gate; it does not complete work");
    const ran = await call(server.base, "POST", "/ax/missions/" + missionId + "/run", { body: { maxRounds: 2 } });
    assert.equal(ran.json.run.status, "completed", JSON.stringify(ran.json.run));
    const done = await call(server.base, "GET", "/ax/missions/" + missionId);
    assert.equal(done.json.mission.tasks[0].status, "completed");
    assert.ok(done.json.events.some((event) => event.type === "task.approval_cleared" && event.taskId === "d1"),
      "the execution gate cleared the bound approval before the executor ran");

    // 2. The same approval cannot authorise changed parameters.
    const second = await call(server.base, "POST", "/ax/missions", { body: {
      objective: "Deploy release 4.2.1 to staging", acceptanceCriteria: ["Release prepared"], tasks: [DEPLOY], idempotencyKey: "approve-http-2"
    } });
    const secondId = second.json.mission.missionId;
    await call(server.base, "POST", "/ax/missions/" + secondId + "/run", { body: {} });
    await call(server.base, "POST", "/ax/missions/" + secondId + "/approve", { body: { decision: "approve", taskId: "d1" } });
    const loaded = await env.missionStore.get(secondId);
    const record = loaded.record;
    record.tasks.find((task) => task.id === "d1").params = { region: "iad", replicas: 9 };
    assert.equal((await env.missionStore.save(record, loaded.version)).ok, true);
    await call(server.base, "POST", "/ax/missions/" + secondId + "/run", { body: { maxRounds: 1 } });
    const refused = await call(server.base, "GET", "/ax/missions/" + secondId);
    assert.notEqual(refused.json.mission.status, "completed", "changed parameters do not execute");
    assert.equal(refused.json.mission.tasks[0].status, "blocked");
    assert.equal(refused.json.mission.tasks[0].error, "approval_action_changed");
    assert.ok(refused.json.events.some((event) => event.type === "task.approval_refused" && event.code === "approval_action_changed"));
  } finally {
    await server.close();
    await env.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("HTTP: expired, rejected, revoked, wrong-task and wrong-mission approvals are refused", async () => {
  const base = await workspace();
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(base, "artifacts"),
    dbPath: path.join(base, "db.sqlite"),
    ownerVerifier: { verify: () => ({ ok: true, code: "test_attestation" }) }
  });
  const provider = {
    submit: (spec) => env.pipeline.submit(spec),
    run: (id, options) => env.pipeline.run(id, options),
    approve: (spec) => env.missions.approve(spec),
    revoke: (spec) => env.missions.revoke(spec),
    get: async (id) => { const loaded = await env.missions.get(id); return loaded ? loaded.record : null; },
    events: (id) => env.missions.events(id)
  };
  const server = await startServer({ provider });
  const TASK = {
    id: "d1", title: "Deploy to production", requires: ["engineering"], criteria: [0],
    approvalRequired: true, action: "deploy release", target: "staging", params: { replicas: 2 }
  };
  let counter = 0;
  const deployMission = async () => {
    counter += 1;
    const created = await call(server.base, "POST", "/ax/missions", { body: {
      objective: "Deploy release 5." + counter + " to production",
      acceptanceCriteria: ["Release prepared"],
      tasks: [TASK],
      idempotencyKey: "refuse-http-" + counter
    } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.mission.missionId;
    const parked = await call(server.base, "POST", "/ax/missions/" + id + "/run", { body: {} });
    assert.equal(parked.json.run.status, "approval_required", JSON.stringify(parked.json));
    return id;
  };
  const decide = (id, body) => call(server.base, "POST", "/ax/missions/" + id + "/approve", { body });
  const tamper = async (id, change) => {
    const loaded = await env.missionStore.get(id);
    change(loaded.record);
    assert.equal((await env.missionStore.save(loaded.record, loaded.version)).ok, true);
  };
  const runAndRead = async (id) => {
    await call(server.base, "POST", "/ax/missions/" + id + "/run", { body: { maxRounds: 1 } });
    return (await call(server.base, "GET", "/ax/missions/" + id)).json;
  };
  const clearMissionScope = (record) => {
    for (const item of record.approvals) if (!item.taskId) item.status = "approved";
  };
  try {
    // Expired after grant.
    const expired = await deployMission();
    assert.equal((await decide(expired, { decision: "approve", taskId: "d1" })).status, 200);
    await tamper(expired, (record) => {
      const approval = record.approvals.find((item) => item.taskId === "d1");
      approval.expiresAt = "2020-01-01T00:00:00.000Z";
    });
    const expiredMission = await runAndRead(expired);
    assert.equal(expiredMission.mission.tasks[0].error, "approval_expired");
    assert.notEqual(expiredMission.mission.status, "completed");

    // Rejected before execution.
    const rejected = await deployMission();
    assert.equal((await decide(rejected, { decision: "reject", taskId: "d1" })).status, 200);
    const rejectedMission = await runAndRead(rejected);
    assert.equal(rejectedMission.mission.status, "rejected");
    assert.notEqual(rejectedMission.mission.tasks[0].status, "completed");

    // Revoked after grant.
    const revoked = await deployMission();
    assert.equal((await decide(revoked, { decision: "approve", taskId: "d1" })).status, 200);
    assert.equal((await env.missions.revoke({ missionId: revoked, taskId: "d1", reason: "withdrawn" })).ok, true);
    const revokedMission = await runAndRead(revoked);
    assert.equal(revokedMission.mission.tasks[0].error, "approval_revoked");

    // Bound to a different task.
    const wrongTask = await deployMission();
    assert.equal((await decide(wrongTask, { decision: "approve", taskId: "d1" })).status, 200);
    await tamper(wrongTask, (record) => {
      record.approvals.find((item) => item.taskId === "d1").taskId = "d0";
      clearMissionScope(record);
    });
    const wrongTaskMission = await runAndRead(wrongTask);
    assert.equal(wrongTaskMission.mission.tasks[0].error, "approval_missing");

    // Replayed from a different mission.
    const wrongMission = await deployMission();
    assert.equal((await decide(wrongMission, { decision: "approve", taskId: "d1" })).status, 200);
    await tamper(wrongMission, (record) => {
      record.approvals.find((item) => item.taskId === "d1").missionId = "msn_other_mission";
      clearMissionScope(record);
    });
    const wrongMissionResult = await runAndRead(wrongMission);
    assert.equal(wrongMissionResult.mission.tasks[0].error, "approval_missing");
    assert.ok(wrongMissionResult.events.some((event) => event.type === "task.approval_refused"));
  } finally {
    await server.close();
    await env.close();
    await rm(base, { recursive: true, force: true });
  }
});
