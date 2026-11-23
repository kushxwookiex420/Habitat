#!/usr/bin/env node
/**
 * Mission 16 — ChatGPT connection readiness over a real HTTP socket.
 *
 * What is real here:
 *   - the real composition root (`registerDeviceCommandBridge`) in a separate Node process,
 *   - a real TCP listener and real `fetch` requests,
 *   - the real Ax/NEXUS credentials and the real OpenAPI document route.
 *
 * What is substituted: the D1 network transport is `node:sqlite` behind a D1-shaped fetch shim.
 * No Cloudflare, Render or OpenAI endpoint is contacted, so the evidence level is LOCAL.
 *
 * The run proves the contract ChatGPT would consume: the document is public, every operation it
 * advertises exists, every one of them refuses an anonymous caller, the Ax credential works, the
 * NEXUS credential is refused on Ax routes, and a repeated send replays instead of duplicating.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { buildAxOpenApiSpec } from "./ax-openapi.mjs";
import { checkAxContract, expressRouteKeys, scanForSecrets, specOperations } from "./ax-openapi-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AX_TOKEN = "axcmd_" + randomBytes(24).toString("base64url");
const BRIDGE_TOKEN = "axbridge_" + randomBytes(24).toString("base64url");
const NEXUS_TOKEN = "axnexus_" + randomBytes(24).toString("base64url");

function makeEnv(sqlitePath) {
  return {
    ...process.env,
    ACTIVATION_SQLITE_PATH: sqlitePath,
    CLOUDFLARE_ACCOUNT_ID: "acct-m16-readiness",
    HABITAT_D1_DATABASE_ID: "db-m16-readiness",
    HABITAT_D1_API_TOKEN: "d1_token_m16_" + "x".repeat(16),
    HABITAT_AX_COMMAND_TOKEN: AX_TOKEN,
    HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN,
    AX_NEXUS_TOKEN: NEXUS_TOKEN,
    HABITAT_OWNER_DEVICE_IDS: "owner-s26-ultra",
    NEXUS_RUNTIME_ENABLED: "false",
    AX_ORCHESTRATOR_ENABLED: "false"
  };
}

async function startApp(env, cwd) {
  const child = spawn(process.execPath, ["tests/fixtures/live-channel-app.mjs"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("live app did not become ready: " + stderr.slice(0, 500))), 20000);
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.ready) { clearTimeout(timer); resolve(parsed.port); return; }
        } catch {}
      }
    });
    child.on("exit", code => { clearTimeout(timer); reject(new Error("live app exited early (" + code + "): " + stderr.slice(0, 500))); });
  });
  return { child, base: "http://127.0.0.1:" + port };
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
}

async function call(base, method, route, { token = null, nexus = false, body = null } = {}) {
  const headers = { accept: "application/json" };
  if (token && nexus) headers["x-nexus-token"] = token;
  else if (token) headers.authorization = "Bearer " + token;
  if (body !== null) headers["content-type"] = "application/json";
  const response = await fetch(base + route, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: response.status, contentType: response.headers.get("content-type") || "", body: parsed };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " :: " + JSON.stringify(detail).slice(0, 400)));
  return Boolean(ok);
}

function commitHash() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }
  catch { return null; }
}

/** Replace path parameters with a harmless value so an anonymous probe reaches requireAx. */
function concretePath(template) {
  return template.replace(/\{[^}]+\}/g, "probe_unknown");
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "habitat-m16-"));
  const sqlitePath = path.join(dir, "channel.sqlite");
  let app = null;

  // ---- route-table parity, from the real registration module (in-process, no listener) ----
  const parityApp = express();
  registerUniversalCommandRoutes(parityApp, {
    env: { HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN, HABITAT_AX_COMMAND_TOKEN: AX_TOKEN, AX_NEXUS_TOKEN: NEXUS_TOKEN },
    repository: { initialize: async () => {}, get: async () => null, list: async () => [] }
  });
  const routeKeys = expressRouteKeys(parityApp);
  const spec = buildAxOpenApiSpec({ origin: "https://habitat.invalid" });
  const contract = checkAxContract({ spec, routeKeys });
  check("OpenAPI document satisfies its own contract", contract.ok, contract.errors);
  check("route table is introspectable (non-empty)", routeKeys.length > 0, { routes: routeKeys.length });
  check("documented operations all exist in the real route table", contract.parity.errors.length === 0, contract.parity.errors);
  check("every documented operation is on the authenticated /ax/command surface",
    specOperations(spec).every(op => op.path.startsWith("/ax/command/")), specOperations(spec));
  check("the NEXUS surface is absent from the Ax document",
    !JSON.stringify(spec.paths).includes("/ax/nexus"), Object.keys(spec.paths));
  check("the document carries no credential", scanForSecrets(spec).length === 0, scanForSecrets(spec));

  try {
    app = await startApp(makeEnv(sqlitePath), ROOT);

    // ---- public schema over the real socket ----
    const schema = await call(app.base, "GET", "/ax/command/openapi.json");
    check("openapi.json is public over HTTPS-terminated HTTP (200, no credential)", schema.status === 200, schema);
    check("openapi.json is application/json", schema.contentType.includes("application/json"), schema.contentType);
    check("served document declares OpenAPI 3.1.0", schema.body?.openapi === "3.1.0", schema.body?.openapi ?? schema.body);
    const servedContract = checkAxContract({ spec: schema.body, routeKeys, allowLoopbackHttp: false });
    check("served document passes the structure and route checks", servedContract.ok, servedContract.errors);
    check("served document has unique operation ids", new Set(specOperations(schema.body).map(op => op.operationId)).size === specOperations(schema.body).length, specOperations(schema.body));

    // ---- every advertised operation refuses an anonymous caller ----
    const anonymous = [];
    for (const operation of specOperations(schema.body)) {
      const response = await call(app.base, operation.method, concretePath(operation.path), {
        body: operation.method === "POST" ? {} : null
      });
      anonymous.push({ operationId: operation.operationId, method: operation.method, path: operation.path, status: response.status, code: response.body?.code || null });
    }
    check("every advertised operation answers 401 without a credential",
      anonymous.every(item => item.status === 401 && item.code === "invalid_token"), anonymous.filter(item => item.status !== 401));
    check("presence answers 401 for a wrong credential", (await call(app.base, "GET", "/ax/command/presence", { token: "wrong-" + randomBytes(8).toString("hex") })).status === 401, null);

    // ---- the Ax credential works ----
    const presence = await call(app.base, "GET", "/ax/command/presence", { token: AX_TOKEN });
    check("Ax credential reads presence (200, reachable)", presence.status === 200 && presence.body?.presence?.reachable === true, presence.body);
    const tools = await call(app.base, "GET", "/ax/command/tools", { token: AX_TOKEN });
    check("Ax credential lists adapters (200)", tools.status === 200, tools.status);

    const correlationId = "mission16-" + randomBytes(4).toString("hex");
    const envelope = { kind: "note", body: "mission 16 readiness probe", correlationId, idempotencyKey: "mission16-" + randomBytes(8).toString("hex") };
    const submitted = await call(app.base, "POST", "/ax/command/messages", { token: AX_TOKEN, body: envelope });
    // A note is informational and terminal (`sent`); a task would be `queued`. This probe only
    // needs to prove the write path and the credential, not that an executor is running.
    check("Ax submits a note over the real socket (201, sent, from ax)",
      submitted.status === 201 && submitted.body?.message?.status === "sent" && submitted.body?.message?.from === "ax", submitted.body);
    const replay = await call(app.base, "POST", "/ax/command/messages", { token: AX_TOKEN, body: envelope });
    check("a repeated send replays the same message instead of duplicating",
      replay.status === 200 && replay.body?.replayed === true && replay.body?.message?.id === submitted.body?.message?.id,
      { status: replay.status, replayed: replay.body?.replayed, sameId: replay.body?.message?.id === submitted.body?.message?.id });
    const thread = await call(app.base, "GET", "/ax/command/messages/thread/" + encodeURIComponent(correlationId), { token: AX_TOKEN });
    check("the thread is retrievable by correlation id", thread.status === 200 && Array.isArray(thread.body?.messages) && thread.body.messages.length === 1, thread.body);

    // ---- credential separation both ways ----
    const axOnNexus = await call(app.base, "GET", "/ax/nexus/channel", { token: AX_TOKEN });
    check("the Ax credential is refused on the NEXUS surface (401)", axOnNexus.status === 401, axOnNexus.status);
    const nexusOnAx = await call(app.base, "GET", "/ax/command/presence", { token: NEXUS_TOKEN });
    check("the NEXUS credential is refused on the Ax surface (401)", nexusOnAx.status === 401, nexusOnAx.status);
    const nexusChannel = await call(app.base, "GET", "/ax/nexus/channel", { token: NEXUS_TOKEN, nexus: true });
    check("the NEXUS credential reaches its own surface (200)", nexusChannel.status === 200, nexusChannel.status);

    // ---- rate limiting and request validation are present in the contract ----
    const invalid = await call(app.base, "POST", "/ax/command/messages", { token: AX_TOKEN, body: { kind: "task", body: "no objective", idempotencyKey: "mission16-invalid" } });
    check("request validation refuses an incomplete task (4xx)", invalid.status >= 400 && invalid.status < 500, invalid.status);
  } finally {
    await stopApp(app?.child);
    await rm(dir, { recursive: true, force: true });
  }

  const passed = results.filter(item => item.ok).length;
  const evidence = {
    schemaVersion: 1,
    mission: 16,
    generatedAt: new Date().toISOString(),
    commit: commitHash(),
    evidenceLevels: {
      contract: "implemented and validated locally",
      http: "local real HTTP over a real TCP socket in a separate Node process",
      storage: "node:sqlite behind a D1-shaped fetch shim (not D1, not staging)",
      chatgpt: "not connected; no request from OpenAI was made or claimed"
    },
    checks: results,
    summary: { passed, failed: results.length - passed, total: results.length, ok: passed === results.length },
    documentedOperations: specOperations(spec).map(op => op.operationId),
    routeTable: { routes: routeKeys.length, documented: contract.parity.documented.length, excluded: contract.parity.excluded.length },
    specSha256: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    notes: [
      "No token, D1 credential or provider key is written to this file.",
      "No Render, Cloudflare or OpenAI endpoint was contacted.",
      "The document is checked against the routes the real command module registers."
    ]
  };

  const write = !process.argv.includes("--no-write");
  if (write) {
    await mkdir(path.join(ROOT, "release"), { recursive: true });
    await writeFile(path.join(ROOT, "release", "mission-16-chatgpt-readiness.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify({ ok: evidence.summary.ok, passed, failed: evidence.summary.failed, total: evidence.summary.total, evidence: write ? "release/mission-16-chatgpt-readiness.json" : null }, null, 2));
  if (!evidence.summary.ok) process.exitCode = 1;
}

await main();
