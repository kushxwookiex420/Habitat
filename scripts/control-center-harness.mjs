import express from "express";
import { registerControlCenter } from "../control-center.mjs";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";
import { createSecurityEventService } from "../ax-security-events.mjs";
import { createMemorySecurityEventRepository } from "../ax-security-event-repository.mjs";
import { createSchedulerService } from "../ax-scheduler.mjs";
import { createMemorySchedulerRepository } from "../ax-scheduler-repository.mjs";
import { createIncidentService } from "../ax-recovery.mjs";
import { createMemoryIncidentRepository } from "../ax-incident-repository.mjs";
import { createProjectRegistry } from "../ax-projects.mjs";
import { createNotificationService } from "../ax-notifications.mjs";

/**
 * Local populated-backend harness for the control center.
 *
 * This is real HTTP, the real control-center page, the real command routes and the real service
 * objects. Only the storage is in-memory and the data is created by this harness. It is NOT D1, NOT
 * staging and NOT a production deployment; every screenshot taken from it must say so.
 */

const port = Number(process.env.PORT || 3000);
const token = String(process.env.HABITAT_AX_COMMAND_TOKEN || "").trim();
if (!token) {
  console.error("HABITAT_AX_COMMAND_TOKEN is required for the local control-center harness.");
  process.exit(2);
}

function memoryCommandStore() {
  const rows = new Map();
  return {
    async initialize() { return { ok: true }; },
    async create(task) { rows.set(task.id, task); return task; },
    async get(id) { return rows.get(String(id)) || null; },
    async update(id, task) { rows.set(String(id), task); return task; },
    async list({ status = null, limit = 50 } = {}) {
      return [...rows.values()].filter(task => (status ? task.status === status : true)).slice(0, limit);
    },
    async listChanged() { return []; },
    async healthCheck() { return { ok: true }; }
  };
}

function memoryNotificationRepository() {
  const rows = [];
  return {
    async create(notification) {
      if (rows.some(row => row.dedupeKey === notification.dedupeKey)) return { created: false, notification: rows.find(row => row.dedupeKey === notification.dedupeKey) };
      rows.push(notification);
      return { created: true, notification };
    },
    async list({ status = null, limit = 50 } = {}) {
      return rows.filter(row => (status ? row.status === status : true)).slice(0, limit);
    },
    async acknowledge({ id, by, now }) {
      const row = rows.find(item => item.id === id);
      if (!row) return { ok: false, code: "not_found" };
      row.status = "acknowledged";
      row.acknowledgedAt = now;
      row.acknowledgedBy = by;
      return { ok: true, notification: row };
    }
  };
}

const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository() });
const security = createSecurityEventService({ repository: createMemorySecurityEventRepository() });
const scheduler = createSchedulerService({ ticks: createMemorySchedulerRepository(), objectives });
const incidents = createIncidentService({ repository: createMemoryIncidentRepository() });
const notifications = createNotificationService({ repository: memoryNotificationRepository(), project: "habitat" });
const projects = createProjectRegistry({ objectives, memory: null });

const created = await objectives.create({
  objective: "Local populated backend: inspect a repository module and record evidence",
  criteria: ["A module was inspected", "The syntax check exited zero"],
  key: "control-harness-objective",
  budgetUsd: 0.05,
  project: "habitat"
});
const id = created.objective.id;
await objectives.understand(id, { summary: "Harness data for the populated control center." });
await objectives.plan(id, { steps: [{ objective: "inspect ax-objectives.mjs", agent: "engineering" }], risk: "low" });
await objectives.start(id);
await objectives.reserveExecution(id, { executionId: "run_harness", estimateUsd: 0.005, agentId: "engineering", provider: "none-local" });
const evidence = await objectives.addEvidence(id, {
  items: [{
    id: "ev_harness",
    summary: "inspected: ax-objectives.mjs sha256=" + "a".repeat(64),
    source: "repo.inspect",
    agent: "engineering"
  }]
});
await objectives.settleExecution(id, { executionId: "run_harness", runId: "run_harness", actualUsd: 0.004, note: "local harness, no provider" });
await objectives.transition(id, "verifying", { by: "ax", reason: "harness verification" });
await objectives.verify(id, {
  checks: [
    { criterionId: "c1", evidenceIds: [evidence.objective.evidence[0].id], passed: true },
    { criterionId: "c2", evidenceIds: [evidence.objective.evidence[0].id], passed: true }
  ]
});
await objectives.complete(id, { summary: "Harness objective completed with local evidence." });

await security.record({ category: "owner.authorization", severity: "info", outcome: "allowed", actor: "owner:harness-device", deviceId: "harness-device", objectiveId: id, summary: "Harness owner authorized a read-only inspection", evidence: "local harness identity; not a real phone" });
await security.record({ category: "auth.failure", severity: "medium", outcome: "denied", actor: "anonymous", summary: "Rejected command request with no valid credential", evidence: "authorization header present=false" });
await security.record({ category: "sensitive.action", severity: "info", outcome: "allowed", actor: "owner:harness-device", objectiveId: id, summary: "Harness recorded a read-only execution result" });
await notifications.record({ type: "objective.completed", severity: "info", title: "Harness objective completed", body: "Local control-center harness data.", dedupeKey: "harness:objective:" + id, ref: id });
await scheduler.tick({ trigger: "control-center-harness" });

const app = express();
app.use(express.json());
registerControlCenter(app);
registerUniversalCommandRoutes(app, {
  env: { HABITAT_AX_COMMAND_TOKEN: token },
  repository: memoryCommandStore(),
  registry: { get() { return null; }, approvalRequiredFor() { return { required: false, known: true }; }, summary() { return { ok: true, count: 0, tools: [] }; } },
  objectiveProvider: () => objectives,
  securityProvider: () => security,
  schedulerProvider: () => scheduler,
  projectProvider: () => projects,
  incidentProvider: () => incidents,
  notificationProvider: () => notifications,
  // The harness proves objective reads; it does not run the model orchestrator. The run store is
  // empty, so no synthetic run history is presented as real.
  orchestratorProvider: () => ({ enabled: true, listRuns: async () => [], getRun: async () => null })
});
app.listen(port, "0.0.0.0", () => {
  console.log("CONTROL_CENTER_HARNESS listening on " + port + " objective=" + id);
});
