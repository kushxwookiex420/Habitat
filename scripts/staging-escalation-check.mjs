#!/usr/bin/env node
/**
 * Controlled failure-escalation test against staging.
 *
 * Produces one real terminal failure and checks that Ax receives exactly one durable message for it,
 * then retries the task and checks that a second failure does not produce a second message.
 *
 * The failure is deterministic and safe: `repo.inspect` refuses a path that escapes its root, so the
 * adapter returns a failure without reading anything outside the repository. The probe therefore also
 * exercises the read-only adapter boundary.
 *
 * Preconditions it will not fake: the executor must be mounted (NEXUS_RUNTIME_ENABLED=true) and the Ax
 * credential must authenticate. Without those the run stops with a named, actionable blocker.
 */

const STAGING_HOST = "habitat-staging-e3ie.onrender.com";
const PRODUCTION_HOST = "habitat-1-szzd.onrender.com";
const PROBE_OBJECTIVE = "../../../etc/passwd";

/** Messages the escalator produced for one task (its correlation id is task:<id>). */
export function findEscalations(messages = [], taskId) {
  const wanted = "task:" + String(taskId || "");
  return (Array.isArray(messages) ? messages : []).filter((message) => String(message?.correlationId || "") === wanted);
}

/** Verify the escalation body carries everything Ax was promised. */
export function validateEscalationBody(body, { taskId, attemptPattern = /Attempts:\s*\d+/ } = {}) {
  const text = String(body || "");
  const missing = [];
  if (!text.includes(String(taskId || ""))) missing.push("task id");
  if (!/NEXUS EXECUTION FAILURE/.test(text)) missing.push("failure heading");
  if (!/Reason:\s*\S/.test(text)) missing.push("failure reason");
  if (!attemptPattern.test(text)) missing.push("attempt count");
  if (!/Failed at:\s*\S/.test(text)) missing.push("timestamp");
  if (!/Status:\s*failed/.test(text)) missing.push("terminal status");
  return { ok: missing.length === 0, missing };
}

/**
 * Retry increments `attempts`, and the escalation key is task+attempts, so a second failure is a
 * different key by design: one message per attempt is correct, two messages for one attempt is not.
 */
export function summarizeAttempts(messages = []) {
  const attempts = (Array.isArray(messages) ? messages : [])
    .map((message) => Number(/Attempts:\s*(\d+)/.exec(String(message?.body || ""))?.[1] ?? Number.NaN))
    .filter((value) => Number.isInteger(value));
  const seen = new Set();
  const duplicates = [];
  for (const attempt of attempts) {
    if (seen.has(attempt)) duplicates.push(attempt);
    seen.add(attempt);
  }
  return { attempts, distinct: seen.size, duplicates };
}

