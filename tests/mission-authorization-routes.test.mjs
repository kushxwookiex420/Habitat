import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createMissionEngine } from "../ax-mission-engine.mjs";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";
import { approvalSigningFields } from "../ax-mission-policy.mjs";
import { buildMissionEnvironment } from "../mission-harness.mjs";

/**
 * Owner authorization interface, exercised over real HTTP with a real HMAC verifier. Executor spies count
 * every release of protected work, so refused authorizations are shown never to execute.
 */

const TOKEN = "owner_auth_" + "t".repeat(28);
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

async function startServer(provider) {
  const app = makeApp();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_COMMAND_TOKEN: TOKEN }, missionProvider: () => provider });
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
      json(payload) { res.writeHead(this.statusCode, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); return this; }
    };
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
      method: raw.method, path: url.pathname, originalUrl: raw.url, headers: raw.headers,
      query: Object.fromEntries(url.searchParams.entries()), params, body: parsed, ip: "127.0.0.1"
    };
    let index = 0;
    const next = async () => {
      if (index >= entry.handlers.length) return;
      const handler = entry.handlers[index];
      index += 1;
      return handler(request, response, next);
    };
    try { await next(); } catch (error) {
      if (!res.writableEnded) response.status(500).json({ ok: false, code: "handler_threw", error: String(error?.message || error) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

async function call(base, method, path, { token = TOKEN, body = null } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json() };
}

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "habitat-auth-routes-" + process.pid + "-"));
}

const CRITERIA = ["Repository analysed", "Release prepared"];
const TASKS = [
  { id: "t1", title: "Analyse the repository", requires: ["engineering"], criteria: [0] },
  {
    id: "t2", title: "Deploy to production", requires: ["engineering"], criteria: [1], dependsOn: ["t1"],
    approvalRequired: true, action: "deploy release 7.0.0", target: "staging", params: { region: "iad", replicas: 2 }
  }
];

