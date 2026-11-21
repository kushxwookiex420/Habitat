import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDeviceCommandBridge } from "../../device-command-bridge.mjs";
import { createD1CommandTaskRepository } from "../../d1-command-task-repository.mjs";
import { createD1DeviceCommandRepository } from "../../d1-device-command-repository.mjs";
import { createD1Query } from "../../nexus-runtime.mjs";
import { buildReadOnlyNexusAdapters } from "../../nexus-adapter-registration.mjs";
import { createApp, listen, closeServer } from "./http-harness.mjs";

/**
 * Nonproduction integration harness.
 *
 * Real: the HTTP listener and sockets, device-command-bridge routes, pairing/heartbeat/command
 * queue, universal command engine, Nexus runtime and worker, D1 repository SQL, SQLite storage.
 *
 * Not real: Cloudflare D1 (a local transport shim executes the same SQL through node:sqlite),
 * Render, and any physical phone. The Android client is exercised separately by the Robolectric
 * suite, which speaks to this listener with the shipped AndroidDeviceBridge code.
 */

export const AX_TOKEN = "ax_bridge_" + "a".repeat(40);
export const OWNER_DEVICE_ID = "owner-s26";
export const OWNER_TOKEN = "owner_token_" + "o".repeat(30);
export const TARGET_DEVICE_ID = "android-acceptance";
export const INTRUDER_DEVICE_ID = "intruder-1";
export const INTRUDER_TOKEN = "intruder_token_" + "i".repeat(30);

export function hashToken(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function temporaryDatabasePath() {
  return join(mkdtempSync(join(tmpdir(), "habitat-nonprod-")), "habitat.sqlite");
}

function quietLog() {
  const lines = [];
  const push = (level) => (...args) => lines.push(level + " " + args.map(String).join(" "));
  return { lines, log: push("LOG"), warn: push("WARN"), error: push("ERROR") };
}

export async function startNonproductionHarness({
  dbPath = ":memory:",
  env = {},
  acceptanceToken = null,
  seedOwner = true
} = {}) {
  const db = new DatabaseSync(dbPath);
  const d1Fetch = async (_url, init) => {
    const { sql, params = [] } = JSON.parse(init.body);
    const rows = db.prepare(sql).all(...params);
    return {
      ok: true,
      status: 200,
      async json() { return { success: true, result: [{ results: rows }] }; }
    };
  };

  const deviceRepo = createD1DeviceCommandRepository({
    accountId: "nonprod-account", databaseId: "nonprod-db", apiToken: "nonprod-token", fetchImpl: d1Fetch
  });
  const taskRepo = createD1CommandTaskRepository({
    accountId: "nonprod-account", databaseId: "nonprod-db", apiToken: "nonprod-token", fetchImpl: d1Fetch
  });
  const query = createD1Query({
    accountId: "nonprod-account", databaseId: "nonprod-db", apiToken: "nonprod-token", fetchImpl: d1Fetch
  });

  const adapters = buildReadOnlyNexusAdapters({
    rootDir: process.cwd(),
    allowedPrefixes: ["src", "tests", "docs", "app/src", "README.md", "package.json"],
    taskRepository: taskRepo,
    d1Query: query
  });

  const { app, server } = createApp();
  const log = quietLog();
  const bridge = registerDeviceCommandBridge(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: AX_TOKEN,
      HABITAT_OWNER_DEVICE_ID: OWNER_DEVICE_ID,
      NEXUS_RUNTIME_ENABLED: "true",
      HABITAT_RUNTIME_ENV: "nonproduction",
      ...env
    },
    repository: deviceRepo,
    taskRepository: taskRepo,
    query,
    adapters,
    handleSignals: false,
    exitOnSignal: false,
    log
  });

  await deviceRepo.initialize();

  if (seedOwner) {
    await deviceRepo.registerDevice({
      deviceId: OWNER_DEVICE_ID,
      tokenHash: hashToken(OWNER_TOKEN),
      createdAt: new Date().toISOString(),
      ownerDeviceId: OWNER_DEVICE_ID
    });
    await deviceRepo.registerDevice({
      deviceId: INTRUDER_DEVICE_ID,
      tokenHash: hashToken(INTRUDER_TOKEN),
      createdAt: new Date().toISOString(),
      ownerDeviceId: null
    });
  }

  const initialized = await bridge.initialize({ startWorker: false });
  const url = await listen(server);

  if (acceptanceToken) {
    // Nonproduction harness only. This route is not imported, mounted, or reachable from
    // server.mjs; it lets the Robolectric Android client ask the relay to queue the harmless
    // read-only device.status command without the external Home Bridge.
    app.post("/acceptance/queue-device-status", async (req, res) => {
      if (String(req.headers["x-acceptance-token"] || "") !== acceptanceToken) {
        return res.status(403).json({ ok: false, error: "acceptance token required" });
      }
      const queued = await bridge.requestDeviceStatus({
        ownerDeviceId: OWNER_DEVICE_ID,
        targetDeviceId: String(req.body?.deviceId || TARGET_DEVICE_ID)
      });
      return res.status(queued.ok ? 201 : 409).json(queued);
    });
  }

  return {
    url,
    db,
    dbPath,
    bridge,
    deviceRepo,
    taskRepo,
    query,
    adapters,
    log,
    initialized,
    async close() {
      await closeServer(server);
      try { db.close(); } catch { /* already closed */ }
    }
  };
}

export async function api(baseUrl, path, { method = "GET", token = null, body = null, headers = {} } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, body: json, text };
}
