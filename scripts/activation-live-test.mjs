#!/usr/bin/env node
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTick } from "./nexus-tick.mjs";

/**
 * Mission 15 — live activation acceptance.
 *
 * Drives a real HTTP server over a real socket, with two independent credentials, through the whole
 * Ax -> Habitat -> NEXUS -> Ax lifecycle. The server process is killed and restarted over the same
 * SQLite file to prove state is reconstructed from storage. The NEXUS tick is the real one-shot
 * scheduler entrypoint (`scripts/nexus-tick.mjs`), not a stub.
 *
 * Evidence level: LOCAL. The D1 transport is `node:sqlite` behind a D1-shaped fetch shim; no
 * Cloudflare account, D1 database, Render service or ChatGPT connector is contacted. Tokens are
 * generated for this run and never printed.
 */

const AX_TOKEN = "axcmd_" + randomBytes(24).toString("base64url");
const BRIDGE_TOKEN = "axbridge_" + randomBytes(24).toString("base64url");
const NEXUS_TOKEN = "axnexus_" + randomBytes(24).toString("base64url");
const quiet = { log() {}, warn() {}, error() {} };

function makeEnv(sqlitePath) {
  return {
    ...process.env,
    ACTIVATION_SQLITE_PATH: sqlitePath,
    CLOUDFLARE_ACCOUNT_ID: "acct-m15-live",
    HABITAT_D1_DATABASE_ID: "db-m15-live",
    HABITAT_D1_API_TOKEN: "d1_token_m15_" + "x".repeat(16),
    HABITAT_AX_COMMAND_TOKEN: AX_TOKEN,
    HABITAT_AX_BRIDGE_TOKEN: BRIDGE_TOKEN,
    AX_NEXUS_TOKEN: NEXUS_TOKEN,
    HABITAT_OWNER_DEVICE_IDS: "owner-s26-ultra",
    NEXUS_RUNTIME_ENABLED: "true",
    AX_ORCHESTRATOR_ENABLED: "false",
    HABITAT_AX_MEMORY_PROJECT: "habitat"
  };
}

function sqliteD1Fetch({ db }) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/chat/completions")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: JSON.stringify({ steps: [] }) } }], usage: {} };
        }
      };
    }
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const statement = db.prepare(sql);
    const rows = /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)
      ? statement.all(...params)
      : (statement.run(...params), []);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
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
      // The bridge logs its own status lines before the child announces readiness, so scan every
      // complete line rather than assuming the first output is JSON.
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.ready) {
            clearTimeout(timer);
            resolve(parsed.port);
            return;
          }
        } catch {}
      }
    });
    child.on("exit", code => {
      clearTimeout(timer);
      reject(new Error("live app exited early (" + code + "): " + stderr.slice(0, 500)));
    });
  });
  return { child, base: "http://127.0.0.1:" + port };
}

async function stopApp(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
}

