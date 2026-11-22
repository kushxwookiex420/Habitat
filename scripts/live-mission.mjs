#!/usr/bin/env node
/**
 * Mission 19 — first live read-only mission.
 *
 * This script submits a harmless objective through the real Habitat objective API, plans it across
 * real agents, asks the scheduler to own it, and records every endpoint response. It performs no
 * deploy, no publish and no spend beyond the objective's declared budget ceiling (the deterministic
 * plan makes no model call).
 *
 * It refuses to run without an Ax command token. The token is read from the environment only and is
 * never printed or written to evidence.
 *
 *   node scripts/live-mission.mjs --check
 *   HABITAT_AX_COMMAND_TOKEN=... node scripts/live-mission.mjs --json release/mission-19-live.json
 *   # after a Render restart, prove persistence:
 *   HABITAT_AX_COMMAND_TOKEN=... node scripts/live-mission.mjs --objective <id>
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ORIGIN = "https://habitat-1-szzd.onrender.com";

export const LIVE_MISSION = Object.freeze({
  key: "mission-19-live-readonly-1",
  objective: "Research the README.md evidence in this repository and audit the adapter allowlist",
  criteria: [
    "Repository evidence cites README.md with evidence",
    "The adapter allowlist was audited"
  ],
  budgetUsd: 0.05
});

export function missionPlan() {
  return {
    risk: "low",
    steps: [
      { objective: "Recall approved project memory relevant to the read-only mission", agent: "memory", adapter: null, requiresApproval: false },
      { objective: "Gather citable evidence from README.md in the repository", agent: "research", adapter: null, requiresApproval: false },
      { objective: "Audit the adapter allowlist and permissions", agent: "security", adapter: null, requiresApproval: false },
      { objective: "Independently check the recorded evidence against every acceptance criterion", agent: "verification", adapter: null, requiresApproval: false }
    ]
  };
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);

async function call(fetchImpl, origin, method, pathname, { token = null, body = null, timeoutMs = 30_000 } = {}) {
  const headers = { accept: "application/json" };
  if (body !== null) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  try {
    const response = await fetchImpl(origin + pathname, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: response.status, ok: response.status >= 200 && response.status < 300, json };
  } catch (error) {
    return { status: 0, ok: false, json: null, error: String(error?.message || error).slice(0, 160) };
  }
}

/**
 * Submit and follow one mission. Endpoint evidence is returned for every call so the completion
 * report can quote actual responses rather than a summary of intent.
 */
