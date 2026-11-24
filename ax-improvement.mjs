/**
 * Continuous improvement derived from verified operational signals.
 *
 * The rule this module exists to enforce: an improvement is only reported if a signal in the running
 * system produced it. Nothing here estimates revenue, invents a capability, or upgrades a warning
 * into a failure. Every finding carries the evidence that produced it, and a finding whose evidence
 * is empty is discarded rather than shown.
 *
 * Priority is a heuristic (`severity weight / effort`), explicitly not a monetary value: the cost of
 * an improvement is unknown until it is planned, so pretending to know it would be the same class of
 * error as inventing revenue.
 */

export const SEVERITY_WEIGHTS = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });

/** Finding kinds this engine knows how to derive. Anything else is ignored, never guessed at. */
export const FINDING_KINDS = Object.freeze([
  "execution_blocked",
  "durability_gap",
  "capability_unavailable",
  "configuration_missing",
  "approval_expired",
  "check_failed",
  "device_silent",
  "task_stale"
]);

const DEFAULT_STALE_TASK_MS = 30 * 60_000;
const MAX_EVIDENCE = 6;

/** How an engine severity is reported by the scheduler, which has its own vocabulary. */
export const SCHEDULER_SEVERITY = Object.freeze({ critical: "critical", high: "high", medium: "warning", low: "warning" });

function text(value, limit = 200) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function digest(value) {
  let hash = 2166136261;
  const input = String(value);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function finding({ kind, subject, severity, title, detail, evidence, effortHours = 1 }) {
  if (!FINDING_KINDS.includes(kind)) return null;
  if (!SEVERITY_WEIGHTS[severity]) return null;
  const cleanEvidence = (Array.isArray(evidence) ? evidence : [])
    .map(item => text(item))
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE);
  if (cleanEvidence.length === 0) return null;
  return {
    id: "imp:" + kind + ":" + digest(subject),
    kind,
    subject: text(subject, 120),
    severity,
    title: text(title, 160),
    detail: text(detail, 600),
    evidence: cleanEvidence,
    effortHours: Number.isFinite(effortHours) && effortHours > 0 ? effortHours : 1,
    derivedAt: null
  };
}

/**
 * Turn observed state into findings. Every branch reads one field of a real report; a field that is
 * absent produces nothing, so a partial report cannot manufacture work.
 */
export function collectFindings({ systemStatus = null, approvals = null, tasks = null, checks = null, now = Date.now(), staleTaskMs = DEFAULT_STALE_TASK_MS } = {}) {
  const observedAt = new Date(now).toISOString();
  const found = [];
  const ignored = [];

  const components = systemStatus?.components || null;
  if (components) {
    const workers = components.workers || {};
    const execution = workers.execution || null;
    if (execution && execution.configured !== true) {
      found.push(finding({
        kind: "execution_blocked",
        subject: "nexus-executor",
        severity: "critical",
        title: "No executor is mounted, so queued work cannot run",
        detail: text(execution.detail) || "The execution report says the runtime is not configured.",
        evidence: ["execution.configured=" + String(execution.configured), "execution.state=" + text(execution.state || "unknown")]
      }));
    }

    for (const item of Array.isArray(workers.items) ? workers.items : []) {
      if (!item || item.state !== "unavailable") continue;
      found.push(finding({
        kind: "capability_unavailable",
        subject: item.id || "unknown-worker",
        severity: "high",
        title: "A registered worker is unavailable",
        detail: text(item.detail) || "The registry marks this worker unavailable, so its capability cannot be claimed.",
        evidence: ["worker " + text(item.id) + " state=unavailable", "configured=" + String(item.configured)]
      }));
    }

    const storage = components.storage || null;
    if (storage) {
      const broken = Object.entries(storage).filter(([, ready]) => ready !== true).map(([key]) => key);
      if (broken.length > 0) {
        found.push(finding({
          kind: "durability_gap",
          subject: broken.join(","),
          severity: "critical",
          title: "A durable store is not ready, so state may not survive a restart",
          detail: "The status report names these stores as not ready: " + broken.join(", ") + ".",
          evidence: broken.map(key => "storage." + key + "=false")
        }));
      }
    }

    const device = components.device || null;
    if (device && Number(device.paired || 0) > 0 && device.recentlySeen !== true) {
      found.push(finding({
        kind: "device_silent",
        subject: "paired-devices",
        severity: "medium",
        title: "Paired devices have not checked in recently",
        detail: (Number(device.paired) || 0) + " device(s) are paired but none is recently seen.",
        evidence: ["device.paired=" + Number(device.paired), "device.recentlySeen=false", device.lastSeenAt ? "last check-in " + text(device.lastSeenAt) : "no check-in recorded"],
        effortHours: 2
      }));
    }

    const missing = systemStatus?.requiredConfiguration?.missing;
    if (Array.isArray(missing) && missing.length > 0) {
      found.push(finding({
        kind: "configuration_missing",
        subject: missing.join(","),
        severity: "high",
        title: "Required configuration is missing",
        detail: "These documented keys are absent: " + missing.join(", ") + ". Names only; no value is read.",
        evidence: missing.slice(0, MAX_EVIDENCE).map(key => "missing " + text(key))
      }));
    }
  }

  if (Array.isArray(approvals)) {
    const expired = approvals.filter(item => item && (item.state === "expired" || (item.expiresAt && Date.parse(item.expiresAt) <= now && item.state === "pending")));
    if (expired.length > 0) {
      found.push(finding({
        kind: "approval_expired",
        subject: "approvals",
        severity: "high",
        title: "Approvals expired without a decision",
        detail: expired.length + " approval(s) passed their expiry while pending. Nothing was executed for them.",
        evidence: expired.slice(0, MAX_EVIDENCE).map(item => "approval " + text(item.id || "?") + " " + text(item.state || "pending") + (item.expiresAt ? " expires " + text(item.expiresAt) : ""))
      }));
    }
  }

  if (Array.isArray(tasks)) {
    const stale = tasks.filter(item => {
      if (!item || item.status !== "queued") return false;
      const at = Date.parse(item.updatedAt || item.createdAt || "");
      return Number.isFinite(at) && now - at > staleTaskMs;
    });
    if (stale.length > 0) {
      found.push(finding({
        kind: "task_stale",
        subject: "queued-tasks",
        severity: "medium",
        title: "Queued tasks are older than the claim window",
        detail: stale.length + " queued task(s) have not been claimed within " + Math.round(staleTaskMs / 60_000) + " minutes.",
        evidence: stale.slice(0, MAX_EVIDENCE).map(item => "task " + text(item.id || "?") + " queued since " + text(item.updatedAt || item.createdAt)),
        effortHours: 3
      }));
    }
  }

  if (Array.isArray(checks)) {
    for (const check of checks) {
      if (!check || check.ok !== false) continue;
      found.push(finding({
        kind: "check_failed",
        subject: check.name || "unnamed-check",
        severity: "high",
        title: "A verification check failed: " + text(check.name || "unnamed"),
        detail: text(check.detail) || "The check reported failure without a detail.",
        evidence: ["check " + text(check.name || "unnamed") + " ok=false"]
      }));
    }
  }

  if (!systemStatus && !Array.isArray(approvals) && !Array.isArray(tasks) && !Array.isArray(checks)) {
    ignored.push({ code: "no_signals_supplied" });
  }

  // Deduplicate by deterministic id, keeping the first (the order above is severity-descending by
  // construction), so a repeated signal cannot inflate the backlog.
  const byId = new Map();
  for (const item of found) {
    if (!byId.has(item.id)) byId.set(item.id, { ...item, derivedAt: observedAt });
  }

  const findings = Array.from(byId.values()).sort((left, right) => {
    const delta = SEVERITY_WEIGHTS[right.severity] - SEVERITY_WEIGHTS[left.severity];
    return delta !== 0 ? delta : left.id.localeCompare(right.id);
  });

  return {
    ok: true,
    observedAt,
    findings,
    counts: {
      total: findings.length,
      critical: findings.filter(item => item.severity === "critical").length,
      high: findings.filter(item => item.severity === "high").length,
      medium: findings.filter(item => item.severity === "medium").length,
      low: findings.filter(item => item.severity === "low").length
    },
    ignored,
    note: "Findings are derived only from the signals supplied. An empty list means the observed signals were clean, not that the system is perfect."
  };
}

