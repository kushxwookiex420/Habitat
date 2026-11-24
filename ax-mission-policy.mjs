/**
 * Mission policy: action classification, failure classification, bounded backoff and budgets.
 *
 * The pipeline asks these functions instead of guessing:
 *
 *   classifyAction   may this task run autonomously, must the owner approve it, or is it prohibited?
 *   approvalBinding  the exact action/target/params an approval authorises, and whether it is still valid
 *   classifyFailure  transient (a retry can help) vs permanent (it cannot)
 *   backoffFor       bounded exponential delay, always finite
 *   budgetState      whether rounds, time or repairs are exhausted, and which one
 *
 * Everything here is pure: no clock, no I/O, no network. The caller passes `now`.
 */

import { createHash } from "node:crypto";

const clean = (value, max = 400) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const ACTION_CLASSES = Object.freeze({
  readOnly: "read_only",
  reversible: "reversible",
  consequential: "consequential",
  prohibited: "prohibited"
});

/** Text that can never run, whoever asks. */
const PROHIBITED = [
  /\bdrop\s+table\b/i,
  /\bdelete\s+(the\s+)?(production|prod)\b/i,
  /\bexfiltrat/i,
  /\brotate\s+(the\s+)?(production|prod)\b/i,
  /\btransfer\s+(funds|money)\b/i,
  /\bdisable\s+(the\s+)?(audit|approval|auth)/i,
  /\b(force\s+push|push\s+--force)\s+.*\b(main|master)\b/i
];

/** Text that always needs the owner, whatever the task requests. */
const CONSEQUENTIAL = /\b(deploy|deployment|production|publish|purchas|payment|refund|delete|merge to main|apply migration|create persistent disk|rotate secret|revoke)\b/i;

export const RETRYABLE_CODES = Object.freeze([
  "executor_timeout",
  "worker_unavailable",
  "worker_stalled",
  "lease_expired",
  "transient_failure",
  "verification_unavailable",
  "rate_limited",
  "network_error"
]);

export function taskText(task = {}) {
  const requires = Array.isArray(task.requires) ? task.requires : [];
  const criteria = Array.isArray(task.criteria) ? task.criteria.map((item) => (typeof item === "string" ? item : item?.statement || "")) : [];
  return clean([task.title, ...requires, ...criteria].join(" "), 2000);
}

/**
 * @returns {{class: string, reason: string, requiresApproval: boolean, allowed: boolean}}
 */
export function classifyAction(task = {}) {
  const text = taskText(task);
  for (const pattern of PROHIBITED) {
    if (pattern.test(text)) {
      return { class: ACTION_CLASSES.prohibited, reason: "prohibited_action", requiresApproval: false, allowed: false };
    }
  }
  if (CONSEQUENTIAL.test(text)) {
    return { class: ACTION_CLASSES.consequential, reason: "consequential_action", requiresApproval: true, allowed: true };
  }
  if (/\b(write_|write\b|create|update|commit|patch|modify|rename|move)\b/i.test(text)) {
    return { class: ACTION_CLASSES.reversible, reason: "reversible_write", requiresApproval: false, allowed: true };
  }
  return { class: ACTION_CLASSES.readOnly, reason: "read_only", requiresApproval: false, allowed: true };
}

/**
 * Bind an approval to the exact action it authorises. Any change to the task id, action, target or params
 * produces a different fingerprint, so an approval for one action can never authorise another.
 */
