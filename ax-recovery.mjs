import { createHash } from "node:crypto";

/**
 * Self-monitoring and safe self-recovery.
 *
 * The monitor reports what it actually observed from injected probes and never derives a problem
 * from configuration alone. Findings become durable incidents, deduplicated by fingerprint.
 *
 * Recovery is deliberately narrow. Only reversible, non-destructive actions are in the allowlist:
 * re-reading a run, re-probing a subsystem, starting an already-configured scheduler, asking a phone
 * to check in, or notifying the owner. There is no path here to deploy, migrate, delete a row, change
 * a permission or reset a credential, and a caller cannot add one at request time.
 */

export const INCIDENT_SEVERITIES = Object.freeze(["info", "warning", "high", "critical"]);
export const INCIDENT_STATUSES = Object.freeze(["open", "resolved", "suppressed"]);

/** The only repairs this service will ever run. Each is reversible or read-only. */
export const SAFE_RECOVERY_ACTIONS = Object.freeze([
  "reconcile_run",
  "probe_subsystems",
  "start_scheduler",
  "request_device_checkin",
  "notify_owner",
  "reload_incidents"
]);

const DESTRUCTIVE = /deploy|migrat|drop|delete|truncate|revoke|rotate|grant|permission|secret|reset|restart_process/i;

export const MONITOR_THRESHOLDS = Object.freeze({
  queueAgeSeconds: 600,
  stuckTaskMs: 15 * 60 * 1000,
  deviceOfflineMs: 45 * 60 * 1000,
  pendingNotificationMs: 10 * 60 * 1000,
  runOverdueMs: 15 * 60 * 1000
});

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function redact(value) {
  return clean(value, 400)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
}

export function incidentFingerprint(kind, subject) {
  return clean(kind, 60) + ":" + clean(subject, 160);
}

function incidentId(fingerprint) {
  return "inc_" + createHash("sha256").update("incident:" + fingerprint, "utf8").digest("hex").slice(0, 24);
}