async function call(base, method, route, { token = null, nexus = false, body = null } = {}) {
  const headers = { "content-type": "application/json" };
  if (token && nexus) headers["x-nexus-token"] = token;
  else if (token) headers.authorization = "Bearer " + token;
  const response = await fetch(base + route, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " :: " + JSON.stringify(detail).slice(0, 400)));
  return Boolean(ok);
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "habitat-m15-"));
  const sqlitePath = path.join(dir, "activation.sqlite");
  const env = makeEnv(sqlitePath);
  const cwd = process.cwd();
  const correlationId = "mission15-live-" + randomBytes(4).toString("hex");
  const idempotencyKey = "mission15-live-task";
  let first;
  let second;
  try {
    first = await startApp(env, cwd);

    // 1. Real HTTP, real authenticator.
    const presence = await call(first.base, "GET", "/ax/command/presence", { token: AX_TOKEN });
    check("live server answers authenticated presence over HTTP", presence.status === 200, presence);

    // 2. Ax submits a harmless task.
    const submitted = await call(first.base, "POST", "/ax/command/messages", {
      token: AX_TOKEN,
      body: {
        kind: "task",
        body: "Harmless live acceptance probe",
        objective: "report runtime health",
        adapter: "runtime.health",
        correlationId,
        idempotencyKey
      }
    });
    check("Ax submits over HTTP and the message is durably queued", submitted.status === 201 && submitted.body?.message?.status === "queued", submitted);
    const messageId = submitted.body?.message?.id;
    check("direction is assigned by the authenticated surface", submitted.body?.message?.from === "ax", submitted.body?.message?.from);

    // 3. Unauthorized submission is rejected before storage.
    const anonymous = await call(first.base, "POST", "/ax/command/messages", {
      body: { kind: "note", body: "no credential", idempotencyKey: "mission15-anon" }
    });
    check("unauthenticated submission is rejected", anonymous.status === 401 && anonymous.body?.code === "invalid_token", anonymous);

    // 4. Duplicate submission does not queue a second execution.
    const duplicate = await call(first.base, "POST", "/ax/command/messages", {
      token: AX_TOKEN,
      body: { kind: "task", body: "Harmless live acceptance probe", objective: "report runtime health", adapter: "runtime.health", correlationId, idempotencyKey }
    });
    check("duplicate idempotency key replays the original message", duplicate.status === 200 && duplicate.body?.replayed === true && duplicate.body?.message?.id === messageId, duplicate);

    // 5. Ax cannot use the NEXUS surface.
    const spoof = await call(first.base, "POST", "/ax/nexus/messages/" + encodeURIComponent(messageId) + "/acknowledge", { token: AX_TOKEN });
    check("Ax credential is refused on the NEXUS surface", spoof.status === 401 && spoof.body?.code === "invalid_nexus_token", spoof);

    // 6. NEXUS acknowledges with its own credential.
    const ack = await call(first.base, "POST", "/ax/nexus/messages/" + encodeURIComponent(messageId) + "/acknowledge", { token: NEXUS_TOKEN, nexus: true, body: {} });
    check("NEXUS acknowledges over HTTP with its own credential", ack.status === 200 && ack.body?.message?.status === "acknowledged", ack);

    // 7. The scheduler's autonomy pass dispatches it as a real command task.
    const dispatchTick = await call(first.base, "POST", "/ax/command/scheduler/tick", { token: AX_TOKEN, body: { trigger: "mission-15-live" } });
    check("scheduler tick drains and dispatches the message", dispatchTick.status === 200 && dispatchTick.body?.autonomy?.messages?.submitted === 1, dispatchTick.body?.autonomy);
    const working = await call(first.base, "GET", "/ax/command/messages/" + encodeURIComponent(messageId), { token: AX_TOKEN });
    check("message moved to working with a bound task id", working.body?.message?.status === "working" && /^cmd_/.test(working.body?.message?.taskId || ""), working.body?.message);

    // 8. The real NEXUS tick executes the read-only adapter from a second SQLite connection.
    const db = new DatabaseSync(sqlitePath);
    db.exec("PRAGMA busy_timeout = 5000");
    const tick = await runTick({ env, fetchImpl: sqliteD1Fetch({ db }), log: quiet });
    check("real NEXUS tick executes the permitted task", tick.exitCode === 0 && tick.report?.tick?.claimed === 1, tick.report);
    db.close();

    // 9. The next autonomy pass settles the message from the task's own evidence.
    const settleTick = await call(first.base, "POST", "/ax/command/scheduler/tick", { token: AX_TOKEN, body: { trigger: "mission-15-live-settle" } });
    check("second tick completes the message from real evidence", settleTick.body?.autonomy?.messages?.completed === 1, settleTick.body?.autonomy);

    // 10. Ax retrieves the result by correlation id over HTTP.
    const thread = await call(first.base, "GET", "/ax/command/messages/thread/" + encodeURIComponent(correlationId), { token: AX_TOKEN });
    const terminal = thread.body?.terminal?.[0];
    check("Ax retrieves the completed result by correlation id", thread.status === 200 && terminal?.status === "completed" && (terminal?.result?.evidence || []).length > 0, thread.body);
    check("no decision is left pending", (thread.body?.awaitingDecision || []).length === 0, thread.body?.awaitingDecision);

    // 11. The audit trail covers submission, completion and the refused request.
    const audit = await call(first.base, "GET", "/ax/command/security/events?limit=200", { token: AX_TOKEN });
    const categories = (audit.body?.events || []).map(event => event.category);
    check("audit records submission, completion and the auth failure", audit.status === 200 && categories.includes("ax.message.submitted") && categories.includes("ax.message.completed") && categories.includes("auth.failure"), categories);

    // 12. Real process restart: kill the server, start a new one over the same file.
    await stopApp(first.child);
    second = await startApp(env, cwd);
    const afterRestart = await call(second.base, "GET", "/ax/command/messages/thread/" + encodeURIComponent(correlationId), { token: AX_TOKEN });
    check("result survives a real server-process restart", afterRestart.status === 200 && afterRestart.body?.terminal?.[0]?.status === "completed", afterRestart.body);

    const replayAfterRestart = await call(second.base, "POST", "/ax/command/messages", {
      token: AX_TOKEN,
      body: { kind: "task", body: "Harmless live acceptance probe", objective: "report runtime health", adapter: "runtime.health", correlationId, idempotencyKey }
    });
    check("duplicate still replays after restart", replayAfterRestart.body?.replayed === true && replayAfterRestart.body?.message?.id === messageId, replayAfterRestart.body);
    const idleTick = await call(second.base, "POST", "/ax/command/scheduler/tick", { token: AX_TOKEN, body: { trigger: "mission-15-live-idle" } });
    check("nothing is claimable after restart", idleTick.body?.autonomy?.messages?.examined === 0, idleTick.body?.autonomy);
    const idleDb = new DatabaseSync(sqlitePath);
    idleDb.exec("PRAGMA busy_timeout = 5000");
    const idleExecution = await runTick({ env, fetchImpl: sqliteD1Fetch({ db: idleDb }), log: quiet });
    idleDb.close();
    check("no duplicate execution after restart", idleExecution.report?.tick?.claimed === 0, idleExecution.report);

    // 13. The scheduler advances the next permitted task.
    const next = await call(second.base, "POST", "/ax/command/messages", {
      token: AX_TOKEN,
      body: {
        kind: "task",
        body: "Second harmless live probe",
        objective: "report runtime health",
        adapter: "runtime.health",
        correlationId: correlationId + "-next",
        idempotencyKey: idempotencyKey + "-next"
      }
    });
    const nextId = next.body?.message?.id;
    const nextTick = await call(second.base, "POST", "/ax/command/scheduler/tick", { token: AX_TOKEN, body: { trigger: "mission-15-live-next" } });
    const nextDb = new DatabaseSync(sqlitePath);
    nextDb.exec("PRAGMA busy_timeout = 5000");
    const nextExecution = await runTick({ env, fetchImpl: sqliteD1Fetch({ db: nextDb }), log: quiet });
    nextDb.close();
    const nextSettle = await call(second.base, "POST", "/ax/command/scheduler/tick", { token: AX_TOKEN, body: { trigger: "mission-15-live-next-settle" } });
    const nextThread = await call(second.base, "GET", "/ax/command/messages/thread/" + encodeURIComponent(correlationId + "-next"), { token: AX_TOKEN });
    check(
      "scheduler advances the next permitted task autonomously",
      next.status === 201 &&
        nextTick.body?.autonomy?.messages?.submitted === 1 &&
        nextExecution.report?.tick?.claimed === 1 &&
        nextSettle.body?.autonomy?.messages?.completed === 1 &&
        nextThread.body?.terminal?.[0]?.status === "completed",
      { nextId, autonomy: nextTick.body?.autonomy, tick: nextExecution.report?.tick, settle: nextSettle.body?.autonomy, thread: nextThread.body?.terminal?.[0]?.status }
    );

    // 14. Unconfigured NEXUS credential fails closed (proven by construction: this app has one).
    const noNexus = await call(second.base, "GET", "/ax/nexus/channel", { token: "" });
    check("NEXUS surface fails closed without its credential", noNexus.status === 401, noNexus);

    const passed = results.filter(row => row.ok).length;
    const report = {
      schemaVersion: 1,
      mission: 15,
      evidenceLevel: "local",
      transport: "real HTTP over 127.0.0.1; node:sqlite behind a D1-shaped fetch shim",
      simulated: ["D1 network transport", "Chat Completions provider (not used for message execution)"],
      checkedAt: new Date().toISOString(),
      correlationId,
      messageId,
      passed,
      total: results.length,
      ok: passed === results.length,
      checks: results
    };
    console.log(JSON.stringify(report, null, 2));
    const evidencePath = String(process.env.ACTIVATION_EVIDENCE_PATH || "").trim();
    if (evidencePath) await writeFile(evidencePath, JSON.stringify(report, null, 2) + "\n", "utf8");
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    if (first?.child) await stopApp(first.child);
    if (second?.child) await stopApp(second.child);
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error("ACTIVATION_LIVE_TEST_FAILED", error?.stack || String(error));
  process.exit(1);
});
