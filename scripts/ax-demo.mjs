import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { createSecurityEventService } from "../ax-security-events.mjs";
import { createMemorySecurityEventRepository } from "../ax-security-event-repository.mjs";
import { createMemoryIncidentRepository } from "../ax-incident-repository.mjs";
import { createIncidentService } from "../ax-recovery.mjs";
import { createAgentRuntime } from "../ax-agents.mjs";
import { createRepositoryEngineeringTransport } from "../ax-agent-transports.mjs";
import { createAxMemoryContext } from "../ax-memory-context.mjs";
import { createNotificationService } from "../ax-notifications.mjs";

/**
 * Mission 11 end-to-end demonstration.
 *
 * This is a real local execution, not a mocked success: the engineering agent reads a repository
 * file and runs `node --check` plus a real unit suite through an allowlisted spawn (no shell). The
 * model provider is NOT called, so the cost is zero and the report says so. Owner identity is
 * simulated locally to exercise the approval gate; nothing leaves the machine.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function memoryRepository(seed = []) {
  const rows = new Map(seed.map(entry => [entry.key, entry]));
  return {
    async put(entry) {
      rows.set(entry.key, entry);
      return { ok: true, entry };
    },
    async list({ limit = 50 } = {}) {
      return [...rows.values()].slice(0, limit);
    },
    async search({ query = "", limit = 50 } = {}) {
      const text = String(query).toLowerCase();
      return [...rows.values()].filter(entry => String(entry.statement || "").toLowerCase().includes(text)).slice(0, limit);
    },
    async stats() {
      return { active: rows.size, deleted: 0, byKind: {} };
    },
    async get({ key } = {}) {
      return rows.get(key) || null;
    },
    snapshot() {
      return [...rows.values()];
    }
  };
}

function notificationRepository() {
  const rows = [];
  return {
    async create(notification) {
      if (rows.some(item => item.dedupeKey === notification.dedupeKey)) {
        return { created: false, notification: rows.find(item => item.dedupeKey === notification.dedupeKey) };
      }
      rows.push(notification);
      return { created: true, notification };
    },
    async list({ status = null, limit = 50 } = {}) {
      return rows.filter(item => (status ? item.status === status : true)).slice(0, limit);
    },
    snapshot() {
      return rows.slice();
    }
  };
}

export async function runDemo() {
  const checks = [];
  const check = (name, condition, detail = null) => {
    checks.push({ name, ok: Boolean(condition), detail });
    if (!condition) throw new Error("demo check failed: " + name);
  };

  const memory = memoryRepository([
    {
      id: "mem_owner_1",
      project: "habitat",
      key: "decision:mission-11",
      kind: "decision",
      statement: "Mission 11 verifies Habitat accounting, audit, scheduler and real agent execution before release.",
      status: "active",
      confidence: 0.95,
      version: 1,
      provenance: { source: "owner", observedAt: "2026-11-22T00:00:00.000Z" }
    }
  ]);
  const memoryContext = createAxMemoryContext({ repository: memory, project: "habitat" });
  const objectiveRepository = createMemoryObjectiveRepository();
  const objectives = createObjectiveService({ repository: objectiveRepository });
  const securityRepository = createMemorySecurityEventRepository();
  const security = createSecurityEventService({ repository: securityRepository });
  const incidents = createIncidentService({ repository: createMemoryIncidentRepository() });
  const notifications = createNotificationService({ repository: notificationRepository(), project: "habitat" });

  const recalled = await memoryContext.recall({ objective: "inspect a Habitat module and record a verified result" });
  check("approved memory retrieved", recalled.ok === true && recalled.entries.length === 1);

  const created = await objectives.create({
    objective: "Inspect a Habitat module, identify a testable issue and record a verified technical report",
    criteria: [
      { id: "c1", statement: "The target module was inspected and its digest recorded" },
      { id: "c2", statement: "The module syntax check exited zero" },
      { id: "c3", statement: "The focused unit suite exited zero" }
    ],
    key: "mission-11-demo",
    project: "habitat",
    budgetUsd: 0.02
  });
  check("durable objective created", created.ok === true);
  const id = created.objective.id;
  const understood = await objectives.understand(id, {
    summary: "Read ax-objectives.mjs, run its syntax check and the objective unit suite, then record evidence.",
    constraints: ["read-only", "no model call", "no deployment"],
    missingInformation: []
  });
  check("objective understood", understood.ok === true);
  const planned = await objectives.plan(id, {
    steps: [{
      objective: "Inspect ax-objectives.mjs and run node --check plus the objective test suite",
      agent: "engineering",
      adapter: "repo.inspect",
      requiresApproval: true
    }],
    provider: "none-local",
    estimatedCostUsd: 0,
    risk: "low",
    permissions: ["repo.read", "sandbox.exec"]
  });
  check("bounded plan recorded and approval required", planned.ok === true && planned.objective.approval.required === true);
  const approvalRequested = await objectives.requestApproval(id, { reason: "engineering execution requires owner sign-off" });
  check("approval requested", approvalRequested.ok === true);
  const authorized = await objectives.authorize(id, { approvalId: "owner-approval:demo-device", by: "owner:demo-device" });
  check("owner authorization recorded", authorized.ok === true);
  await security.record({
    category: "owner.authorization",
    severity: "info",
    outcome: "allowed",
    actor: "owner:demo-device",
    deviceId: "demo-device",
    objectiveId: id,
    summary: "Demo owner device authorized an engineering objective",
    evidence: "local demo identity; no real phone was used"
  });
  const started = await objectives.start(id);
  check("objective started with reservation possible", started.ok === true);

  const reservation = await objectives.reserveExecution(id, {
    executionId: "demo-run",
    runKey: "demo-run",
    estimateUsd: 0.005,
    agentId: "engineering",
    provider: "none-local"
  });
  check("budget reserved before execution", reservation.ok === true && reservation.accounting.reservedUsd === 0.005);

  const engineering = createRepositoryEngineeringTransport({
    root: ROOT,
    inspectPaths: ["ax-objectives.mjs"],
    checks: [
      { name: "syntax", command: process.execPath, args: ["--check", "{file}"], when: "file" },
      { name: "objective-tests", command: process.execPath, args: ["--test", "tests/ax-objectives.test.mjs"] }
    ]
  });
  const agents = createAgentRuntime({
    dependencies: { engineering, memory: memoryContext },
    onSecurityEvent: entry => security.record({
      category: "agent.permission_violation",
      severity: "high",
      outcome: "denied",
      actor: "agent:" + (entry?.agent || "unknown"),
      objectiveId: id,
      summary: entry?.summary || "Agent result rejected"
    })
  });
  const delegation = await agents.delegateAndReview({
    objective: "Inspect ax-objectives.mjs and run the objective unit suite",
    role: "engineering"
  });
  check("engineering agent produced reviewable evidence", delegation.review.accepted === true);
  check("real file digest present", delegation.envelope.evidence.some(item => /sha256/.test(item.summary)));
  check("real checks exited zero", delegation.envelope.evidence.filter(item => /exit 0/.test(item.summary)).length >= 2);

  const evidence = await objectives.addEvidence(id, {
    items: delegation.envelope.evidence.map(item => ({
      id: item.id,
      summary: item.summary,
      source: item.source,
      agent: "engineering",
      digest: item.digest
    }))
  });
  check("evidence attached to the objective", evidence.ok === true);
  const evidenceIds = evidence.objective.evidence.map(item => item.id);
  const fileEvidence = evidence.objective.evidence.find(item => /inspected/.test(item.summary));
  const commandEvidence = evidence.objective.evidence.filter(item => /exit 0/.test(item.summary));
  check("evidence ids resolve", Boolean(fileEvidence) && commandEvidence.length >= 2 && evidenceIds.length === delegation.envelope.evidence.length);

  const settled = await objectives.settleExecution(id, {
    executionId: "demo-run",
    runId: "run_demo_local",
    actualUsd: 0,
    note: "local engineering adapter; no model provider called"
  });
  check("reservation settled at zero cost", settled.ok === true && settled.accounting.spentUsd === 0 && settled.accounting.reservedUsd === 0);

  const movedToVerify = await objectives.transition(id, "verifying", { by: "ax", reason: "evidence verification" });
  check("objective moved to verifying", movedToVerify.ok === true);
  const verification = await objectives.verify(id, {
    checks: [
      { criterionId: "c1", evidenceIds: [fileEvidence.id], passed: true, detail: "file digest recorded" },
      { criterionId: "c2", evidenceIds: [commandEvidence[0].id], passed: true, detail: "syntax check exit 0" },
      { criterionId: "c3", evidenceIds: [commandEvidence[1].id], passed: true, detail: "unit suite exit 0" }
    ]
  });
  check("evidence independently checked", verification.ok === true && verification.verified === true);
  const completed = await objectives.complete(id, { summary: "Local engineering inspection completed with real digests and exit codes." });
  check("objective completed only after verification", completed.ok === true);

  await memoryContext.remember({
    objective: "Inspect a Habitat module and record a verified result",
    runId: "run_demo_local",
    evidence: evidence.objective.evidence
  });
  const remembered = await memory.get({ key: "run:run_demo_local" });
  check("verified outcome written to memory", Boolean(remembered));

  const notification = await notifications.record({
    type: "objective.completed",
    severity: "info",
    title: "Demo objective verified",
    body: "The engineering agent inspected a real module and its checks exited zero.",
    dedupeKey: "demo:mission-11:completed",
    ref: id
  });
  check("notification recorded", notification.ok === true);

  const audit = await security.integrity();
  check("security audit chain verified", audit.ok === true && audit.checked >= 1);

  // Restart: rebuild the service from the persisted records, then prove the same state is read.
  const persisted = JSON.parse(JSON.stringify(await readAll(objectiveRepository)));
  const restartedRepository = createMemoryObjectiveRepository({ records: persisted });
  const restarted = createObjectiveService({ repository: restartedRepository });
  const restored = await restarted.get(id);
  check("restart reconstructs the same objective", restored?.status === "completed" && restored.evidence.length === evidenceIds.length);
  check("restart preserves accounting", restored.accounting.executions[0].status === "settled" && restored.accounting.spentUsd === 0);

  // Interrupted work must be recoverable without duplicating its history.
  const second = await objectives.create({
    objective: "Interrupt and recover a local inspection",
    criteria: ["The objective resumes without losing evidence"],
    key: "mission-11-recovery",
    project: "habitat"
  });
  await objectives.understand(second.objective.id, { summary: "Interrupt after planning." });
  await objectives.plan(second.objective.id, { steps: [{ objective: "inspect", agent: "engineering" }] });
  await objectives.start(second.objective.id);
  const interrupted = await objectives.interrupt(second.objective.id, { reason: "simulated process stop" });
  check("objective interrupted", interrupted.ok === true && interrupted.objective.status === "interrupted");
  const recovered = await objectives.recover(second.objective.id, { reason: "demo restart recovery" });
  check("interrupted objective recovered", recovered.ok === true && recovered.objective.status === "executing" && recovered.objective.recovered === 1);

  const final = await objectives.get(id);
  const summary = {
    ok: checks.every(item => item.ok),
    generatedAt: new Date().toISOString(),
    environment: "local, isolated; node:sqlite is not involved; no provider or D1 call",
    objective: {
      id,
      status: final.status,
      verified: final.verification.verified,
      criteria: final.criteria.map(item => ({ id: item.id, met: item.met })),
      evidenceCount: final.evidence.length,
      accounting: final.accounting,
      costUsd: final.costUsd
    },
    engineering: {
      filesInspected: delegation.envelope.evidence.filter(item => /inspected/.test(item.summary)).length,
      checks: delegation.envelope.evidence.filter(item => /exit 0/.test(item.summary)).map(item => item.summary)
    },
    memory: { recalled: recalled.entries.length, writtenKey: "run:run_demo_local" },
    notification: { recorded: notification.ok, type: "objective.completed" },
    security: { events: audit.checked, chainVerified: audit.ok, headHash: audit.headHash },
    restart: { status: restored.status, accountingPreserved: true },
    recovery: { interrupted: true, recovered: recovered.objective.recovered },
    simulated: ["owner device identity", "no model/provider call", "no durable D1 store; memory repositories"],
    checks
  };
  await mkdir(path.join(ROOT, "release"), { recursive: true });
  await writeFile(path.join(ROOT, "release", "demo-evidence.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  return summary;
}

async function readAll(repository) {
  return repository.list({ limit: 100 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await runDemo();
  console.log(JSON.stringify({
    ok: summary.ok,
    objective: { id: summary.objective.id, status: summary.objective.status, spentUsd: summary.objective.accounting.spentUsd },
    checks: summary.checks.length,
    passed: summary.checks.filter(item => item.ok).length,
    evidence: "release/demo-evidence.json"
  }, null, 2));
  if (!summary.ok) process.exitCode = 1;
}
