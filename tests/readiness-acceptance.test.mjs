import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createUniversalCommandEngine } from "../universal-command-engine.mjs";
import { createNexusWorker } from "../nexus-runtime.mjs";
import { createToolRegistry } from "../tool-registry.mjs";
import { registerDeviceCommandBridge } from "../device-command-bridge.mjs";
import { runBackfill } from "../scripts/backfill-device-ownership.mjs";

/**
 * Consolidated Revision 4.2 acceptance suite.
 *
 * These tests use in-memory device and task stores plus a tiny SQL-compatible command queue.
 * They prove the code paths and state contracts, not Cloudflare D1, Render, or a real Android phone.
 */

const AX_TOKEN = "ax-acceptance-secret";
const OWNER_ID = "owner-phone";
const OWNER_TOKEN = "owner-acceptance-token";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function responseRecorder() {
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
  const res = responseRecorder();
  let index = 0;
  const next = () => { index += 1; };
  while (index < handlers.length) {
    let advanced = false;
    await handlers[index](req, res, () => { advanced = true; next(); });
    if (!advanced) break;
  }
  return res;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function memoryDeviceStore() {
  const devices = new Map();
  const owners = new Map();
  const pairings = new Map();
  const pairingOwners = new Map();
  const commands = new Map();
  return {
    devices,
    owners,
    pairings,
    commands,
    durable: true,
    async initialize() {},
    async createPairing({ codeHash, deviceId, createdAt, expiresAt, ownerDeviceId }) {
      pairings.set(codeHash, { codeHash, deviceId, createdAt, expiresAt, consumedAt: null, recoveryAt: null });
      pairingOwners.set(codeHash, ownerDeviceId);
    },
    async seedBootstrapPairing({ codeHash, createdAt, expiresAt, ownerDeviceId }) {
      if (!pairings.has(codeHash)) {
        pairings.set(codeHash, { codeHash, deviceId: "*", createdAt, expiresAt, consumedAt: null, recoveryAt: null });
        pairingOwners.set(codeHash, ownerDeviceId);
      }
    },
    async findPairing({ codeHash }) {
      const row = pairings.get(codeHash);
      return row ? { ...row, ownerDeviceId: pairingOwners.get(codeHash) || null } : null;
    },
    async consumePairing({ codeHash, deviceId, consumedAt }) {
      const row = pairings.get(codeHash);
      if (!row || row.consumedAt || (row.deviceId !== "*" && row.deviceId !== deviceId) || row.expiresAt <= consumedAt) return false;
      row.deviceId = deviceId;
      row.consumedAt = consumedAt;
      return true;
    },
    async claimPairingRecovery({ codeHash, deviceId, recoveredAt, consumedAfter }) {
      const row = pairings.get(codeHash);
      if (!row || row.deviceId !== deviceId || !row.consumedAt || row.recoveryAt || row.consumedAt < consumedAfter) return false;
      row.recoveryAt = recoveredAt;
      return true;
    },
    async registerDevice({ deviceId, tokenHash, createdAt, ownerDeviceId }) {
      if (ownerDeviceId) {
        if (!owners.has(deviceId)) owners.set(deviceId, ownerDeviceId);
        if (owners.get(deviceId) !== ownerDeviceId) return false;
      }
      devices.set(deviceId, { deviceId, tokenHash, createdAt, lastSeenAt: null, revoked: false });
      return true;
    },
    async getDeviceOwner(deviceId) { return owners.get(deviceId) || null; },
    async isDeviceRevoked(deviceId) { return Boolean(devices.get(deviceId)?.revoked); },
    async isDevicePaired(deviceId) {
      const row = devices.get(deviceId);
      return Boolean(row && !row.revoked && row.tokenHash);
    },
    async verifyDeviceToken(token, deviceId) {
      const row = devices.get(deviceId);
      return Boolean(row && !row.revoked && row.tokenHash === hash(token));
    },
    async touchDevice(deviceId, seenAt) {
      const row = devices.get(deviceId);
      if (row && !row.revoked) row.lastSeenAt = seenAt;
    },
    async updateDeviceInfo(deviceId, seenAt, details) {
      const row = devices.get(deviceId);
      if (row && !row.revoked) {
        row.lastSeenAt = seenAt;
        row.deviceInfo = details;
      }
    },
    async listDevices() {
      return [...devices.entries()].map(([deviceId, row]) => ({
        device_id: deviceId,
        created_at: row.createdAt,
        last_seen_at: row.lastSeenAt,
        device_json: row.deviceInfo ? JSON.stringify(row.deviceInfo) : null,
        revoked_at: row.revoked ? "revoked" : null,
        owner_device_id: owners.get(deviceId) || null
      }));
    },
    async revokeDevice(deviceId) {
      const row = devices.get(deviceId);
      if (row) row.revoked = true;
      for (const [id, command] of commands) {
        if (command.deviceId === deviceId && (command.status === "queued" || command.status === "claimed")) {
          commands.set(id, { ...command, status: "cancelled" });
        }
      }
    },
    async enqueue(command) { commands.set(command.id, structuredClone(command)); },
    async claimNext(deviceId) {
      const command = [...commands.values()].find(row =>
        row.deviceId === deviceId && row.status === "queued" &&
        Date.parse(row.expiresAt) > Date.now()
      );
      if (!command) return null;
      command.status = "claimed";
      return structuredClone(command);
    },
    async complete({ id, deviceId, result, completedAt }) {
      const command = commands.get(id);
      if (!command || command.deviceId !== deviceId || command.status !== "claimed") return false;
      Object.assign(command, { status: "completed", result, completedAt });
      return true;
    },
    async get(id) { return commands.get(id) ? structuredClone(commands.get(id)) : null; },
    async audit() { return { ok: true }; }
  };
}

async function bridgeHarness() {
  const store = memoryDeviceStore();
  store.devices.set(OWNER_ID, {
    deviceId: OWNER_ID,
    tokenHash: hash(OWNER_TOKEN),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    revoked: false
  });
  store.owners.set(OWNER_ID, OWNER_ID);
  const app = makeApp();
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
      HABITAT_OWNER_DEVICE_ID: OWNER_ID,
      HABITAT_RUNTIME_ENV: "nonproduction"
    },
    repository: store
  });
  await bridge.initialize();
  return { app, bridge, store };
}

