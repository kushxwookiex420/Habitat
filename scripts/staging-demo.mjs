import { pathToFileURL } from "node:url";
import path from "node:path";
import { createD1AxObjectiveRepository } from "../ax-objective-repository.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createD1AxSecurityEventRepository } from "../ax-security-event-repository.mjs";
import { createSecurityEventService } from "../ax-security-events.mjs";
import { createD1AxNotificationRepository } from "../d1-ax-notification-repository.mjs";
import { createNotificationService } from "../ax-notifications.mjs";
import { createRepositoryEngineeringTransport } from "../ax-agent-transports.mjs";

/**
 * Staging-only end-to-end harness.
 *
 * It is deliberately refused unless the operator supplies an isolated D1 database and explicitly
 * authorizes writes. It never touches production: nothing here can tell a staging database from a
 * production one, so the guard is an explicit `STAGING_ALLOW_WRITES=true` plus a database id the
 * owner chose. A run is split into `write` and `verify` phases so a second process proves durable
 * reconstruction; the local demo's simulated owner is not reused.
 */

const REQUIRED = [
  "CLOUDFLARE_ACCOUNT_ID",
  "HABITAT_D1_DATABASE_ID",
  "HABITAT_D1_API_TOKEN",
  "STAGING_ALLOW_WRITES",
  "STAGING_OBJECTIVE_KEY",
  "STAGING_OWNER_APPROVAL_ID"
];

const OWNER_ACTION = "Create a disposable staging D1 database and set its three credentials plus STAGING_ALLOW_WRITES=true, STAGING_OBJECTIVE_KEY and STAGING_OWNER_APPROVAL_ID in the staging environment only. Approve the objective through the real owner route before running phase=write.";