export function createIncidentService({
  repository = null,
  now = () => new Date().toISOString(),
  log = console,
  maxRecords = 200
} = {}) {
  const tokens = new Map();

  async function record({ kind, severity = "warning", subject = "global", title, detail = null, recommendation = null, safeAction = null, observedAt = null } = {}) {
    if (!repository) return { ok: false, code: "incidents_not_configured" };
    const incidentKind = clean(kind, 60);
    if (!incidentKind) return { ok: false, code: "incident_kind_required" };
    const level = INCIDENT_SEVERITIES.includes(severity) ? severity : "warning";
    const fingerprint = incidentFingerprint(incidentKind, subject);
    let existing = null;
    try {
      existing = await repository.getByFingerprint(fingerprint);
    } catch (error) {
      log.error?.("AX_INCIDENT_READ_FAILED", redact(error?.message || error));
      return { ok: false, code: "incident_store_unavailable" };
    }
    const at = now();
    if (existing?.incident && existing.incident.status === "open") {
      const incident = existing.incident;
      incident.occurrences = Number(incident.occurrences || 1) + 1;
      incident.lastObservedAt = observedAt || at;
      incident.updatedAt = at;
      incident.severity = level;
      if (detail) incident.detail = redact(detail);
      try {
        const outcome = await repository.update(incident, existing.recordJson);
        if (!outcome.ok) return { ok: false, code: "incident_conflict", incident: outcome.incident };
        tokens.set(incident.id, outcome.recordJson);
        return { ok: true, created: false, incident };
      } catch (error) {
        log.error?.("AX_INCIDENT_UPDATE_FAILED", redact(error?.message || error));
        return { ok: false, code: "incident_store_unavailable" };
      }
    }
    const incident = {
      id: incidentId(fingerprint),
      fingerprint,
      kind: incidentKind,
      severity: level,
      status: "open",
      subject: clean(subject, 160),
      title: clean(title, 200) || incidentKind,
      detail: detail ? redact(detail) : null,
      recommendation: recommendation ? clean(recommendation, 300) : null,
      safeAction: safeAction && SAFE_RECOVERY_ACTIONS.includes(safeAction) ? safeAction : null,
      occurrences: 1,
      firstObservedAt: observedAt || at,
      lastObservedAt: observedAt || at,
      createdAt: at,
      updatedAt: at,
      recovery: null
    };
    try {
      const created = await repository.create(incident);
      const stored = created.incident || incident;
      tokens.set(stored.id, created.recordJson);
      return { ok: true, created: created.created === true, incident: stored };
    } catch (error) {
      log.error?.("AX_INCIDENT_CREATE_FAILED", redact(error?.message || error));
      return { ok: false, code: "incident_store_unavailable" };
    }
  }

  async function list({ status = "open", limit = 50 } = {}) {
    if (!repository) return { ok: false, code: "incidents_not_configured", incidents: [] };
    try {
      const incidents = await repository.list({ status, limit: Math.min(maxRecords, limit) });
      return { ok: true, count: incidents.length, incidents };
    } catch (error) {
      log.error?.("AX_INCIDENT_LIST_FAILED", redact(error?.message || error));
      return { ok: false, code: "incident_store_unavailable", incidents: [] };
    }
  }

  async function get(id) {
    if (!repository) return null;
    try {
      const record = await repository.getRecord(String(id || ""));
      if (!record?.incident) return null;
      tokens.set(record.incident.id, record.recordJson);
      return record.incident;
    } catch {
      return null;
    }
  }

  /** Resolve with the evidence that justified it. An unverified resolution is recorded as such. */
  async function resolve({ id, by = "system", verification = null } = {}) {
    if (!repository) return { ok: false, code: "incidents_not_configured" };
    const record = await repository.getRecord(String(id || ""));
    if (!record?.incident) return { ok: false, code: "not_found" };
    const incident = record.incident;
    incident.status = "resolved";
    incident.updatedAt = now();
    incident.resolvedAt = incident.updatedAt;
    incident.resolvedBy = clean(by, 120) || "system";
    incident.recovery = {
      ...(incident.recovery || {}),
      verified: verification?.verified === true,
      verification: {
        verified: verification?.verified === true,
        detail: verification?.detail ? redact(verification.detail) : null
      },
      resolvedAt: incident.resolvedAt
    };
    try {
      const outcome = await repository.update(incident, record.recordJson);
      if (!outcome.ok) return { ok: false, code: "incident_conflict", incident: outcome.incident };
      tokens.set(incident.id, outcome.recordJson);
      return { ok: true, incident };
    } catch (error) {
      log.error?.("AX_INCIDENT_RESOLVE_FAILED", redact(error?.message || error));
      return { ok: false, code: "incident_store_unavailable" };
    }
  }

  /**
   * Persist the recovery attempt itself. A failed repair must still leave an audit trail saying what
   * was tried, why and whether the effect could be verified.
   */
  async function noteRecovery({ id, recovery } = {}) {
    if (!repository) return { ok: false, code: "incidents_not_configured" };
    const record = await repository.getRecord(String(id || ""));
    if (!record?.incident) return { ok: false, code: "not_found" };
    const incident = record.incident;
    incident.recovery = recovery || null;
    incident.updatedAt = now();
    try {
      const outcome = await repository.update(incident, record.recordJson);
      if (!outcome.ok) return { ok: false, code: "incident_conflict", incident: outcome.incident };
      tokens.set(incident.id, outcome.recordJson);
      return { ok: true, incident };
    } catch (error) {
      log.error?.("AX_INCIDENT_NOTE_FAILED", redact(error?.message || error));
      return { ok: false, code: "incident_store_unavailable" };
    }
  }

  return Object.freeze({ record, list, get, resolve, noteRecovery });
}

/**
 * Read-only monitor. Every probe is optional: an absent probe produces no finding rather than a
 * fabricated one, and a probe that throws becomes an explicit `monitor.unavailable` finding.
 */
