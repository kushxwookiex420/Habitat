#!/usr/bin/env node
/**
 * Staging acceptance for the mission pipeline.
 *
 * Runs the complete lifecycle over real HTTPS against the staging service: unauthenticated request refused,
 * authenticated objective submitted, mission run, mission retrieved with verified tasks and evidence.
 *
 * It refuses a non-staging origin, never prints the credential, and reports the exact variables and storage
 * dependencies it needed so a failed run says what is missing rather than "did not work".
 *
 * Usage:
 *   HABITAT_AX_COMMAND_TOKEN=... STAGING_BASE_URL=https://habitat-staging-e3ie.onrender.com \
 *     node scripts/staging-acceptance.mjs
 */

const STAGING_HOST = "habitat-staging-e3ie.onrender.com";
const PRODUCTION_HOST = "habitat-1-szzd.onrender.com";

export const ACCEPTANCE_ENV = Object.freeze([
  "STAGING_BASE_URL (defaults to https://" + STAGING_HOST + ")",
  "HABITAT_AX_COMMAND_TOKEN (must equal the staging service's HABITAT_AX_BRIDGE_TOKEN or command token)"
]);

export const SERVICE_DEPENDENCIES = Object.freeze([
  "HABITAT_WORKFORCE_ENABLED=true on the staging service",
  "CLOUDFLARE_ACCOUNT_ID + HABITAT_D1_DATABASE_ID + HABITAT_D1_API_TOKEN on the staging service",
  "migration 0010_ax_workforce applied to the staging database",
  "HABITAT_MISSION_ARTIFACTS_DIR pointing at persistent storage for artifacts (optional: defaults to a temporary directory, and artifacts are then lost on redeploy)"
]);

const OBJECTIVE = "Staging acceptance: assess the repository tests and verify the priority policy suite";
const CRITERIA = ["Tests tree analysed", "Priority suite verified"];
const TASKS = [
  { id: "t1", title: "Analyse the repository tests tree", requires: ["engineering"], dependsOn: [], criteria: [0] },
  { id: "t2", title: "Run tests/ax-priority-policy.test.mjs", requires: ["testing"], dependsOn: ["t1"], criteria: [1] }
];

function origin() {
  const raw = String(process.env.STAGING_BASE_URL || ("https://" + STAGING_HOST)).trim();
  let url;
  try { url = new URL(raw); } catch { return { ok: false, code: "invalid_base_url" }; }
  if (url.protocol !== "https:") return { ok: false, code: "https_required" };
  if (url.hostname === PRODUCTION_HOST) return { ok: false, code: "refuses_production" };
  if (url.hostname !== STAGING_HOST) return { ok: false, code: "not_the_staging_host" };
  return { ok: true, origin: url.origin };
}

async function call(origin, path, { method = "GET", token = null, body = null, timeoutMs = 60_000 } = {}) {
  try {
    const response = await fetch(origin + path, {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, json: null, error: String(error?.message || error).slice(0, 200) };
  }
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    requiredEnv: ACCEPTANCE_ENV,
    serviceDependencies: SERVICE_DEPENDENCIES,
    steps: {},
    ok: false
  };

  const base = origin();
  if (!base.ok) {
    report.blocked = base.code;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  const token = String(process.env.HABITAT_AX_COMMAND_TOKEN || "").trim();
  report.credentialPresent = Boolean(token);

  const health = await call(base.origin, "/health", { timeoutMs: 120_000 });
  report.steps.health = { status: health.status, commit: health.json?.commit || null };
  if (health.status !== 200) {
    report.blocked = "service_unreachable";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!token) {
    report.blocked = "ax_credential_missing";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const anonymous = await call(base.origin, "/ax/missions", { method: "POST", body: { objective: OBJECTIVE, acceptanceCriteria: CRITERIA } });
  report.steps.unauthenticated = { status: anonymous.status, code: anonymous.json?.code || null };

  const created = await call(base.origin, "/ax/missions", {
    method: "POST",
    token,
    body: {
      objective: OBJECTIVE,
      acceptanceCriteria: CRITERIA,
      tasks: TASKS,
      idempotencyKey: "staging-acceptance-" + new Date().toISOString().slice(0, 10)
    }
  });
  report.steps.submit = { status: created.status, code: created.json?.code || null, missionId: created.json?.mission?.missionId || null };
  if (created.status === 503) {
    report.blocked = created.json?.code || "mission_pipeline_unavailable";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  if (![200, 201].includes(created.status) || !created.json?.mission?.missionId) {
    report.blocked = created.json?.code || "submit_failed";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const missionId = created.json.mission.missionId;
  const run = await call(base.origin, "/ax/missions/" + encodeURIComponent(missionId) + "/run", { method: "POST", token, body: { maxRounds: 3 }, timeoutMs: 180_000 });
  report.steps.run = { status: run.status, missionStatus: run.json?.run?.status || null };

  const fetched = await call(base.origin, "/ax/missions/" + encodeURIComponent(missionId), { token });
  const mission = fetched.json?.mission || null;
  report.steps.retrieve = {
    status: fetched.status,
    missionStatus: mission?.status || null,
    tasks: (mission?.tasks || []).map((task) => ({
      id: task.id,
      status: task.status,
      agentId: task.agentId,
      verifierAgentId: task.verifierAgentId,
      evidence: task.evidence,
      tests: task.tests
    }))
  };

  report.ok = Boolean(
    fetched.status === 200 &&
    mission?.status === "completed" &&
    (mission.tasks || []).length >= 2 &&
    mission.tasks.every((task) => task.status === "completed" && task.verifierAgentId && (task.evidence || []).length > 0)
  );
  if (!report.ok) report.blocked = "mission_not_completed_and_verified";

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, fatal: String(error?.message || error).slice(0, 300) }));
  process.exitCode = 1;
});