async function setup({ dir = null, ownerVerifier = null } = {}) {
  const base = dir || await workspace();
  const calls = { byTask: {} };
  const secret = "route-approval-secret-" + "r".repeat(20);
  const owner = ownerVerifier || createOwnerAttestation({ secret });
  const env = await buildMissionEnvironment({
    rootDir: ROOT,
    artifactsDir: path.join(base, "artifacts"),
    dbPath: path.join(base, "db.sqlite"),
    ownerVerifier: owner,
    executorOverrides: {
      "eng.repo": async ({ task }) => {
        calls.byTask[task.id] = (calls.byTask[task.id] || 0) + 1;
        return { result: { status: "completed", evidence: ["spy:" + task.id], changedFiles: [], tests: { ran: 1, passed: 1, failed: 0 } } };
      },
      "verifier.recompute": async () => ({ ok: true, evidence: ["verifier:ok"], tests: { ran: 1, passed: 1, failed: 0 } })
    }
  });
  const provider = {
    submit: (spec) => env.pipeline.submit(spec),
    run: (id, options) => env.pipeline.run(id, options),
    approve: (spec) => env.missions.approve(spec),
    revoke: (spec) => env.missions.revoke(spec),
    authorizations: (spec) => env.missions.authorizations(spec),
    get: async (id) => { const loaded = await env.missions.get(id); return loaded ? loaded.record : null; },
    events: (id) => env.missions.events(id)
  };
  const server = await startServer(provider);
  const signStatement = async (missionId, statement) => {
    // The statement comes from the signing view, not from internal knowledge of the record.
    const view = await call(server.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    const entry = view.json.pending.find((item) => item.statement === statement);
    assert.ok(entry, "the signing view contains the requested statement");
    return owner.sign({
      operation: "mission.approve", project: "habitat", key: missionId,
      kind: "approve", statement, tags: [], confidence: null
    });
  };
  const close = async () => { await server.close(); env.close(); if (!dir) await rm(base, { recursive: true, force: true }); };
  return { base: server.base, dir: base, env, server, owner, calls, signStatement, close };
}

async function deployMission(h, key) {
  const created = await call(h.base, "POST", "/ax/missions", { body: {
    objective: "Deploy release 7.0.0 to production", acceptanceCriteria: CRITERIA, tasks: TASKS, idempotencyKey: "auth-route-" + key
  } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const missionId = created.json.mission.missionId;
  await call(h.base, "POST", "/ax/missions/" + missionId + "/run", { body: {} });
  return missionId;
}

async function decide(h, missionId, entry, decision = "approve") {
  const statement = decision === "reject" ? entry.rejectStatement : entry.statement;
  const attested = await h.owner.sign({
    operation: "mission.approve", project: "habitat", key: missionId,
    kind: decision, statement, tags: [], confidence: null
  });
  const body = { decision, attestation: attested.attestation, reason: "reviewed" };
  if (entry.taskId) body.taskId = entry.taskId;
  else body.approvalId = entry.approvalId;
  return call(h.base, "POST", "/ax/missions/" + missionId + "/approve", { body });
}

test("auth routes: the signing view and every operation refuse anonymous access", async () => {
  const h = await setup();
  try {
    const missionId = await deployMission(h, "anonymous");
    for (const [method, suffix] of [["GET", "/authorizations"], ["POST", "/revoke"]]) {
      const response = await call(h.base, method, "/ax/missions/" + missionId + suffix, { token: null, body: method === "POST" ? { taskId: "t2" } : null });
      assert.equal(response.status, 401, method + " requires the Ax credential");
    }
  } finally { await h.close(); }
});

test("auth routes: the signing view returns the exact statement, and a signature from it executes", async () => {
  const h = await setup();
  try {
    const missionId = await deployMission(h, "statement");
    const view = await call(h.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    assert.equal(view.status, 200);
    assert.equal(view.json.missionId, missionId);
    assert.equal(view.json.pending.length, 2, "mission-scope and task authorization are both pending");
    const taskEntry = view.json.pending.find((item) => item.taskId === "t2");
    assert.equal(taskEntry.actionClass, "consequential");
    assert.equal(taskEntry.target, "staging");
    assert.match(taskEntry.parameters, /^pf:[0-9a-f]{32}$/);
    assert.equal(taskEntry.status, "pending");
    assert.ok(Date.parse(taskEntry.expiresAt) > Date.now());
    assert.equal(taskEntry.description, "Deploy to production");
    const parsed = JSON.parse(taskEntry.statement);
    assert.equal(parsed.missionId, missionId);
    assert.equal(parsed.actionClass, "consequential");
    assert.equal(parsed.parameters, taskEntry.parameters);
    assert.equal(parsed.owner, "owner");
    assert.equal(parsed.approvalId, taskEntry.approvalId);

    const signal = view.json.pending.find((item) => !item.taskId);
    assert.equal((await decide(h, missionId, signal)).status, 200);
    const accepted = await decide(h, missionId, taskEntry);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const run = await call(h.base, "POST", "/ax/missions/" + missionId + "/run", { body: { maxRounds: 2 } });
    assert.equal(run.json.run.status, "completed", JSON.stringify(run.json.run));
    assert.equal(h.calls.byTask.t2, 1);

    const history = await call(h.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    assert.equal(history.json.pending.length, 0);
    assert.equal(history.json.history.length, 2);
    assert.ok(history.json.history.every((item) => item.status === "approved" && item.decidedBy === "owner"));
    assert.ok(history.json.history.every((item) => item.signature?.keyId && item.signature?.nonce));
  } finally { await h.close(); }
});

test("auth routes: a stale signing view cannot authorise changed work", async () => {
  const h = await setup();
  try {
    const missionId = await deployMission(h, "stale");
    const view = await call(h.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    const signal = view.json.pending.find((item) => !item.taskId);
    const taskEntry = view.json.pending.find((item) => item.taskId === "t2");
    assert.equal((await decide(h, missionId, signal)).status, 200);

    const loaded = await h.env.missions.get(missionId);
    loaded.record.tasks.find((item) => item.id === "t2").params = { region: "iad", replicas: 9 };
    assert.equal((await h.env.missionStore.save(loaded.record, loaded.version)).ok, true);

    const refused = await decide(h, missionId, taskEntry);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, "owner_attestation_invalid");
    await call(h.base, "POST", "/ax/missions/" + missionId + "/run", { body: {} });
    assert.equal(h.calls.byTask.t2 || 0, 0);
  } finally { await h.close(); }
});

test("auth routes: reject and revoke act on exactly one authorization", async () => {
  const h = await setup();
  try {
    const rejectId = await deployMission(h, "reject");
    let view = await call(h.base, "GET", "/ax/missions/" + rejectId + "/authorizations");
    const signal = view.json.pending.find((item) => !item.taskId);
    assert.equal((await decide(h, rejectId, signal)).status, 200);
    const taskEntry = view.json.pending.find((item) => item.taskId === "t2");
    const rejected = await decide(h, rejectId, taskEntry, "reject");
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json));
    assert.equal(rejected.json.mission.status, "rejected");
    await call(h.base, "POST", "/ax/missions/" + rejectId + "/run", { body: {} });
    assert.equal(h.calls.byTask.t2 || 0, 0);

    const revokeId = await deployMission(h, "revoke");
    view = await call(h.base, "GET", "/ax/missions/" + revokeId + "/authorizations");
    await decide(h, revokeId, view.json.pending.find((item) => !item.taskId));
    const granted = await decide(h, revokeId, view.json.pending.find((item) => item.taskId === "t2"));
    assert.equal(granted.status, 200);
    const revoked = await call(h.base, "POST", "/ax/missions/" + revokeId + "/revoke", { body: { taskId: "t2", reason: "withdrawn" } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    const noTarget = await call(h.base, "POST", "/ax/missions/" + revokeId + "/revoke", { body: {} });
    assert.equal(noTarget.status, 400);
    assert.equal(noTarget.json.code, "approval_target_required");
    await call(h.base, "POST", "/ax/missions/" + revokeId + "/run", { body: {} });
    assert.equal(h.calls.byTask.t2 || 0, 0);
    const after = await call(h.base, "GET", "/ax/missions/" + revokeId + "/authorizations");
    assert.equal(after.json.history.find((item) => item.taskId === "t2").status, "revoked");
  } finally { await h.close(); }
});

test("auth routes: duplicate and concurrent decisions cannot double-release work", async () => {
  const h = await setup();
  try {
    const missionId = await deployMission(h, "duplicate");
    const view = await call(h.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    await decide(h, missionId, view.json.pending.find((item) => !item.taskId));
    const entry = view.json.pending.find((item) => item.taskId === "t2");

    const first = await decide(h, missionId, entry);
    assert.equal(first.status, 200);
    const replay = await decide(h, missionId, entry);
    assert.equal(replay.status, 409, "a duplicate decision is refused");
    assert.ok(["owner_attestation_replayed", "approval_not_required"].includes(replay.json.code), replay.json.code);

    const concurrentId = await deployMission(h, "concurrent");
    const concurrentView = await call(h.base, "GET", "/ax/missions/" + concurrentId + "/authorizations");
    await decide(h, concurrentId, concurrentView.json.pending.find((item) => !item.taskId));
    const concurrentEntry = concurrentView.json.pending.find((item) => item.taskId === "t2");
    const attestationA = h.owner.sign({ operation: "mission.approve", project: "habitat", key: concurrentId, kind: "approve", statement: concurrentEntry.statement, tags: [], confidence: null });
    const attestationB = h.owner.sign({ operation: "mission.approve", project: "habitat", key: concurrentId, kind: "approve", statement: concurrentEntry.statement, tags: [], confidence: null });
    const results = await Promise.all([
      call(h.base, "POST", "/ax/missions/" + concurrentId + "/approve", { body: { decision: "approve", taskId: "t2", attestation: attestationA.attestation } }),
      call(h.base, "POST", "/ax/missions/" + concurrentId + "/approve", { body: { decision: "approve", taskId: "t2", attestation: attestationB.attestation } })
    ]);
    assert.equal(results.filter((item) => item.status === 200).length, 1, "exactly one concurrent decision wins");
    await call(h.base, "POST", "/ax/missions/" + concurrentId + "/run", { body: { maxRounds: 1 } });
    assert.equal(h.calls.byTask.t2, 1);
  } finally { await h.close(); }
});

test("auth routes: the registry records the decision and refuses the same nonce again", async () => {
  const h = await setup();
  try {
    const missionId = await deployMission(h, "nonce");
    const view = await call(h.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    const signal = view.json.pending.find((item) => !item.taskId);
    const signalAttestation = h.owner.sign({ operation: "mission.approve", project: "habitat", key: missionId, kind: "approve", statement: signal.statement, tags: [], confidence: null });
    assert.equal((await call(h.base, "POST", "/ax/missions/" + missionId + "/approve", { body: { decision: "approve", approvalId: signal.approvalId, attestation: signalAttestation.attestation } })).status, 200);

    const record = await h.env.missionStore.nonceRecord(signalAttestation.attestation.nonce);
    assert.equal(record.status, "consumed");
    assert.equal(record.mission_id, missionId);
    assert.equal(record.approval_id, signal.approvalId);
    assert.equal(record.decision, "approve");
    assert.equal(record.key_id, signalAttestation.attestation.keyId);
    assert.ok(record.consumed_at);
    assert.equal(await h.env.missionStore.nonceUsed(signalAttestation.attestation.nonce), true);

    const again = await h.env.missionStore.consumeNonce({
      nonce: signalAttestation.attestation.nonce, missionId, approvalId: signal.approvalId, decision: "approve"
    });
    assert.equal(again.ok, false);
    assert.equal(again.code, "owner_attestation_replayed");

    await call(h.base, "POST", "/ax/missions/" + missionId + "/run", { body: {} });
    assert.equal(h.calls.byTask.t2 || 0, 0);
  } finally { await h.close(); }
});

test("auth routes: an unavailable shared replay store fails closed", async () => {
  const h = await setup();
  try {
    const missionId = await deployMission(h, "replay-down");
    const view = await call(h.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    await decide(h, missionId, view.json.pending.find((item) => !item.taskId));
    const entry = view.json.pending.find((item) => item.taskId === "t2");
    const failingStore = {
      ...h.env.missionStore,
      consumeNonce: async () => { throw new Error("nonce registry unavailable"); }
    };
    const engine = createMissionEngine({
      store: failingStore,
      workforce: h.env.workforce,
      executors: h.env.executors,
      ownerVerifier: h.owner,
      now: () => new Date().toISOString()
    });
    const attested = h.owner.sign({
      operation: "mission.approve", project: "habitat", key: missionId,
      kind: "approve", statement: entry.statement, tags: [], confidence: null
    });
    const refused = await engine.approve({ missionId, taskId: "t2", decision: "approve", attestation: attested.attestation });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "owner_attestation_replay_unavailable");
    await call(h.base, "POST", "/ax/missions/" + missionId + "/run", { body: {} });
    assert.equal(h.calls.byTask.t2 || 0, 0);
  } finally { await h.close(); }
});

test("auth routes: a retired key still verifies, a revoked key is refused at execution", async () => {
  const retiredSecret = "retired-key-secret-" + "a".repeat(24);
  const activeSecret = "active-key-secret-" + "b".repeat(25);
  const signer = createOwnerAttestation({ secret: retiredSecret, keyId: "owner-1" });
  const base = await workspace();
  const first = await setup({ dir: base, ownerVerifier: signer });
  let missionId;
  let revokedMissionId;
  try {
    missionId = await deployMission(first, "rotated");
    let view = await call(first.base, "GET", "/ax/missions/" + missionId + "/authorizations");
    await decide(first, missionId, view.json.pending.find((item) => !item.taskId));
    assert.equal((await decide(first, missionId, view.json.pending.find((item) => item.taskId === "t2"))).status, 200);

    revokedMissionId = await deployMission(first, "revoked-key");
    view = await call(first.base, "GET", "/ax/missions/" + revokedMissionId + "/authorizations");
    await decide(first, revokedMissionId, view.json.pending.find((item) => !item.taskId));
    assert.equal((await decide(first, revokedMissionId, view.json.pending.find((item) => item.taskId === "t2"))).status, 200);
  } finally { await first.close(); }

  const rotated = await setup({
    dir: base,
    ownerVerifier: createOwnerAttestation({
      keys: [
        { keyId: "owner-1", secret: retiredSecret, status: "retired" },
        { keyId: "owner-2", secret: activeSecret, status: "active" }
      ]
    })
  });
  try {
    const run = await call(rotated.base, "POST", "/ax/missions/" + missionId + "/run", { body: { maxRounds: 2 } });
    assert.equal(run.json.run.status, "completed", "a retired key still verifies work signed before rotation");
    assert.equal(rotated.calls.byTask.t2, 1);
  } finally { await rotated.close(); }

  const revoked = await setup({
    dir: base,
    ownerVerifier: createOwnerAttestation({
      keys: [
        { keyId: "owner-1", secret: retiredSecret, status: "retired" },
        { keyId: "owner-2", secret: activeSecret, status: "active" }
      ],
      revokedKeyIds: ["owner-1"]
    })
  });
  try {
    await call(revoked.base, "POST", "/ax/missions/" + revokedMissionId + "/run", { body: { maxRounds: 1 } });
    assert.equal(revoked.calls.byTask.t2 || 0, 0, "a revoked key cannot release protected work");
    const record = (await revoked.env.missions.get(revokedMissionId)).record;
    assert.equal(record.tasks.find((item) => item.id === "t2").error, "owner_attestation_key_revoked");
  } finally {
    await revoked.close();
    await rm(base, { recursive: true, force: true });
  }
});
