import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCostGovernor } from "../ax-cost-governor.mjs";
import { createD1CostLedgerStore, createD1CostLedgerStoreFromEnv } from "../d1-ax-cost-ledger-repository.mjs";
import { createPinnedHttpsFetch, createWebResearchTransport } from "../ax-web-research.mjs";
import { createEngineeringSandbox } from "../ax-engineering-sandbox.mjs";
import { createSandboxEngineeringTransport } from "../ax-agent-transports.mjs";

/**
 * Mission 21 — durable accounting, pinned transport and engineering sandbox.
 *
 * The cost tests run the real repository SQL against SQLite (the closest local equivalent to D1).
 * The pinned fetch tests assert the actual https.request options, not a summary. The sandbox tests
 * prove the production source is never written and that approval is mandatory.
 */

function sqliteQuery(db) {
  return async (sql, params = []) => {
    // Yield between reads so two governors genuinely interleave and the CAS retry is exercised.
    if (/^\s*SELECT/i.test(sql)) await new Promise(resolve => setTimeout(resolve, 1));
    const statement = db.prepare(sql);
    const wantsRows = /^\s*SELECT/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (wantsRows) return [{ results: statement.all(...params) }];
    statement.run(...params);
    return [{ results: [] }];
  };
}

test("two service instances cannot exceed the daily budget through the D1 ledger", async () => {
  const db = new DatabaseSync(":memory:");
  const query = sqliteQuery(db);
  const storeA = createD1CostLedgerStore({ query });
  const storeB = createD1CostLedgerStore({ query });
  const limits = { taskUsd: 1, dailyUsd: 0.01 };
  const a = createCostGovernor({ store: storeA, limits, freeOnly: true });
  const b = createCostGovernor({ store: storeB, limits, freeOnly: true });

  const [first, second] = await Promise.all([
    a.reserve({ taskId: "mission-a", estimateUsd: 0.006, free: true }),
    b.reserve({ taskId: "mission-b", estimateUsd: 0.006, free: true })
  ]);
  assert.equal([first, second].filter(result => result.ok).length, 1, "only one reservation fits the day");
  assert.equal([first, second].find(result => !result.ok).code, "daily_budget_exceeded");
  const row = db.prepare("SELECT state_json FROM habitat_ax_cost_ledger").get();
  const state = JSON.parse(row.state_json);
  assert.ok(state.reservedUsd <= 0.01);
});