// ---- device identity and pairing ------------------------------------------

test("1. an authorized owner can authenticate", async () => {
  const { bridge } = await bridgeHarness();
  const result = await bridge.authorizeOwnerRequest({
    headers: { authorization: "Bearer " + OWNER_TOKEN, "x-owner-device-id": OWNER_ID }
  });
  assert.equal(result.ok, true);
  assert.equal(result.deviceId, OWNER_ID);
});

test("2. an unauthorized device is rejected", async () => {
  const { bridge, store } = await bridgeHarness();
  const stranger = await bridge.authorizeOwnerRequest({
    headers: { authorization: "Bearer wrong-token", "x-owner-device-id": OWNER_ID }
  });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.status, 401);

  store.devices.set("stranger", {
    deviceId: "stranger",
    tokenHash: hash("stranger-token"),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revoked: false
  });
  const nonOwner = await bridge.authorizeOwnerRequest({
    headers: { authorization: "Bearer stranger-token", "x-owner-device-id": "stranger" }
  });
  assert.equal(nonOwner.ok, false);
  assert.equal(nonOwner.status, 401);
});

test("3. pairing succeeds, a consumed code cannot be replayed by another device, and recovery is bounded", async () => {
  const { app, store } = await bridgeHarness();
  const minted = await invoke(app, "POST /ax/device/pairings", {
    headers: { authorization: "Bearer " + AX_TOKEN },
    body: { deviceId: "android-acceptance" }
  });
  assert.equal(minted.statusCode, 201);
  const code = minted.body.pairing.code;

  const paired = await invoke(app, "POST /device/pair", {
    headers: {},
    body: { deviceId: "android-acceptance", code }
  });
  assert.equal(paired.statusCode, 200);
  assert.ok(paired.body.token);
  assert.equal(store.owners.get("android-acceptance"), OWNER_ID);

  const replay = await invoke(app, "POST /device/pair", {
    headers: {},
    body: { deviceId: "android-other", code }
  });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.body.code, "pairing_used_other_device");

  const recovered = await invoke(app, "POST /device/pair", {
    headers: {},
    body: { deviceId: "android-acceptance", code }
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.body.recovered, true);

  const exhausted = await invoke(app, "POST /device/pair", {
    headers: {},
    body: { deviceId: "android-acceptance", code }
  });
  assert.equal(exhausted.statusCode, 409);
  assert.equal(exhausted.body.code, "pairing_recovery_exhausted");
});