export async function runLiveMission({
  origin = DEFAULT_ORIGIN,
  token = null,
  fetchImpl = globalThis.fetch,
  mission = LIVE_MISSION,
  plan = missionPlan(),
  timeoutMs = 90_000,
  pollMs = 2_000,
  now = () => new Date().toISOString(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, "");
  const report = {
    schemaVersion: 1,
    generatedAt: now(),
    origin: base,
    mode: "live-mission",
    ok: false,
    code: null,
    objectiveId: null,
    endpoints: [],
    objective: null,
    tick: null,
    tokenUsed: Boolean(token)
  };
  if (!token) return { ...report, code: "token_required", error: "HABITAT_AX_COMMAND_TOKEN is required; this script will not attempt an unauthenticated mission." };

  const created = await call(fetchImpl, base, "POST", "/ax/command/objectives", { token, body: mission });
  report.endpoints.push({ step: "create_objective", status: created.status, code: created.json?.code || null, replayed: created.json?.replayed === true });
  if (!created.ok || !created.json?.objective?.id) {
    return { ...report, code: "objective_create_failed", error: created.json?.error || created.error || "The objective API did not return an id." };
  }
  const id = created.json.objective.id;
  report.objectiveId = id;

  const understood = await call(fetchImpl, base, "POST", "/ax/command/objectives/" + encodeURIComponent(id) + "/understand", {
    token,
    body: {
      summary: mission.objective,
      constraints: ["Read-only local tools only", "No deploy, publish, purchase or credential action"],
      missingInformation: [],
      questions: []
    }
  });
  report.endpoints.push({ step: "understand", status: understood.status, code: understood.json?.code || null });
  if (!understood.ok) return { ...report, code: "understand_failed", error: understood.json?.error || understood.error || null };

  const planned = await call(fetchImpl, base, "POST", "/ax/command/objectives/" + encodeURIComponent(id) + "/plan", { token, body: plan });
  report.endpoints.push({ step: "plan", status: planned.status, code: planned.json?.code || null });
  if (!planned.ok) return { ...report, code: "plan_failed", error: planned.json?.error || planned.error || null };

  const tick = await call(fetchImpl, base, "POST", "/ax/command/scheduler/tick", { token, body: { trigger: "mission-19-live" } });
  report.tick = { status: tick.status, ok: tick.ok, code: tick.json?.code || null };
  report.endpoints.push({ step: "scheduler_tick", status: tick.status, code: tick.json?.code || null });

  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let objective = null;
  let polls = 0;
  while (Date.now() < deadline) {
    const read = await call(fetchImpl, base, "GET", "/ax/command/objectives/" + encodeURIComponent(id), { token });
    polls += 1;
    if (read.ok && read.json?.objective) {
      objective = read.json.objective;
      if (TERMINAL.has(objective.status)) break;
    } else if (read.status === 404) {
      return { ...report, code: "objective_missing_after_create", error: "The objective was not readable after it was created." };
    }
    await sleep(pollMs);
  }
  report.endpoints.push({ step: "read_objective", polls });

  if (!objective) {
    return { ...report, code: "objective_unreadable", error: "No objective body was returned before the timeout." };
  }
  report.objective = {
    id: objective.id,
    status: objective.status,
    evidence: Array.isArray(objective.evidence) ? objective.evidence.length : 0,
    verification: objective.verification ? { verified: objective.verification.verified === true, unmet: objective.verification.unmet || [] } : null,
    correlationId: objective.correlationId || null,
    updatedAt: objective.updatedAt || null
  };

  if (objective.status !== "completed") {
    return {
      ...report,
      code: "mission_not_completed",
      error: "The objective ended in status " + objective.status + "; a completed, verified result is required for live proof."
    };
  }
  if (objective.verification?.verified !== true) {
    return { ...report, code: "verification_not_passed", error: "The objective completed without independent verification." };
  }
  return { ...report, ok: true, code: "completed" };
}

/**
 * Read-only post-restart check. It proves the durable objective and its verification still exist;
 * it does not re-run the mission and does not write anything.
 */
export async function verifyStoredMission({ origin = DEFAULT_ORIGIN, token = null, objectiveId, fetchImpl = globalThis.fetch } = {}) {
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, "");
  const report = { schemaVersion: 1, mode: "post-restart", origin: base, ok: false, code: null, objectiveId: objectiveId || null };
  if (!token) return { ...report, code: "token_required", error: "HABITAT_AX_COMMAND_TOKEN is required." };
  if (!objectiveId) return { ...report, code: "objective_id_required", error: "Pass --objective <id>." };

  const read = await call(fetchImpl, base, "GET", "/ax/command/objectives/" + encodeURIComponent(objectiveId), { token });
  if (!read.ok || !read.json?.objective) {
    return { ...report, code: "objective_unreadable", status: read.status, error: read.json?.error || read.error || null };
  }
  const objective = read.json.objective;
  const evidence = Array.isArray(objective.evidence) ? objective.evidence : [];
  const verified = objective.verification?.verified === true;
  return {
    ...report,
    ok: objective.status === "completed" && verified,
    code: objective.status === "completed" && verified ? "persisted_verified_result" : "not_a_verified_result",
    status: objective.status,
    verified,
    evidence: evidence.length,
    evidenceIds: evidence.map(item => item.id).slice(0, 20),
    updatedAt: objective.updatedAt || null,
    verification: objective.verification || null
  };
}

export function checkConfiguration(env = process.env) {
  return {
    origin: env.HABITAT_BASE_URL || DEFAULT_ORIGIN,
    tokenConfigured: Boolean(env.HABITAT_AX_COMMAND_TOKEN),
    schedulerTokenConfigured: Boolean(env.AX_SCHEDULER_TOKEN),
    note: env.HABITAT_AX_COMMAND_TOKEN
      ? "ready: the Ax command token is present in the environment (value not shown)"
      : "blocked: HABITAT_AX_COMMAND_TOKEN is not set; no mission will be submitted"
  };
}

function parseArgs(argv) {
  const args = { origin: process.env.HABITAT_BASE_URL || DEFAULT_ORIGIN, json: "release/mission-19-live-result.json", objective: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--origin") args.origin = argv[++index];
    else if (item === "--json") args.json = argv[++index];
    else if (item === "--no-json") args.json = null;
    else if (item === "--objective") args.objective = argv[++index];
    else if (item === "--check") args.check = true;
  }
  args.token = process.env.HABITAT_AX_COMMAND_TOKEN || null;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    console.log(JSON.stringify(checkConfiguration(), null, 2));
    process.exitCode = process.env.HABITAT_AX_COMMAND_TOKEN ? 0 : 2;
    return;
  }
  const report = args.objective
    ? await verifyStoredMission({ origin: args.origin, token: args.token, objectiveId: args.objective })
    : await runLiveMission({ origin: args.origin, token: args.token });
  console.log(JSON.stringify(report, null, 2));
  if (args.json) {
    const target = path.resolve(args.json);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
    console.error("evidence: " + path.relative(process.cwd(), target));
  }
  process.exitCode = report.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === new URL("file://" + path.resolve(process.argv[1])).href) {
  await main();
}