test("daily spend survives a new governor over the same durable ledger", async () => {
  const db = new DatabaseSync(":memory:");
  const query = sqliteQuery(db);
  const limits = { taskUsd: 0.02, dailyUsd: 0.01 };
  const before = createCostGovernor({ store: createD1CostLedgerStore({ query }), limits, freeOnly: true });
  const reservation = await before.reserve({ taskId: "mission-1", estimateUsd: 0.006, free: true });
  assert.equal(reservation.ok, true);
  await before.settle({ taskId: "mission-1", estimateUsd: 0.006, costUsd: 0.006 });

  // A restart: a new store, governor and process reading the same database.
  const after = createCostGovernor({ store: createD1CostLedgerStore({ query }), limits, freeOnly: true });
  const status = await after.status();
  assert.equal(status.spentUsd, 0.006);
  assert.equal(status.durable, true);
  const refused = await after.reserve({ taskId: "mission-2", estimateUsd: 0.006, free: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "daily_budget_exceeded");
});

test("the D1 ledger falls back to no store without credentials and refuses a paid call", async () => {
  assert.equal(createD1CostLedgerStoreFromEnv({}), null);
  const db = new DatabaseSync(":memory:");
  const governor = createCostGovernor({ store: createD1CostLedgerStore({ query: sqliteQuery(db) }), freeOnly: true });
  const refused = await governor.reserve({ taskId: "paid", estimateUsd: 0.006, free: false });
  assert.equal(refused.code, "free_only_refused");
  assert.equal((await governor.status()).reservedUsd, 0);
});

function fakeHttps(capture) {
  return {
    request(options, callback) {
      capture.options = options;
      const response = Readable.from([Buffer.from("hello pinned")]);
      response.statusCode = 200;
      response.headers = { "content-type": "text/plain", "x-test": "1" };
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = error => request.emit("error", error || new Error("destroyed"));
      request.end = () => queueMicrotask(() => callback(response));
      return request;
    }
  };
}

test("the pinned transport connects to the validated IP while keeping hostname TLS verification", async () => {
  const capture = {};
  const pinnedFetch = createPinnedHttpsFetch({ httpsImpl: fakeHttps(capture) });
  const response = await pinnedFetch("https://example.com/page?q=1", { address: "93.184.216.34", family: 4 });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello pinned");
  assert.equal(capture.options.servername, "example.com");
  assert.equal(capture.options.hostname, "example.com");
  assert.equal(capture.options.rejectUnauthorized, true);
  assert.equal(capture.options.minVersion, "TLSv1.2");
  assert.equal(capture.options.headers.host, "example.com");
  assert.equal(capture.options.path, "/page?q=1");
  let resolved = null;
  capture.options.lookup("example.com", {}, (error, address, family) => { resolved = { error, address, family }; });
  assert.deepEqual(resolved, { error: null, address: "93.184.216.34", family: 4 });
  await assert.rejects(() => pinnedFetch("https://example.com/", { address: "127.0.0.1" }), /pinned_address_refused/);
});

test("web research passes the validated address to the pinned transport and revalidates redirects", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, address: options.address });
    return {
      status: 200,
      headers: { get: name => (name.toLowerCase() === "content-type" ? "text/plain" : null) },
      text: async () => "The service is available for read access and the evidence is recorded.",
      body: null
    };
  };
  const transport = createWebResearchTransport({
    fetchImpl,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  const result = await transport({ objective: "Research https://example.com/page about service evidence" });
  assert.equal(result.sources.length, 1);
  assert.equal(seen[0].address, "93.184.216.34");
  assert.equal(seen[0].url, "https://example.com/page");
});