export function approvalBinding({ missionId, taskId, action, target = null, params = null } = {}) {
  const canonical = JSON.stringify({
    missionId: clean(missionId, 120),
    taskId: clean(taskId, 120),
    action: clean(action, 200),
    target: clean(target, 400) || null,
    params: params && typeof params === "object" ? sortKeys(params) : null
  });
  return createFingerprint(canonical);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function createFingerprint(canonical) {
  return "ap:" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * @returns {{ok: boolean, code: string}}
 */
export function approvalValid(approval, { fingerprint, now = new Date().toISOString(), maxAgeMs = 30 * 60_000 } = {}) {
  if (!approval) return { ok: false, code: "approval_missing" };
  if (String(approval.decision || "").toLowerCase() !== "approved") return { ok: false, code: "approval_not_granted" };
  if (!approval.fingerprint) return { ok: false, code: "approval_unbound" };
  if (approval.fingerprint !== fingerprint) return { ok: false, code: "approval_action_changed" };
  const grantedAt = Date.parse(approval.grantedAt || "");
  if (!Number.isFinite(grantedAt)) return { ok: false, code: "approval_undated" };
  if (approval.expiresAt) {
    const expiresAt = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expiresAt)) return { ok: false, code: "approval_undated" };
    if (Date.parse(now) >= expiresAt) return { ok: false, code: "approval_expired" };
  } else if (Date.parse(now) - grantedAt > maxAgeMs) {
    return { ok: false, code: "approval_expired" };
  }
  if (grantedAt > Date.parse(now) + 60_000) return { ok: false, code: "approval_undated" };
  return { ok: true, code: "approval_valid" };
}

/**
 * A retry only helps for some failures. Permanent ones are recorded as permanent and never retried.
 * @returns {{kind: "transient"|"permanent", code: string, retryable: boolean}}
 */
export function classifyFailure(task = {}) {
  const code = clean(task.error, 120) || "unknown_failure";
  if (RETRYABLE_CODES.includes(code)) return { kind: "transient", code, retryable: true };
  if (code === "verification_failed") return { kind: "transient", code, retryable: true };
  if (["unroutable_task", "approval_required", "prohibited_action", "no_independent_verifier", "policy_denied"].includes(code)) {
    return { kind: "permanent", code, retryable: false };
  }
  if (task.status === "failed" && !code.startsWith("executor_")) return { kind: "permanent", code, retryable: false };
  return { kind: "transient", code, retryable: true };
}

/** Bounded exponential backoff: 1s, 2s, 4s … capped, with no jitter so tests are deterministic. */
export function backoffFor(attempt, { baseMs = 1000, capMs = 30_000 } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(capMs, baseMs * 2 ** Math.min(n, 20));
}

/**
 * @returns {{exhausted: boolean, reason: string|null, roundsLeft: number, elapsedMs: number}}
 */
export function budgetState({ startedAt, now = Date.now(), maxRounds = 3, roundsUsed = 0, maxRepairs = 1, repairsUsed = 0, maxDurationMs = 10 * 60_000 } = {}) {
  const elapsedMs = Math.max(0, Number(now) - (typeof startedAt === "number" ? startedAt : Date.parse(startedAt) || Number(now)));
  if (elapsedMs >= maxDurationMs) return { exhausted: true, reason: "budget_duration", roundsLeft: Math.max(0, maxRounds - roundsUsed), elapsedMs };
  if (roundsUsed >= maxRounds) return { exhausted: true, reason: "budget_rounds", roundsLeft: 0, elapsedMs };
  if (repairsUsed > maxRepairs) return { exhausted: true, reason: "budget_repairs", roundsLeft: Math.max(0, maxRounds - roundsUsed), elapsedMs };
  return { exhausted: false, reason: null, roundsLeft: Math.max(0, maxRounds - roundsUsed), elapsedMs };
}

/**
 * The execution gate. Called immediately before an executor would run, against the *persisted* mission and
 * task, never against the request that created them. It recomputes the action class and the approval
 * fingerprint, so changing a task's title, target or parameters after approval invalidates the approval.
 *
 * @returns {{ok: boolean, code: string, class: string, action?: string, target?: string|null, fingerprint?: string|null}}
 */
