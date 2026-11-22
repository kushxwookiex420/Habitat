/**
 * Trigger-agnostic scheduler contract.
 *
 * The point is that recovery does not depend on an HTTP request arriving at the moment something
 * breaks. Render Cron, GitHub Actions, a hosted scheduler or an operator can call `tick()`; the
 * durable lease decides who runs, and every invocation is observable.
 *
 * A tick is bounded and read-mostly: it runs the recovery scan, detects stuck objectives, expired
 * approvals and missed ticks, records the outcome and releases its lease. It never deploys, migrates,
 * deletes data or changes permissions. Recovery repairs remain the recovery service's allowlisted
 * actions.
 */

export const SCHEDULER_LIMITS = Object.freeze({
  leaseMs: 90_000,
  tickIntervalMs: 60_000,
  stuckObjectiveMs: 15 * 60_000,
  approvalTtlMs: 24 * 60 * 60_000,
  maxObjectives: 200,
  maxFindings: 40
});

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function createSchedulerService({
  ticks,
  recovery = null,
  objectives = null,
  notifications = null,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  leaseMs = SCHEDULER_LIMITS.leaseMs,
  tickIntervalMs = SCHEDULER_LIMITS.tickIntervalMs,
  stuckObjectiveMs = SCHEDULER_LIMITS.stuckObjectiveMs,
  approvalTtlMs = SCHEDULER_LIMITS.approvalTtlMs,
  log = console
} = {}) {
  if (!ticks) throw new Error("The scheduler needs a durable tick repository.");

  function unavailable() {
    return { ok: false, code: "scheduler_not_configured", error: "The scheduler is not mounted on this service." };
  }

  async function stuckObjectives() {
    if (!objectives) return [];
    const list = await objectives.list({ limit: SCHEDULER_LIMITS.maxObjectives });
    const at = nowMs();
    return list
      .filter(item => ["executing", "verifying", "interrupted", "recovery_required"].includes(item.status))
      .filter(item => {
        const age = at - Date.parse(item.updatedAt || item.createdAt || 0);
        return Number.isFinite(age) && age > stuckObjectiveMs;
      })
      .slice(0, 10)
      .map(item => ({
        kind: "objective.stuck",
        severity: "high",
        subject: "objective:" + item.id,
        title: "Objective has not advanced",
        detail: "Status " + item.status + " with no update for " + Math.round((at - Date.parse(item.updatedAt || item.createdAt || 0)) / 1000) + "s.",
        recommendation: "Inspect its linked run and task rows; recover only reversible work.",
        safeAction: "reconcile_run",
        objectiveId: item.id
      }));
  }

  async function expiredApprovals() {
    if (!objectives) return [];
    const list = await objectives.list({ status: "awaiting_approval", limit: SCHEDULER_LIMITS.maxObjectives });
    const at = nowMs();
    return list
      .filter(item => item.approval?.requestedAt && at - Date.parse(item.approval.requestedAt) > approvalTtlMs)
      .slice(0, 10)
      .map(item => ({
        kind: "approval.expired",
        severity: "warning",
        subject: "objective:" + item.id,
        title: "Approval request expired",
        detail: "Requested " + item.approval.requestedAt + " and never answered.",
        recommendation: "Ask the owner to approve, deny or cancel; do not auto-approve.",
        safeAction: "notify_owner",
        objectiveId: item.id
      }));
  }

  async function tick({ trigger = "manual" } = {}) {
    const tickId = "tick_" + Math.random().toString(36).slice(2, 12);
    const startedAtMs = nowMs();
    const acquired = await ticks.acquire({
      tickId,
      owner: clean(trigger, 80) || "manual",
      ttlMs: leaseMs,
      nowMs: startedAtMs
    });
    if (!acquired.ok) {
      return { ok: false, code: acquired.code || "tick_overlap", error: "Another scheduler tick holds the lease.", lease: acquired.lease || null, tickId };
    }
    const findings = [];
    let recoveryResult = null;
    try {
      if (recovery) {
        recoveryResult = await recovery.scanAndRecord();
        const incidents = Array.isArray(recoveryResult?.recorded) ? recoveryResult.recorded : [];
        for (const incident of incidents.slice(0, SCHEDULER_LIMITS.maxFindings)) {
          findings.push({
            kind: incident.kind,
            severity: incident.severity,
            subject: incident.subject,
            title: incident.title,
            detail: incident.detail || null,
            safeAction: incident.safeAction || null,
            source: "recovery"
          });
        }
      }
      findings.push(...await stuckObjectives());
      findings.push(...await expiredApprovals());
      const high = findings.filter(item => ["high", "critical"].includes(item.severity));
      const deadLetters = findings.filter(item => !item.safeAction);
      let notification = null;
      if (notifications && high.length) {
        try {
          notification = await notifications.notify({
            type: "scheduler.tick",
            severity: high.length ? "high" : "warning",
            title: "Scheduler detected " + findings.length + " finding(s)",
            body: high.slice(0, 5).map(item => item.title).join("; ") || "Review the recovery tab.",
            dedupeKey: "scheduler:" + new Date(startedAtMs).toISOString().slice(0, 13)
          });
        } catch (error) {
          log.error?.("AX_SCHEDULER_NOTIFY_FAILED", clean(error?.message, 160));
        }
      }
      const status = high.length ? "degraded" : "ok";
      const detail = findings.length ? findings.length + " finding(s), " + high.length + " high" : "no findings";
      await ticks.complete({ tickId, status, detail, nowIso: now() });
      return {
        ok: true,
        tickId,
        trigger: clean(trigger, 80) || "manual",
        status,
        detail,
        findings: findings.slice(0, SCHEDULER_LIMITS.maxFindings),
        deadLetters,
        recovery: recoveryResult ? {
          recorded: Array.isArray(recoveryResult.recorded) ? recoveryResult.recorded.length : 0,
          summary: recoveryResult.report?.summary || null
        } : null,
        notification,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: now(),
        durationMs: Math.max(0, nowMs() - startedAtMs)
      };
    } catch (error) {
      log.error?.("AX_SCHEDULER_TICK_FAILED", clean(error?.message, 200));
      try {
        await ticks.fail({ tickId, error: clean(error?.message, 200) || "tick failed", nowIso: now() });
      } catch (recordError) {
        log.error?.("AX_SCHEDULER_FAIL_RECORD_FAILED", clean(recordError?.message, 160));
      }
      return { ok: false, code: "tick_failed", tickId, error: "The scheduler tick failed before it could finish.", findings };
    }
  }

  async function status() {
    const state = await ticks.status();
    const at = nowMs();
    const lastSuccessMs = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : null;
    const lastStartMs = state.lastStartAt ? Date.parse(state.lastStartAt) : null;
    const missedTicks = lastStartMs === null || !Number.isFinite(lastStartMs)
      ? null
      : Math.max(0, Math.floor((at - lastStartMs) / tickIntervalMs) - 1);
    const leaseActive = Boolean(state.lease && Date.parse(state.lease.expiresAt) > at);
    const healthy = Boolean(
      state.lastStatus !== "failed" &&
      lastSuccessMs !== null &&
      at - lastSuccessMs <= tickIntervalMs * 2.5 &&
      !(state.lease && !leaseActive)
    );
    const statusValue = !state.lastSuccessAt && !state.lease ? "never_run"
      : state.lastStatus === "failed" ? "failed"
        : missedTicks !== null && missedTicks > 1 ? "degraded"
          : healthy ? "healthy" : "stale";
    return {
      ok: true,
      scheduler: {
        ...state,
        leaseActive,
        missedTicks,
        healthy,
        status: statusValue,
        nextExpectedAt: lastSuccessMs !== null ? new Date(lastSuccessMs + tickIntervalMs).toISOString() : null,
        tickIntervalMs,
        leaseMs,
        stuckObjectiveMs,
        approvalTtlMs
      }
    };
  }

  async function heartbeat({ tickId, progress = null } = {}) {
    if (!tickId) return { ok: false, code: "tick_id_required" };
    return ticks.heartbeat({ tickId, ttlMs: leaseMs, nowMs: nowMs(), progress });
  }

  return Object.freeze({
    tick,
    status,
    heartbeat,
    limits: Object.freeze({ leaseMs, tickIntervalMs, stuckObjectiveMs, approvalTtlMs })
  });
}