export function createOperationalMonitor({
  engine = null,
  orchestrator = null,
  presence = null,
  deviceBridge = null,
  devices = null,
  notifications = null,
  thresholds = {},
  now = () => new Date().toISOString(),
  clock = () => Date.now()
} = {}) {
  const limits = { ...MONITOR_THRESHOLDS, ...thresholds };

  async function safe(label, fn) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, label, error: clean(error?.message, 160) };
    }
  }

  async function scan() {
    const findings = [];
    const add = (kind, severity, subject, title, detail, recommendation, safeAction) =>
      findings.push({ kind, severity, subject, title, detail, recommendation, safeAction, observedAt: now() });

    const presenceResult = typeof presence === "function" ? await safe("presence", presence) : { ok: false, label: "presence", error: "not_configured" };
    const report = presenceResult.ok ? presenceResult.value : null;
    if (!presenceResult.ok) {
      if (presenceResult.error !== "not_configured") add("scheduler.unavailable", "high", "presence", "Scheduler presence probe failed", presenceResult.error, "Check the NEXUS runtime mount and D1 connectivity.", "probe_subsystems");
    } else if (report) {
      if (!report.executor?.configured) {
        add("scheduler.not_mounted", "warning", "executor", "NEXUS executor is not mounted", report.executor?.reason || "executor_not_mounted", "Set NEXUS_RUNTIME_ENABLED=true and configure D1 when execution is intended.", "probe_subsystems");
      } else if (!report.executor?.started) {
        add("scheduler.stopped", "high", "executor", "NEXUS executor is mounted but not started", report.executor?.state || "not_started", "Start the worker; queued tasks cannot progress without it.", "start_scheduler");
      }
      const queue = report.queue;
      if (queue && queue.ok === false) {
        add("queue.unavailable", "high", "queue", "Task queue could not be read", queue.error || "queue_unavailable", "Check D1 connectivity before assuming the queue is empty.", "probe_subsystems");
      } else if (queue) {
        const oldest = Number(queue.oldestQueuedAgeSeconds);
        if (Number.isFinite(oldest) && oldest > limits.queueAgeSeconds) {
          add("queue.age_exceeded", "high", "queue", "Tasks have waited too long in the queue", "Oldest queued task is " + Math.round(oldest) + "s old (limit " + limits.queueAgeSeconds + "s).", "Confirm the worker is alive and claiming; do not delete the tasks.", "probe_subsystems");
        }
        const live = Number(report.heartbeat?.liveWorkers || 0);
        if (live === 0 && Number(queue.queued || 0) > 0) {
          add("workers.none_live", "high", "workers", "Queued work with no live worker", Number(queue.queued) + " task(s) queued and 0 live workers.", "Start or recover a worker before blaming the tasks.", "start_scheduler");
        }
      }
    }

    if (engine && typeof engine.list === "function") {
      const listed = await safe("engine.list", () => engine.list({ status: "working", limit: 50 }));
      if (!listed.ok) {
        add("tasks.unreadable", "high", "engine", "Tasks could not be listed", listed.error, "Check the task store before any recovery action.", "probe_subsystems");
      } else {
        const tasks = listed.value?.tasks || [];
        const stuck = tasks.filter(task => {
          const age = clock() - Date.parse(task.updatedAt || task.createdAt || 0);
          return Number.isFinite(age) && age > limits.stuckTaskMs;
        });
        for (const task of stuck.slice(0, 5)) {
          add("task.stuck", "high", "task:" + task.id, "Task appears stuck in working", "No update for " + Math.round((clock() - Date.parse(task.updatedAt || task.createdAt || 0)) / 1000) + "s; lease may be expired.", "Release the expired lease through the worker path; never close a task by hand without evidence.", "reconcile_run");
        }
      }
    }

    if (orchestrator && typeof orchestrator.listRuns === "function") {
      const runs = await safe("orchestrator.listRuns", () => orchestrator.listRuns({ limit: 20 }));
      if (runs.ok) {
        for (const run of runs.value || []) {
          if (run?.status === "failed" && !run.settled) {
            add("run.failed_unsettled", "warning", "run:" + run.id, "Mission failed without settling", clean(run.error, 200) || "unsettled failure", "Re-read the run to reconcile it from its task rows.", "reconcile_run");
          }
          if (run && !run.settled && run.deadlineAt && clock() > Date.parse(run.deadlineAt) + limits.runOverdueMs) {
            add("run.overdue", "warning", "run:" + run.id, "Mission is past its deadline and still open", "Deadline " + run.deadlineAt + ".", "Reconcile the run; its tasks may still settle.", "reconcile_run");
          }
        }
      }
    }

    if (typeof devices === "function") {
      const rows = await safe("devices", devices);
      if (rows.ok) {
        const active = (rows.value || []).filter(row => !row.revoked_at && !row.revokedAt);
        const newest = active.map(row => Date.parse(row.last_seen_at || row.lastSeenAt || 0)).filter(Number.isFinite).sort((a, b) => b - a)[0] || 0;
        if (active.length === 0) {
          add("device.none_paired", "warning", "device", "No phone is paired", "The device bridge has no active registration.", "Create a pairing code from the control center.", "request_device_checkin");
        } else if (newest && clock() - newest > limits.deviceOfflineMs) {
          add("device.offline", "warning", "device", "Paired phone has not checked in", "Last check-in " + Math.round((clock() - newest) / 1000) + "s ago.", "Ask the phone to poll; re-pair only if its credential was revoked.", "request_device_checkin");
        }
      }
    } else if (deviceBridge && typeof deviceBridge === "object" && deviceBridge.ready === false) {
      add("device.bridge_unavailable", "warning", "device", "Device bridge is not ready", deviceBridge.durable === false ? "Durable D1 storage is unavailable." : "The bridge has not initialized.", "Fix storage before pairing; a pairing code cannot be issued without it.", "probe_subsystems");
    }

    if (notifications && typeof notifications.list === "function") {
      const pending = await safe("notifications.list", () => notifications.list({ status: "pending", limit: 50 }));
      if (pending.ok) {
        const stale = (pending.value?.notifications || []).filter(item => {
          const age = clock() - Date.parse(item.createdAt || 0);
          return Number.isFinite(age) && age > limits.pendingNotificationMs;
        });
        if (stale.length) {
          add("notifications.pending_stale", "warning", "notifications", "Notifications are pending too long", stale.length + " record(s) have no delivery.", "Either configure a transport or acknowledge that inbox-only is the intended channel.", "notify_owner");
        }
      }
    }

    const bySeverity = findings.reduce((counts, item) => {
      counts[item.severity] = (counts[item.severity] || 0) + 1;
      return counts;
    }, {});
    return {
      ok: true,
      observedAt: now(),
      findings,
      summary: {
        total: findings.length,
        critical: bySeverity.critical || 0,
        high: bySeverity.high || 0,
        warning: bySeverity.warning || 0,
        info: bySeverity.info || 0
      },
      probes: {
        presence: presenceResult.ok ? "ok" : presenceResult.error,
        engine: engine ? "checked" : "not_configured",
        orchestrator: orchestrator ? "checked" : "not_configured",
        devices: typeof devices === "function" ? "checked" : "not_configured",
        notifications: notifications ? "checked" : "not_configured"
      }
    };
  }

  return Object.freeze({ scan, thresholds: Object.freeze({ ...limits }) });
}