/**
 * Rank findings for work. `severity / effort` is a triage heuristic and is labelled as such: it is not
 * a revenue estimate and must not be presented as one.
 */
export function rankImprovements({ findings = [], maxItems = 10 } = {}) {
  const ranked = (Array.isArray(findings) ? findings : [])
    .filter(item => item && SEVERITY_WEIGHTS[item.severity] && Array.isArray(item.evidence) && item.evidence.length > 0)
    .map(item => ({
      ...item,
      score: Math.round((SEVERITY_WEIGHTS[item.severity] / (item.effortHours || 1)) * 100) / 100
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  const limit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : 10;
  return {
    ok: true,
    ranked,
    next: ranked.slice(0, limit),
    method: "severity weight divided by effort hours; a triage order, not a monetary valuation",
    note: ranked.length === 0
      ? "No evidenced finding to rank. Nothing is invented to fill the list."
      : ranked.length + " evidenced finding(s), highest triage score first."
  };
}

/** One call for a status-driven improvement pass: derive, then rank. */
export function improvementPass(input = {}) {
  const collected = collectFindings(input);
  return { ...collected, ...rankImprovements({ findings: collected.findings, maxItems: input.maxItems }) };
}

/**
 * A monitor the scheduler can call once per tick.
 *
 * `readSignals` must return the same input `improvementPass` accepts (`systemStatus`, `approvals`,
 * `tasks`, `checks`). A monitor with no signal source is refused rather than returning an empty list
 * that would look like a clean system.
 *
 * Only findings that have not already been reported are returned, so a persistent condition does not
 * page on every tick. The memory is process-local and bounded: after a restart a still-present
 * condition is reported once more, which is stated here instead of being hidden behind "durable".
 */
export function createImprovementMonitor({ readSignals, now = () => Date.now(), staleTaskMs, maxNew = 5, remember = 500 } = {}) {
  if (typeof readSignals !== "function") {
    throw new Error("The improvement monitor needs a signal source; it will not invent one.");
  }
  const reported = new Set();
  return Object.freeze({
    async check() {
      const signals = await readSignals();
      const pass = improvementPass({
        ...(signals || {}),
        now: now(),
        ...(staleTaskMs ? { staleTaskMs } : {}),
        maxItems: maxNew
      });
      const fresh = [];
      let suppressed = 0;
      for (const finding of pass.findings) {
        if (reported.has(finding.id)) { suppressed += 1; continue; }
        reported.add(finding.id);
        fresh.push({ ...finding, schedulerSeverity: SCHEDULER_SEVERITY[finding.severity] || "warning" });
      }
      while (reported.size > remember) reported.delete(reported.values().next().value);
      return {
        findings: fresh,
        report: {
          ok: true,
          reported: fresh.length,
          suppressed,
          active: pass.counts,
          processLocalMemory: true
        },
        ranked: pass.next
      };
    },
    /** Test and operator hook: forget what was reported, so the next check reports everything again. */
    reset() {
      reported.clear();
    }
  });
}
