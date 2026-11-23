import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeError,
  resolveWorkerId,
  buildWorkerList,
  buildWorkerDetail,
  describeVerification
} from "../worker-catalog.mjs";

const QA = {
  id: "habitat-qa-worker",
  name: "Habitat QA Worker",
  kind: "model-backed",
  status: "available",
  model: "openrouter/free",
  capabilities: ["backend-health", "task-execution"]
};

function task(overrides = {}) {
  return {
    id: "task-1",
    title: "System Check",
    status: "blocked",
    worker: "habitat-qa-worker",
    createdAt: "2026-11-23T05:00:00.000Z",
    delegatedAt: "2026-11-23T05:00:01.000Z",
    completedAt: "2026-11-23T05:00:09.000Z",
    verifiedAt: null,
    error: null,
    result: JSON.stringify({ verification: { backendHealth: "PASS", androidHeartbeat: "FAIL" } }),
    ...overrides
  };
}

test("a JSON-null error is absent, never the literal string null", () => {
  assert.equal(normalizeError(null), "");
  assert.equal(normalizeError(undefined), "");
  assert.equal(normalizeError("null"), "");
  assert.equal(normalizeError(" undefined "), "");
  assert.equal(normalizeError("provider timeout"), "provider timeout");
  assert.equal(normalizeError({ toString: () => "object-error" }), "object-error");
});

test("worker aliases used by the Android mesh resolve to registry ids", () => {
  assert.equal(resolveWorkerId("product-scout"), "dropilot-product-scout");
  assert.equal(resolveWorkerId("listing-opt"), "dropilot-listing-optimizer");
  assert.equal(resolveWorkerId("growth-ops"), "dropilot-growth-operator");
  assert.equal(resolveWorkerId("ax-orchestrator"), "habitat-orchestrator");
  assert.equal(resolveWorkerId("habitat-qa-worker"), "habitat-qa-worker");
});

test("a worker with a real failure reports the failure in its job history and logs", () => {
  const detail = buildWorkerDetail({
    worker: QA,
    tasks: [task(), task({ id: "task-0", status: "verified", completedAt: "2026-11-22T00:00:00.000Z", createdAt: "2026-11-22T00:00:00.000Z" })]
  });
  assert.equal(detail.id, "habitat-qa-worker");
  assert.equal(detail.runtime.jobCount, 2);
  assert.equal(detail.jobs[0].status, "blocked");
  assert.equal(detail.jobs[0].error, null);
  assert.match(detail.jobs[0].summary, /blocked: androidHeartbeat=FAIL/);
  assert.equal(detail.runtime.verified, 1);
  assert.equal(detail.runtime.blocked, 1);
  assert.equal(detail.controls.canRetry, true);
  assert.equal(detail.controls.retryTaskId, "task-1");
  assert.equal(detail.controls.canRunCheck, true);
  const log = detail.logs.join("\n");
  assert.match(log, /created\s+System Check/);
  assert.match(log, /blocked\s+task-1/);
  assert.equal(log.includes("null"), false);
});

test("a provider outage blocks every model worker with an actionable reason", () => {
  const workers = buildWorkerList({
    workers: [QA, { ...QA, id: "dropilot-product-scout", name: "DropPilot Product Scout" }],
    tasks: [],
    providerConfigured: false
  });
  for (const worker of workers) {
    assert.equal(worker.status, "blocked");
    assert.match(worker.blockedReason, /No AI provider key is configured/);
    assert.equal(worker.lastRunAt, null);
    assert.equal(worker.jobCount, 0);
  }
});

test("an available worker with no jobs is available, not blocked and not fake-running", () => {
  const list = buildWorkerList({ workers: [QA], tasks: [], providerConfigured: true });
  assert.equal(list[0].status, "available");
  assert.equal(list[0].blockedReason, null);
  assert.equal(list[0].lastStatus, null);
});

test("verification lines name the failing check and its real detail", () => {
  const described = describeVerification(
    {
      backendHealth: "PASS",
      modelWorker: "PASS",
      androidHeartbeat: "FAIL",
      androidDeviceAccess: "UNVERIFIED",
      taskCreation: "PASS",
      storage: "PASS"
    },
    {
      androidHeartbeat: { detail: "No paired Android device checked in within 45 minutes." },
      androidDeviceAccess: { detail: "No Habitat Android device has checked in recently." }
    }
  );
  assert.equal(described.verified, false);
  assert.equal(described.blockers.length, 2);
  assert.match(described.lines.join("\n"), /Android heartbeat: FAIL — No paired Android device/);
  assert.match(described.lines.join("\n"), /Android device access: UNVERIFIED — No Habitat Android device/);
  assert.deepEqual(described.blockers.map((blocker) => blocker.check), ["androidHeartbeat", "androidDeviceAccess"]);
});

test("a failing check with no detail still explains itself", () => {
  const described = describeVerification({ backendHealth: "FAIL" });
  assert.equal(described.verified, false);
  const blocker = described.blockers.find((item) => item.check === "backendHealth");
  assert.equal(blocker.detail, "No reason was reported for this check.");
  assert.equal(described.lines.length, 6);
});

test("server exposes worker detail and never prints a null worker error", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.equal(server.includes('app.get("/workers/:id"'), true, "the worker detail route must exist");
  assert.equal(server.includes("verificationDetails"), true, "system checks must record per-check detail");
  assert.equal(server.includes("Worker error: null"), false);
});