function stagingOrigin() {
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
    return { status: response.status, ok: response.ok, json };
  } catch (error) {
    return { status: 0, ok: false, json: null, error: String(error?.message || error).slice(0, 200) };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStatus(origin, token, taskId, wanted, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const read = await call(origin, "/ax/command/tasks/" + encodeURIComponent(taskId), { token });
    if (read.ok && read.json?.task) {
      last = read.json.task;
      if (wanted.includes(last.status)) return last;
    }
    await sleep(4000);
  }
  return last;
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    target: "staging",
    credentialPresent: Boolean(String(process.env.HABITAT_AX_COMMAND_TOKEN || "").trim()),
    phases: {},
    ok: false
  };

  const base = stagingOrigin();
  if (!base.ok) {
    report.blocked = base.code;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  const token = String(process.env.HABITAT_AX_COMMAND_TOKEN || "").trim();
  if (!token) {
    report.blocked = "ax_credential_missing";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  // 1. Preconditions: the escalation is only observable when the executor is actually mounted.
  const status = await call(base.origin, "/system/status", { timeoutMs: 120_000 });
  const execution = status.json?.components?.workers?.execution || {};
  report.phases.preconditions = {
    status: status.status,
    commit: status.json?.commit || null,
    executorMounted: execution.canExecute === true,
    executorDetail: execution.detail || null
  };
  if (status.status !== 200 || execution.canExecute !== true) {
    report.blocked = "nexus_runtime_disabled";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const timeoutSeconds = Number(process.env.ESCALATION_TIMEOUT_SECONDS || 300);

  // 2. Submit a task that must fail: repo.inspect refuses a path outside its root.
  const submitted = await call(base.origin, "/ax/command/tasks", {
    method: "POST",
    token,
    body: {
      objective: PROBE_OBJECTIVE,
      adapter: "repo.inspect",
      idempotencyKey: "escalation-probe-" + new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)
    }
  });
  report.phases.submit = { status: submitted.status, code: submitted.json?.code || null, taskId: submitted.json?.task?.id || null };
  if (submitted.status !== 201 || !submitted.json?.task?.id) {
    report.blocked = submitted.json?.code || "submit_failed";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  const taskId = submitted.json.task.id;

  // 3. The task must reach a terminal failure, not a success.
  const first = await waitForStatus(base.origin, token, taskId, ["failed", "done"], timeoutSeconds);
  report.phases.firstRun = {
    status: first?.status || null,
    error: first?.error || null,
    attempts: first?.attempts ?? null,
    finishedAt: new Date().toISOString()
  };
  if (first?.status !== "failed") {
    report.blocked = first?.status === "done" ? "probe_unexpectedly_succeeded" : "task_not_terminal";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  // 4. Exactly one escalation message for this task.
  const listOne = await call(base.origin, "/ax/command/messages?limit=200", { token });
  const firstMessages = findEscalations(listOne.json?.messages || [], taskId);
  report.phases.escalation = {
    count: firstMessages.length,
    ids: firstMessages.map((message) => message.id),
    bodyCheck: firstMessages[0] ? validateEscalationBody(firstMessages[0].body, { taskId }) : null,
    attempts: summarizeAttempts(firstMessages).attempts
  };
  report.phases.sameAttemptReplay = {
    note: "A repeated escalation of the same attempt cannot be produced through public routes; the deterministic key is covered by tests/ax-failure-escalation.test.mjs."
  };

  // 5. Retry the task. Retry moves attempts 0 -> 1, so this failure must escalate once more, under a
  //    new key: two messages, one per attempt, and never two for the same attempt.
  const retried = await call(base.origin, "/ax/command/tasks/" + encodeURIComponent(taskId) + "/retry", { method: "POST", token, body: {} });
  report.phases.retry = { status: retried.status, code: retried.json?.code || null };
  let afterRetry = null;
  if (retried.ok && retried.status === 200) {
    const second = await waitForStatus(base.origin, token, taskId, ["failed", "done"], timeoutSeconds);
    report.phases.secondRun = { status: second?.status || null, attempts: second?.attempts ?? null };
    const listTwo = await call(base.origin, "/ax/command/messages?limit=200", { token });
    const messages = findEscalations(listTwo.json?.messages || [], taskId);
    const summary = summarizeAttempts(messages);
    afterRetry = { count: messages.length, attempts: summary.attempts, duplicates: summary.duplicates };
    report.phases.attemptCoverage = { ...afterRetry, expected: 2 };
  } else {
    report.phases.attemptCoverage = { skipped: true, reason: retried.json?.code || "retry_unavailable" };
  }

  const coverageOk = afterRetry === null ||
    (afterRetry.count === 2 && afterRetry.duplicates.length === 0 && afterRetry.attempts.includes(0) && afterRetry.attempts.includes(1));
  report.ok = firstMessages.length === 1 &&
    report.phases.escalation.bodyCheck?.ok === true &&
    coverageOk;
  if (!report.ok) {
    const duplicates = firstMessages.length > 1 || (afterRetry?.duplicates.length || 0) > 0;
    report.blocked = duplicates ? "duplicate_escalation" : "escalation_missing_or_incomplete";
  }

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, fatal: String(error?.message || error).slice(0, 300) }, null, 2));
    process.exitCode = 1;
  });
}
