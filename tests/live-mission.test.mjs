import test from "node:test";
import assert from "node:assert/strict";
import { checkConfiguration, missionPlan, runLiveMission, verifyStoredMission } from "../scripts/live-mission.mjs";

/**
 * Mission 19 — first live mission runner.
 *
 * The network is injected. These tests prove the script refuses without a credential, submits and
 * follows the documented endpoint sequence, and never writes the token into its evidence.
 */

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

function fakeFetch({ complete = true, verified = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: options.method, auth: Boolean(options.headers?.authorization) });
    if (pathname === "/ax/command/objectives" && options.method === "POST") {
      return response(201, { ok: true, replayed: false, objective: { id: "obj_live_1", status: "received" } });
    }
    if (pathname.endsWith("/understand")) return response(200, { ok: true, objective: { id: "obj_live_1", status: "understood" } });
    if (pathname.endsWith("/plan")) return response(200, { ok: true, objective: { id: "obj_live_1", status: "planned" } });
    if (pathname === "/ax/command/scheduler/tick") return response(200, { ok: true, autonomy: { objectives: { advanced: [{ id: "obj_live_1", missionStatus: "completed" }] } } });
    if (pathname === "/ax/command/objectives/obj_live_1") {
      return response(200, {
        ok: true,
        objective: {
          id: "obj_live_1",
          status: complete ? "completed" : "executing",
          correlationId: "cor_mission_live",
          updatedAt: "2026-11-22T08:00:00.000Z",
          verification: { verified },
          evidence: [{ id: "ev_1" }, { id: "ev_2" }, { id: "ev_3" }, { id: "ev_4" }]
        }
      });
    }
    return response(404, { ok: false, code: "not_found" });
  };
  return { fetchImpl, calls };
}

test("the runner refuses to submit without a token and makes no request", async () => {
  let called = false;
  const result = await runLiveMission({ token: null, fetchImpl: async () => { called = true; throw new Error("must not be called"); } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "token_required");
  assert.equal(called, false);
});

test("a configured mission follows create -> understand -> plan -> tick -> read and proves completion", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await runLiveMission({ origin: "https://habitat.example.test", token: "secret-token-value", fetchImpl, pollMs: 1 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.code, "completed");
  assert.equal(result.objectiveId, "obj_live_1");
  assert.deepEqual(result.endpoints.map(item => item.step), ["create_objective", "understand", "plan", "scheduler_tick", "read_objective"]);
  assert.equal(result.objective.evidence, 4);
  assert.equal(result.objective.verification.verified, true);
  assert.equal(result.tick.status, 200);
  assert.ok(calls.every(call => call.auth), "every call carried the credential");
  assert.ok(!JSON.stringify(result).includes("secret-token-value"), "the token is never written into evidence");
  assert.deepEqual(missionPlan().steps.map(step => step.agent), ["memory", "research", "security", "verification"]);
});

test("a mission that ends executing is reported as not completed, never as success", async () => {
  const { fetchImpl } = fakeFetch({ complete: false });
  const result = await runLiveMission({ origin: "https://habitat.example.test", token: "t", fetchImpl, pollMs: 1, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "mission_not_completed");
  assert.equal(result.objective.status, "executing");
});

test("an unverified completion is rejected", async () => {
  const { fetchImpl } = fakeFetch({ verified: false });
  const result = await runLiveMission({ origin: "https://habitat.example.test", token: "t", fetchImpl, pollMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "verification_not_passed");
});

test("the post-restart check proves a stored verified result without running anything", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await verifyStoredMission({ origin: "https://habitat.example.test", token: "t", objectiveId: "obj_live_1", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.code, "persisted_verified_result");
  assert.equal(result.evidence, 4);
  assert.deepEqual(result.evidenceIds, ["ev_1", "ev_2", "ev_3", "ev_4"]);
  assert.equal(calls.length, 1, "only a read was performed");
  assert.equal(calls[0].method, "GET");
});

test("configuration check reports presence without revealing a value", () => {
  const blocked = checkConfiguration({});
  assert.equal(blocked.tokenConfigured, false);
  const ready = checkConfiguration({ HABITAT_AX_COMMAND_TOKEN: "super-secret" });
  assert.equal(ready.tokenConfigured, true);
  assert.ok(!JSON.stringify(ready).includes("super-secret"));
});