test("the sandbox refuses a change without owner approval and never touches the source", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "nexus21-src-"));
  const parent = await mkdtemp(path.join(os.tmpdir(), "nexus21-ws-"));
  try {
    await writeFile(path.join(source, "module.mjs"), "export const answer = 1;\n");
    const audit = [];
    const sandbox = createEngineeringSandbox({
      sourceRoot: source,
      workspaceParent: parent,
      approvalVerifier: async (approval, context) => approval?.token === "owner-approved" ? { ok: true, approvedBy: "owner", context } : { ok: false, code: "approval_required" },
      checks: [{ name: "syntax", command: process.execPath, args: ["--check", "module.mjs"] }],
      allowedCommands: [process.execPath],
      audit: entry => audit.push(entry)
    });
    const refused = await sandbox.apply({
      objective: "Change the answer",
      changes: [{ path: "module.mjs", content: "export const answer = 2;\n" }]
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "approval_required");
    assert.equal(await readFile(path.join(source, "module.mjs"), "utf8"), "export const answer = 1;\n");
    assert.ok(audit.some(entry => entry.category === "sandbox.refusal"));

    const applied = await sandbox.apply({
      objective: "Change the answer",
      approval: { token: "owner-approved" },
      changes: [{ path: "module.mjs", content: "export const answer = 2;\n" }]
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.approved, true);
    assert.equal(applied.verified, true);
    assert.ok(applied.proposalId.startsWith("sbx_"));
    assert.equal(applied.checks[0].exitCode, 0);
    assert.match(applied.changes[0].diff.join("\n"), /^-export const answer = 1;/m);
    assert.match(applied.changes[0].diff.join("\n"), /^\+export const answer = 2;/m);
    assert.equal(await readFile(applied.workspace + "/module.mjs", "utf8"), "export const answer = 2;\n");
    assert.equal(await readFile(path.join(source, "module.mjs"), "utf8"), "export const answer = 1;\n", "production source was never written");
    assert.ok(audit.some(entry => entry.category === "sandbox.approved"));
    assert.ok(audit.some(entry => entry.category === "sandbox.applied"));

    const rolled = await sandbox.rollback();
    assert.equal(rolled.ok, true);
    assert.equal(await readFile(applied.workspace + "/module.mjs", "utf8"), "export const answer = 1;\n");
    assert.ok(audit.some(entry => entry.category === "sandbox.rolled_back"));
    await sandbox.discard();
    assert.equal(existsSync(applied.workspace), false);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("the sandbox rejects traversal, oversized changes and failing checks", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "nexus21-src2-"));
  const parent = await mkdtemp(path.join(os.tmpdir(), "nexus21-ws2-"));
  try {
    await writeFile(path.join(source, "module.mjs"), "export const answer = 1;\n");
    const sandbox = createEngineeringSandbox({
      sourceRoot: source,
      workspaceParent: parent,
      approvalVerifier: async () => ({ ok: true, approvedBy: "owner" }),
      checks: [{ name: "syntax", command: process.execPath, args: ["--check", "module.mjs"] }],
      allowedCommands: [process.execPath],
      limits: { maxFiles: 1 }
    });
    const traversal = await sandbox.apply({ objective: "escape", approval: {}, changes: [{ path: "../evil.mjs", content: "x" }] });
    assert.equal(traversal.code, "path_not_allowed");
    const tooMany = await sandbox.apply({
      objective: "two files",
      approval: {},
      changes: [{ path: "module.mjs", content: "x" }, { path: "other.mjs", content: "y" }]
    });
    assert.equal(tooMany.code, "too_many_files");
    const notAllowed = await sandbox.apply({
      objective: "run a shell",
      approval: {},
      changes: [{ path: "module.mjs", content: "export const answer = 3;\n" }],
      checks: [{ name: "shell", command: "/bin/sh", args: ["-c", "echo hi"] }]
    });
    assert.equal(notAllowed.checks[0].refused, true);
    assert.equal(notAllowed.verified, false);

    const failing = await sandbox.apply({
      objective: "break the module",
      approval: {},
      changes: [{ path: "module.mjs", content: "export const answer = ;\n" }]
    });
    assert.equal(failing.ok, true);
    assert.equal(failing.verified, false);
    assert.notEqual(failing.checks[0].exitCode, 0);
    assert.equal(await readFile(path.join(source, "module.mjs"), "utf8"), "export const answer = 1;\n");
    await sandbox.discard();
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("the sandbox transport keeps read-only behavior and applies only approved change sets", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "nexus21-src3-"));
  const parent = await mkdtemp(path.join(os.tmpdir(), "nexus21-ws3-"));
  try {
    await writeFile(path.join(source, "module.mjs"), "export const answer = 1;\n");
    const sandbox = createEngineeringSandbox({
      sourceRoot: source,
      workspaceParent: parent,
      approvalVerifier: async approval => approval?.token === "owner" ? { ok: true, approvedBy: "owner" } : { ok: false, code: "approval_required" },
      checks: [{ name: "syntax", command: process.execPath, args: ["--check", "module.mjs"] }],
      allowedCommands: [process.execPath]
    });
    let inspected = 0;
    const transport = createSandboxEngineeringTransport({
      sandbox,
      fallback: async () => { inspected += 1; return { ok: true, summary: "read-only", files: [], commands: [] }; }
    });
    assert.equal((await transport({ objective: "inspect" })).summary, "read-only");
    assert.equal(inspected, 1);
    const refused = await transport({ objective: "write", changes: [{ path: "module.mjs", content: "export const answer = 2;\n" }] });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "approval_required");
    assert.equal(await readFile(path.join(source, "module.mjs"), "utf8"), "export const answer = 1;\n");
    const applied = await transport({
      objective: "write",
      approval: { token: "owner" },
      changes: [{ path: "module.mjs", content: "export const answer = 2;\n" }]
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.sandbox.verified, true);
    assert.equal(applied.commands[0].exitCode, 0);
    assert.equal(await readFile(path.join(source, "module.mjs"), "utf8"), "export const answer = 1;\n");
    await sandbox.discard();
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