/**
 * Turns findings into incidents and runs only allowlisted repairs. A repair must be supplied by the
 * caller (so it is visible and testable) and must be one of SAFE_RECOVERY_ACTIONS.
 */
export function createRecoveryService({
  monitor,
  incidents,
  repairs = {},
  now = () => new Date().toISOString(),
  log = console
} = {}) {
  if (!monitor || typeof monitor.scan !== "function") throw new Error("The recovery service needs a monitor.");
  if (!incidents) throw new Error("The recovery service needs an incident store.");

  async function scanAndRecord() {
    const report = await monitor.scan();
    const recorded = [];
    for (const finding of report.findings) {
      const outcome = await incidents.record(finding);
      if (outcome.ok) recorded.push({ finding, incidentId: outcome.incident.id, created: outcome.created });
    }
    return { ...report, recorded };
  }

  async function recover(id, { action = null, by = "owner" } = {}) {
    const incident = await incidents.get(id);
    if (!incident) return { ok: false, code: "not_found" };
    if (incident.status !== "open") return { ok: false, code: "incident_closed", status: incident.status };
    const chosen = action || incident.safeAction;
    if (!chosen) return { ok: false, code: "no_safe_action", error: "This incident has no reversible repair; it requires an owner decision." };
    if (DESTRUCTIVE.test(chosen) || !SAFE_RECOVERY_ACTIONS.includes(chosen)) {
      return { ok: false, code: "unsafe_recovery_refused", action: clean(chosen, 80), allowed: SAFE_RECOVERY_ACTIONS.slice() };
    }
    const repair = repairs[chosen];
    if (typeof repair !== "function") {
      return { ok: false, code: "repair_not_registered", action: chosen, note: "No implementation is mounted for this safe action." };
    }
    let result;
    try {
      result = await repair({ incident, action: chosen });
    } catch (error) {
      result = { ok: false, detail: clean(error?.message, 200) };
    }
    const verification = {
      verified: result?.verified === true,
      detail: result?.detail ? redact(result.detail) : result?.ok ? "repair reported success" : "repair did not report success"
    };
    incident.recovery = {
      action: chosen,
      what: incident.title,
      why: incident.detail || incident.title || incident.kind,
      by: clean(by, 120) || "owner",
      attemptedAt: now(),
      result: result?.ok === true ? "ok" : "failed",
      verification
    };
    // Persist the attempt before any resolution, so the record of what was tried, why and whether it
    // verified survives independently of the outcome.
    let stored = { incident };
    try {
      stored = await incidents.noteRecovery({ id: incident.id, recovery: incident.recovery });
    } catch (error) {
      log.error?.("AX_RECOVERY_RECORD_FAILED", redact(error?.message || error));
    }
    if (result?.ok === true && verification.verified) {
      return incidents.resolve({ id: incident.id, by, verification });
    }
    // A repair that ran but could not verify its effect stays open, with its attempt recorded.
    return { ok: false, code: "recovery_unverified", incident: stored.incident || incident, verification };
  }

  return Object.freeze({ scanAndRecord, recover, scan: () => monitor.scan(), allowedActions: SAFE_RECOVERY_ACTIONS.slice() });
}
