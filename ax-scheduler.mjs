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
  // How far ahead an approval counts as "expiring soon" for the owner warning.
  approvalExpirySoonMs: 60 * 60_000,
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
  runs = null,
  notifications = null,
  // Mission 14: one bounded autonomy pass per tick. It is a callback, not a second scheduler: the
  // lease above still decides who runs, and the callback owns its own idempotency.
  autonomy = null,
  // Mission P1 follow-up: approval-expiry monitoring for the capability network. A callback on this
  // tick, not a second scheduler: the same lease decides who runs.
  approvalExpiry = null,
  approvalExpirySoonMs = SCHEDULER_LIMITS.approvalExpirySoonMs,
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

  /**
   * Turn the capability network's expiry report into findings. The ledger persists its own expiry
   * transitions; this function only reports, and a failure here is reported rather than failing the
   * whole tick, because the rest of the maintenance pass is still useful.
   */
  async function approvalExpiryFindings() {
    if (typeof approvalExpiry !== "function") return { findings: [], report: null };
    let report;
    try {
      report = await approvalExpiry({ withinMs: approvalExpirySoonMs });
    } catch (error) {
      log.error?.("AX_SCHEDULER_APPROVAL_MONITOR_FAILED", clean(error?.message, 160));
      return {
        findings: [{
          kind: "approval.monitor_failed",
          severity: "warning",
          subject: "approval-ledger",
          title: "Approval expiry monitor did not run",
          detail: "The approval ledger could not be read, so expiries were not checked this tick.",
          recommendation: "Inspect the approval store. An expired request is still refused when it is decided or consumed.",
          safeAction: "notify_owner"
        }],
        report: { ok: false, code: "approval_monitor_failed" }
      };
    }
    if (!report || report.ok === false) {
      return {
        findings: [{
          kind: "approval.monitor_failed",
          severity: "warning",
          subject: "approval-ledger",
          title: "Approval expiry monitor reported a problem",
          detail: clean(report?.code || "approval_monitor_unavailable", 160),
          recommendation: "Inspect the approval store; this tick changed no approval.",
          safeAction: "notify_owner"
        }],
        report: { ok: false, code: report?.code || "approval_monitor_unavailable" }
      };
    }
    const findings = [];
    const expired = Array.isArray(report.expired) ? report.expired : [];
    const soon = Array.isArray(report.expiringSoon) ? report.expiringSoon : [];
    const failed = Array.isArray(report.failed) ? report.failed : [];
    for (const item of expired.slice(0, 10)) {
      findings.push({
        kind: "approval.expired",
        severity: "high",
        subject: "approval:" + item.id,
        title: "Approval expired without a decision",
        detail: "A " + clean(item.kind || "request", 40) + " request for " + clean(item.vendor || "an unnamed vendor", 80) +
          " (" + Number(item.amountCents || 0) + " " + clean(item.currency || "", 3) + ") expired at " + clean(item.expiresAt || "an unknown time", 40) + ".",
        recommendation: "Re-request with a fresh quote if the action is still wanted; an expired approval can never be consumed.",
        safeAction: "notify_owner"
      });
    }
    for (const item of soon.slice(0, 10)) {
      const remaining = Math.max(0, Date.parse(String(item.expiresAt || "")) - nowMs());
      findings.push({
        kind: "approval.expiring",
        severity: "warning",
        subject: "approval:" + item.id,
        title: "Approval expires soon",
        detail: "A " + clean(item.kind || "request", 40) + " request for " + clean(item.vendor || "an unnamed vendor", 80) +
          " expires in about " + Math.max(0, Math.round(remaining / 60_000)) + " minute(s).",
        recommendation: "Decide it from the paired owner device, or let it expire.",
        safeAction: "notify_owner"
      });
    }
    if (failed.length) {
      findings.push({
        kind: "approval.sweep_incomplete",
        severity: "warning",
        subject: "approval-ledger",
        title: "Some approvals could not be marked expired",
        detail: String(failed.length) + " request(s) changed while the sweep was running: " + failed.slice(0, 5).join(", "),
        recommendation: "They were not modified. The next tick retries the sweep.",
        safeAction: "notify_owner"
      });
    }
    return {
      findings,
      report: {
        ok: true,
        expired: expired.length,
        expiringSoon: soon.length,
        failed: failed.length,
        withinMs: Number(report.withinMs) || approvalExpirySoonMs
      }
    };
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
      // Crash reconciliation: a process can die after reserving budget but before binding a run.
      // Only provably dead reservations are released; an unbound reservation is stale, a bound one
      // is released only when the run store confirms it does not exist.
      let reconciled = 0;
      if (objectives && typeof objectives.reconcileReservations === "function") {
        let rows = [];
        try { rows = await objectives.list({ limit: SCHEDULER_LIMITS.maxObjectives }); } catch { rows = []; }
        const activeStatuses = ["executing", "verifying", "interrupted", "recovery_required"];
        const runExists = runs && typeof runs.getRun === "function"
          ? async runId => Boolean(await runs.getRun(runId))
          : null;
        for (const row of rows.filter(item => activeStatuses.includes(item.status)).slice(0, 50)) {
          try {
            const outcome = await objectives.reconcileReservations(row.id, { staleMs: stuckObjectiveMs, runExists });
            if (outcome?.ok && Array.isArray(outcome.released) && outcome.released.length) {
              reconciled += outcome.released.length;
              findings.push({
                kind: "accounting.reservation_released",
                severity: "warning",
                subject: "objective:" + row.id,
                title: "Released stale budget reservation(s)",
                detail: "Released " + outcome.released.join(", ") + " after no live run was found.",
                recommendation: "No charge was made; the reservation history remains visible.",
                safeAction: "reconcile_run",
                objectiveId: row.id
              });
            }
          } catch (error) {
            log.error?.("AX_SCHEDULER_RECONCILE_FAILED", clean(error?.message, 160));
          }
        }
      }
      // Autonomous execution rides the same lease as recovery: at most one tick can advance queued
      // messages or eligible objectives at a time. A failure here is reported, never retried
      // blindly, and never changes a message to completed.
      let autonomyResult = null;
      if (typeof autonomy === "function") {
        try {
          autonomyResult = await autonomy();
          if (autonomyResult && autonomyResult.ok === false) {
            findings.push({
              kind: "autonomy.unavailable",
              severity: "warning",
              subject: "autonomy",
              title: "Autonomous execution did not run",
              detail: String(autonomyResult.code || autonomyResult.reason || "unknown"),
              recommendation: "Inspect the message channel and the run store; nothing was completed.",
              safeAction: null
            });
          }
          const deadLettered = Number(autonomyResult?.messages?.deadLettered || 0);
          if (deadLettered > 0) {
            findings.push({
              kind: "autonomy.dead_letter",
              severity: "high",
              subject: "messages",
              title: deadLettered + " message(s) dead-lettered",
              detail: "The retry limit was reached; an owner decision is required.",
              recommendation: "Read the message thread and requeue only with the owner.",
              safeAction: null
            });
          }
        } catch (error) {
          log.error?.("AX_SCHEDULER_AUTONOMY_FAILED", clean(error?.message, 160));
          autonomyResult = { ok: false, code: "autonomy_failed" };
          findings.push({
            kind: "autonomy.failed",
            severity: "high",
            subject: "autonomy",
            title: "Autonomous pass failed",
            detail: clean(error?.message, 200),
            safeAction: null
          });
        }
      }
      findings.push(...await stuckObjectives());
      findings.push(...await expiredApprovals());
      const approvalMonitor = await approvalExpiryFindings();
      findings.push(...approvalMonitor.findings);
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
        reconciledReservations: reconciled,
        approvals: approvalMonitor.report,
        autonomy: autonomyResult,
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
    limits: Object.freeze({ leaseMs, tickIntervalMs, stuckObjectiveMs, approvalTtlMs, approvalExpirySoonMs })
  });
}