export function executionGate({ mission, task, now = new Date().toISOString(), maxAgeMs = 30 * 60_000 } = {}) {
  const policy = classifyAction(task);
  const action = clean(task?.action || task?.title, 200);
  const target = task?.target === undefined ? null : task.target;
  const params = task?.params === undefined ? null : task.params;
  const base = { class: policy.class, action, target };
  if (policy.class === ACTION_CLASSES.prohibited) {
    return { ok: false, code: "policy_denied", ...base, fingerprint: null };
  }
  if (!(task?.approvalRequired === true || policy.requiresApproval)) {
    return { ok: true, code: "approval_not_required", ...base, fingerprint: null };
  }
  if (!mission || !mission.id || !task?.id) return { ok: false, code: "approval_unbound", ...base, fingerprint: null };

  const fingerprint = approvalBinding({ missionId: mission.id, taskId: task.id, action, target, params });
  const candidates = (mission.approvals || []).filter((item) =>
    String(item.missionId ?? mission.id) === String(mission.id) && String(item.taskId ?? "") === String(task.id));
  if (candidates.length === 0) return { ok: false, code: "approval_missing", ...base, fingerprint };
  const approval = candidates.find((item) => item.fingerprint === fingerprint);
  if (!approval) return { ok: false, code: "approval_action_changed", ...base, fingerprint };
  if (approval.status === "pending") return { ok: false, code: "approval_pending", ...base, fingerprint };
  if (approval.status === "rejected" || approval.decision === "rejected") return { ok: false, code: "approval_rejected", ...base, fingerprint };
  if (approval.status === "revoked" || approval.decision === "revoked") return { ok: false, code: "approval_revoked", ...base, fingerprint };
  const verdict = approvalValid({ ...approval, decision: approval.decision || approval.status }, { fingerprint, now, maxAgeMs });
  return { ok: verdict.ok, code: verdict.code === "approval_valid" ? "approval_valid" : verdict.code, ...base, fingerprint, grantedAt: approval.grantedAt || null, decidedBy: approval.decidedBy || null };
}

/** A stable fingerprint of canonical parameters: key order cannot change it. */
export function paramsFingerprint(params) {
  return "pf:" + createHash("sha256").update(JSON.stringify(sortKeys(params ?? null))).digest("hex").slice(0, 32);
}

/**
 * The exact authorization an owner signature covers. Every field is significant: changing the mission,
 * approval, decision, action class, target, parameters, expiry or signer produces a different statement.
 */
export function approvalStatement({
  missionId, approvalId, taskId, decision, actionClass, action, target = null, parameters = null, expiresAt = null, owner = "owner"
} = {}) {
  return JSON.stringify({
    v: 1,
    missionId: clean(missionId, 120),
    approvalId: clean(approvalId, 200),
    taskId: clean(taskId, 120) || "mission",
    decision: clean(decision, 20),
    actionClass: clean(actionClass, 40),
    action: clean(action, 200),
    target: target === null || target === undefined ? null : clean(target, 300),
    parameters: parameters === null || parameters === undefined ? null : clean(parameters, 80),
    expiresAt: expiresAt === null || expiresAt === undefined ? null : clean(expiresAt, 40),
    owner: clean(owner, 64)
  });
}

/**
 * Build the fields an owner signs for one persisted approval. Approval time and execution time both call
 * this, so a record that was altered after signing no longer verifies.
 */
export function approvalSigningFields({ mission, approval, decision = "approve", owner = "owner" } = {}) {
  const task = approval?.taskId ? (mission?.tasks || []).find((item) => item.id === approval.taskId) || null : null;
  const policy = task ? classifyAction(task) : { class: "mission" };
  return {
    operation: "mission.approve",
    project: mission?.project || "",
    key: mission?.id || "",
    kind: decision,
    statement: approvalStatement({
      missionId: mission?.id || "",
      approvalId: approval?.id || "",
      taskId: approval?.taskId || "mission",
      decision,
      actionClass: policy.class,
      action: task ? clean(task.action || task.title, 200) : clean(approval?.action, 200),
      target: task ? (task.target ?? null) : null,
      parameters: task ? paramsFingerprint(task.params ?? null) : null,
      expiresAt: approval?.expiresAt || null,
      owner
    }),
    tags: [],
    confidence: null
  };
}