test("9. a revoked device loses access and its queued commands are cancelled", async () => {
  const { app, store } = await bridgeHarness();
  const minted = await invoke(app, "POST /ax/device/pairings", {
    headers: { authorization: "Bearer " + AX_TOKEN },
    body: { deviceId: "android-revoke" }
  });
  const paired = await invoke(app, "POST /device/pair", {
    headers: {},
    body: { deviceId: "android-revoke", code: minted.body.pairing.code }
  });
  const token = paired.body.token;

  await store.enqueue({
    id: "dc_revoke_test",
    deviceId: "android-revoke",
    type: "device.status",
    payload: {},
    status: "queued",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  await store.revokeDevice("android-revoke");

  assert.equal(await store.verifyDeviceToken(token, "android-revoke"), false);
  assert.equal(store.commands.get("dc_revoke_test").status, "cancelled");
  const denied = await invoke(app, "GET /device/commands/next", {
    headers: { authorization: "Bearer " + token },
    query: { deviceId: "android-revoke" }
  });
  assert.equal(denied.statusCode, 401);
});

// ---- command engine and worker -------------------------------------------

function taskHarness() {
  const rows = new Map();
  let busy = false;
  const calls = [];
  const repository = {
    durable: true,
    async create(task) { rows.set(task.id, structuredClone(task)); return structuredClone(task); },
    async get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    async update(id, patch) {
      if (!rows.has(id)) return null;
      const next = { ...rows.get(id), ...structuredClone(patch), id };
      rows.set(id, next);
      return structuredClone(next);
    },
    async list({ status, limit = 50 } = {}) {
      return [...rows.values()].filter(task => !status || task.status === status).slice(0, limit).map(task => structuredClone(task));
    },
    async transition(id, { expect, next } = {}) {
      const current = rows.get(id);
      if (!current || current.status !== "working") return null;
      if ((current.fence ?? null) !== (expect?.fence ?? null)) return null;
      if ((current.claimedBy ?? null) !== (expect?.claimedBy ?? null)) return null;
      rows.set(id, structuredClone(next));
      return structuredClone(next);
    }
  };
  const query = async (sql, params = []) => {
    const text = String(sql).trim();
    calls.push({ sql: text.slice(0, 50), params });
    if (text.startsWith("CREATE TABLE")) return [{ results: [] }];
    if (text.startsWith("INSERT INTO habitat_nexus_workers")) return [{ results: [] }];
    if (text.startsWith("UPDATE habitat_command_tasks SET status = 'working'")) {
      if (busy) return [{ results: [] }];
      busy = true;
      try {
        const candidate = [...rows.values()]
          .filter(task => task.status === "queued" && typeof task.adapter === "string" && task.adapter)
          .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
        if (!candidate) return [{ results: [] }];
        Object.assign(candidate, {
          status: "working",
          claimedBy: params[0],
          leaseUntil: params[1],
          fence: params[2],
          updatedAt: params[3]
        });
        return [{ results: [{ record_json: JSON.stringify(candidate) }] }];
      } finally { busy = false; }
    }
    if (text.startsWith("UPDATE habitat_command_tasks SET record_json = json_set(record_json, '$.leaseUntil'")) {
      const task = rows.get(params[3]);
      if (task && task.fence === params[4]) {
        task.leaseUntil = params[0];
        return [{ results: [{ id: task.id }] }];
      }
      return [{ results: [] }];
    }
    if (text.startsWith("SELECT id, record_json") && text.includes("leaseUntil")) return [{ results: [] }];
    throw new Error("unexpected acceptance SQL: " + text.slice(0, 80));
  };
  const engine = createUniversalCommandEngine({
    repository,
    registry: createToolRegistry({ env: {} }),
    now: () => "2026-11-21T12:00:00.000Z"
  });
  const worker = createNexusWorker({
    repository,
    engine,
    query,
    pollMs: 1000,
    leaseMs: 10_000,
    adapterTimeoutMs: 1000,
    adapters: {
      "repo.inspect": async task => ({
        summary: "Inspected " + task.id + " without external access.",
        evidence: ["acceptance:task/" + task.id],
        decisions: [],
        blockers: []
      })
    },
    log: { log() {}, warn() {}, error() {} }
  });
  return { rows, calls, repository, engine, worker };
}

test("4. Ax accepts a command and creates a persistent task", async () => {
  const { rows, engine } = taskHarness();
  const outcome = await engine.submit({
    objective: "Inspect the Habitat repository status",
    role: "ax",
    adapter: "repo.inspect",
    idempotencyKey: "acceptance-create"
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.task.status, "queued");
  assert.equal(rows.size, 1);
  assert.equal(rows.get(outcome.task.id).objective, "Inspect the Habitat repository status");
});

test("5. a worker claims and executes an authorized task", async () => {
  const { engine, worker } = taskHarness();
  const task = (await engine.submit({
    objective: "Inspect the Habitat repository status",
    role: "ax",
    adapter: "repo.inspect"
  })).task;

  await worker.tick();
  const stored = await engine.get(task.id);
  assert.equal(stored.task.status, "done");
});

test("6. results return to Ax with verified evidence", async () => {
  const { engine, worker } = taskHarness();
  const task = (await engine.submit({
    objective: "Inspect the Habitat repository status",
    role: "ax",
    adapter: "repo.inspect"
  })).task;

  await worker.tick();
  const stored = await engine.get(task.id);
  assert.equal(stored.task.result.verifiedBy, worker.workerId);
  assert.match(stored.task.result.summary, /Inspected/);
  assert.deepEqual(stored.task.result.evidence, ["acceptance:task/" + task.id]);
});

test("7. a failed task is not falsely completed and can be retried within the cap", async () => {
  const { engine } = taskHarness();
  const task = (await engine.submit({ objective: "Fail safely", adapter: "repo.inspect" })).task;
  const failed = await engine.fail({ taskId: task.id, error: "synthetic worker failure" });
  assert.equal(failed.task.status, "failed");
  assert.equal(failed.task.error, "synthetic worker failure");
  const retry = await engine.retry({ taskId: task.id, by: "owner" });
  assert.equal(retry.task.status, "queued");
  assert.equal(retry.attempts, 1);
  assert.equal(retry.task.error, null);
});

test("8. duplicate command delivery cannot cause duplicate execution", async () => {
  const { engine, worker, rows } = taskHarness();
  const task = (await engine.submit({ objective: "One execution only", adapter: "repo.inspect" })).task;
  const [first, second] = await Promise.all([worker.claim(), worker.claim()]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(rows.get(task.id).status, "working");
});

test("11. a sensitive action parks for approval and is not executed by the worker", async () => {
  const { engine, worker, rows } = taskHarness();
  const task = (await engine.submit({ objective: "Deploy the service", role: "nexus" })).task;
  const planned = await engine.plan({
    taskId: task.id,
    steps: [{ step: "deploy to Render", role: "nexus", tool: "deploy.render" }]
  });
  assert.equal(planned.approvalRequired, true);
  assert.equal(planned.task.status, "needs_approval");
  await worker.tick();
  assert.equal(rows.get(task.id).status, "needs_approval");
  assert.equal(rows.get(task.id).result, null);
});

test("10. restarting the engine preserves valid task state", async () => {
  const { engine, repository } = taskHarness();
  const task = (await engine.submit({ objective: "Persist across restart", adapter: "repo.inspect" })).task;
  await engine.complete({ taskId: task.id, result: { summary: "persisted", evidence: ["acceptance:persisted"] } });
  const restarted = createUniversalCommandEngine({
    repository,
    registry: createToolRegistry({ env: {} })
  });
  const read = await restarted.get(task.id);
  assert.equal(read.task.status, "done");
  assert.equal(read.task.result.summary, "persisted");
});

test("12. migration dry-run produces no database changes", async () => {
  const calls = { initialize: 0, preflight: 0, backfill: 0, audit: 0 };
  const repository = {
    async initialize() { calls.initialize += 1; },
    async preflightOwnership() {
      calls.preflight += 1;
      return { ok: true, action: "assign", assigned: true, targetRevoked: false };
    },
    async backfillOwnership() { calls.backfill += 1; return { ok: true, assigned: true }; },
    async audit() { calls.audit += 1; }
  };
  const result = await runBackfill({
    mapping: { devices: [{ deviceId: "legacy-phone", ownerDeviceId: "owner-phone" }] },
    apply: false,
    repository,
    authorizedOwnerIds: ["owner-phone"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.mode, "dry-run");
  assert.deepEqual(calls, { initialize: 0, preflight: 1, backfill: 0, audit: 0 });
});