export async function runStagingDemo({ env = process.env, fetchImpl = fetch, phase = "write", rootDir = process.cwd() } = {}) {
  const missing = REQUIRED.filter(name => !String(env[name] || "").trim());
  if (missing.length) {
    return {
      ok: false,
      code: "staging_not_configured",
      missing,
      ownerAction: OWNER_ACTION,
      note: "No staging request was made. Production is not accessed by this harness."
    };
  }
  if (String(env.STAGING_ALLOW_WRITES).trim().toLowerCase() !== "true") {
    return { ok: false, code: "staging_writes_not_authorized", ownerAction: "Set STAGING_ALLOW_WRITES=true only for the disposable staging environment." };
  }

  const credentials = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.HABITAT_D1_DATABASE_ID,
    apiToken: env.HABITAT_D1_API_TOKEN,
    fetchImpl
  };
  const objectiveRepository = createD1AxObjectiveRepository(credentials);
  const securityRepository = createD1AxSecurityEventRepository(credentials);
  const notificationRepository = createD1AxNotificationRepository(credentials);
  const objectives = createObjectiveService({ repository: objectiveRepository });
  const security = createSecurityEventService({ repository: securityRepository });
  const notifications = createNotificationService({ repository: notificationRepository, project: "habitat" });

  if (phase === "verify") {
    const id = String(env.STAGING_OBJECTIVE_ID || "").trim();
    if (!id) return { ok: false, code: "staging_objective_id_required", ownerAction: "Pass the objective id printed by phase=write as STAGING_OBJECTIVE_ID." };
    const objective = await objectives.get(id);
    if (!objective) return { ok: false, code: "staging_objective_not_found" };
    const accounting = objectives.accountingOf(objective);
    const integrity = await security.integrity();
    return {
      ok: objective.status === "completed" && objective.verification?.verified === true && accounting.reservedUsd === 0 && integrity.ok === true,
      phase,
      objective: { id, status: objective.status, verified: objective.verification?.verified === true, evidence: objective.evidence?.length || 0 },
      accounting,
      security: { integrity: integrity.ok, checked: integrity.checked, headHash: integrity.headHash },
      note: "Read from D1 by a separate process; no local state is reused."
    };
  }

  await objectiveRepository.initialize();
  await securityRepository.initialize();
  await notificationRepository.initialize?.();
  const created = await objectives.create({
    objective: "Staging: inspect a repository module, record evidence and reconcile cost",
    criteria: ["A real module was inspected with a digest", "An allowlisted syntax check exited zero", "The objective completed after verification"],
    key: String(env.STAGING_OBJECTIVE_KEY),
    budgetUsd: Number(env.STAGING_BUDGET_USD || 0.01),
    project: "habitat"
  });
  if (!created.ok) return { ok: false, code: created.code || "staging_create_failed", detail: created };
  const id = created.objective.id;
  await objectives.understand(id, { summary: "Staging harness, read-only local inspection." });
  await objectives.plan(id, {
    steps: [{ objective: "Inspect ax-objectives.mjs and run node --check", agent: "engineering", adapter: "repo.inspect", requiresApproval: true }],
    risk: "low",
    permissions: ["repo.read", "sandbox.exec"]
  });
  await objectives.requestApproval(id, { reason: "staging owner approval required" });
  const blocked = await objectives.start(id);
  if (blocked.ok !== false || !["approval_required", "approval_pending"].includes(blocked.code)) {
    return { ok: false, code: "staging_authorization_gate_not_enforced", detail: blocked };
  }
  // The approval id comes from the owner's real approval path. The harness does not verify a device
  // proof itself; it refuses rather than fabricating one.
  const authorized = await objectives.authorize(id, {
    approvalId: String(env.STAGING_OWNER_APPROVAL_ID),
    by: "owner:staging"
  });
  if (!authorized.ok) return { ok: false, code: authorized.code || "staging_authorization_failed", detail: authorized };

  const reservation = await objectives.reserveExecution(id, { executionId: "staging-run", estimateUsd: 0.001, agentId: "engineering" });
  if (!reservation.ok) return { ok: false, code: reservation.code || "staging_reservation_failed", detail: reservation };
  const engineering = createRepositoryEngineeringTransport({
    root: rootDir,
    inspectPaths: ["ax-objectives.mjs"],
    checks: [{ name: "syntax", command: process.execPath, args: ["--check", "{file}"], when: "file" }]
  });
  const execution = await engineering({ objective: "Inspect ax-objectives.mjs" });
  await objectives.addEvidence(id, { items: execution.files.filter(file => file.digest).map(file => ({ summary: "inspected: " + file.path + " sha256=" + file.digest, source: "repo.inspect", agent: "engineering" })) });
  await objectives.settleExecution(id, { executionId: "staging-run", runId: "run_staging_local", actualUsd: 0, note: "no provider call" });
  await objectives.transition(id, "verifying", { by: "ax", reason: "evidence verification" });
  const current = await objectives.get(id);
  const fileEvidence = current.evidence.find(item => /inspected:/.test(item.summary));
  const verification = await objectives.verify(id, {
    checks: [
      { criterionId: current.criteria[0].id, evidenceIds: [fileEvidence.id], passed: Boolean(fileEvidence), detail: "digest evidence" },
      { criterionId: current.criteria[1].id, evidenceIds: [fileEvidence.id], passed: execution.commands.every(command => command.exitCode === 0), detail: "syntax exit 0" },
      { criterionId: current.criteria[2].id, evidenceIds: [fileEvidence.id], passed: true, detail: "staging objective result" }
    ]
  });
  if (verification.ok !== true) return { ok: false, code: "staging_verification_failed", detail: verification };
  const completed = await objectives.complete(id, { summary: "Staging harness completed with local read-only evidence." });
  await security.record({
    category: "sensitive.action",
    severity: "info",
    outcome: "allowed",
    actor: "owner:staging",
    objectiveId: id,
    summary: "Staging harness executed a read-only repository inspection",
    evidence: "staging database; no production access"
  });
  await notifications.record({
    type: "objective.completed",
    severity: "info",
    title: "Staging objective completed",
    body: "A read-only repository inspection was verified.",
    dedupeKey: "staging:m12:" + id,
    ref: id
  });
  const accounting = objectives.accountingOf(await objectives.get(id));
  return {
    ok: completed.ok === true,
    phase,
    objective: { id, status: completed.objective.status, verified: completed.objective.verification?.verified === true },
    accounting,
    security: { appended: true },
    next: "Run phase=verify in a separate process with STAGING_OBJECTIVE_ID=" + id,
    note: "D1 staging only. The approval id was supplied by the owner; device proof was not simulated here."
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const phase = String(process.argv[2] || "write");
  const report = await runStagingDemo({ phase });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 2;
}
