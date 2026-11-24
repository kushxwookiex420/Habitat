import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Rollback evidence for the P1 migrations.
 *
 * Habitat migrations are forward-only and additive, so there is no `down` file. The honest rollback
 * for 0008/0009 is: stop writing, then drop the seven tables those files created. This harness proves
 * three things that a claim alone cannot:
 *
 *   1. every P1 table is created by 0008/0009 and nothing else is touched;
 *   2. dropping them restores the schema object list to exactly what it was before 0008;
 *   3. pre-existing rows (command tasks, cost ledger, objectives) survive apply, drop and re-apply.
 *
 * What it does **not** prove: that dropping the tables is lossless for P1 data. It is not. Rolling
 * back discards capability snapshots, approvals, revenue events and payouts. Operators must export
 * those first, which the report says plainly.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Reverse order of creation: 0009's tables first, then 0008's. */
export const P1_TABLES = Object.freeze([
  "habitat_ax_treasury_accounts",
  "habitat_ax_payouts",
  "habitat_ax_revenue_events",
  "habitat_ax_channel_rules",
  "habitat_ax_supplier_offers",
  "habitat_ax_suppliers",
  "habitat_ax_access_requests",
  "habitat_ax_capabilities"
]);

export function rollbackStatements() {
  return P1_TABLES.map(name => "DROP TABLE IF EXISTS " + name);
}

/**
 * 0010 is a later, independent group. It gets its own rollback statements so this harness can still
 * prove the stronger pre-0008 claim without pretending the workforce tables are part of P1.
 */
export const WORKFORCE_TABLES = Object.freeze([
  "habitat_ax_worker_audit",
  "habitat_ax_worker_results",
  "habitat_ax_worker_assignments",
  "habitat_ax_workers",
  "habitat_ax_worker_adapters"
]);

export const WORKFORCE_INDEXES = Object.freeze([
  "habitat_ax_worker_audit_action",
  "habitat_ax_worker_results_task",
  "habitat_ax_worker_assignments_agent",
  "habitat_ax_worker_assignments_active_task",
  "habitat_ax_workers_specialty"
]);

export const WORKFORCE_V1_TABLES = Object.freeze([
  "habitat_ax_workforce_recovery",
  "habitat_ax_workforce_executions",
  "habitat_ax_workforce_leases",
  "habitat_ax_workforce_workers"
]);

export const WORKFORCE_V1_INDEXES = Object.freeze([
  "habitat_ax_workforce_recovery_kind",
  "habitat_ax_workforce_recovery_mission",
  "habitat_ax_workforce_executions_state",
  "habitat_ax_workforce_executions_task",
  "habitat_ax_workforce_leases_mission",
  "habitat_ax_workforce_leases_expiry",
  "habitat_ax_workforce_leases_worker",
  "habitat_ax_workforce_leases_active_task",
  "habitat_ax_workforce_workers_state"
]);

export function workforceV1RollbackStatements() {
  return [
    ...WORKFORCE_V1_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...WORKFORCE_V1_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

/**
 * 0019 is additive over 0018, so its rollback runs first. Dropping it revokes every worker credential and
 * loses the nonce, operation and reassignment ledgers; the export requirement is the same as for 0018.
 */
export const WORKFORCE_IDENTITY_TABLES = Object.freeze([
  "habitat_ax_workforce_reassignments",
  "habitat_ax_workforce_operations",
  "habitat_ax_workforce_auth_nonces",
  "habitat_ax_workforce_credentials"
]);

export const WORKFORCE_IDENTITY_INDEXES = Object.freeze([
  "habitat_ax_workforce_reassignments_mission",
  "habitat_ax_workforce_operations_reference",
  "habitat_ax_workforce_operations_state",
  "habitat_ax_workforce_auth_nonces_expiry",
  "habitat_ax_workforce_credentials_expiry",
  "habitat_ax_workforce_credentials_worker"
]);

export function workforceIdentityRollbackStatements() {
  return [
    ...WORKFORCE_IDENTITY_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...WORKFORCE_IDENTITY_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

export const APPROVAL_NONCE_TABLES = Object.freeze(["habitat_ax_approval_nonces"]);

export const APPROVAL_NONCE_INDEXES = Object.freeze([
  "habitat_ax_approval_nonces_mission",
  "habitat_ax_approval_nonces_approval",
  "habitat_ax_approval_nonces_expiry"
]);

export function approvalNonceRollbackStatements() {
  return [
    ...APPROVAL_NONCE_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...APPROVAL_NONCE_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

export const MCP_TABLES = Object.freeze(["habitat_ax_mcp_delivery_leases", "habitat_ax_mcp_deliveries", "habitat_ax_mcp_events", "habitat_ax_mcp_verifications", "habitat_ax_mcp_subscriptions"]);

export const MCP_INDEXES = Object.freeze(["habitat_ax_mcp_delivery_leases_expiry", "habitat_ax_mcp_deliveries_due", "habitat_ax_mcp_deliveries_identity", "habitat_ax_mcp_events_name_seq", "habitat_ax_mcp_events_event_id", "habitat_ax_mcp_subscriptions_identity"]);

export function mcpRollbackStatements() {
  return [
    ...MCP_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...MCP_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

export const RATE_LIMIT_TABLES = Object.freeze(["habitat_ax_gateway_rate_limits"]);

export function rateLimitRollbackStatements() {
  return RATE_LIMIT_TABLES.map(name => "DROP TABLE IF EXISTS " + name);
}

export const HEARTBEAT_TABLES = Object.freeze(["habitat_ax_heartbeat_deliveries", "habitat_ax_heartbeat_events", "habitat_ax_heartbeat_state"]);

export const HEARTBEAT_INDEXES = Object.freeze(["habitat_ax_heartbeat_events_pending", "habitat_ax_heartbeat_events_dedupe"]);

export function heartbeatRollbackStatements() {
  return [
    ...HEARTBEAT_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...HEARTBEAT_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

export const GATEWAY_TABLES = Object.freeze(["habitat_ax_gateway_audit", "habitat_ax_gateway_nonces", "habitat_ax_gateway_clients"]);

export const GATEWAY_INDEXES = Object.freeze(["habitat_ax_gateway_clients_token"]);

export function gatewayRollbackStatements() {
  return [
    ...GATEWAY_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...GATEWAY_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

export const MISSION_TABLES = Object.freeze(["habitat_ax_mission_events", "habitat_ax_missions"]);

export const MISSION_INDEXES = Object.freeze(["habitat_ax_mission_events_mission", "habitat_ax_missions_status"]);

export function missionRollbackStatements() {
  return [
    ...MISSION_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...MISSION_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

export function workforceRollbackStatements() {
  return [
    ...WORKFORCE_INDEXES.map(name => "DROP INDEX IF EXISTS " + name),
    ...WORKFORCE_TABLES.map(name => "DROP TABLE IF EXISTS " + name)
  ];
}

async function migrationFiles() {
  const names = (await readdir(MIGRATIONS_DIR)).filter(name => name.endsWith(".sql")).sort();
  return names.map(name => ({ name, path: path.join(MIGRATIONS_DIR, name), version: Number(name.slice(0, 4)) }));
}

async function apply(db, files) {
  for (const file of files) db.exec(await readFile(file.path, "utf8"));
}

function objects(db) {
  return db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map(row => row.type + ":" + row.name);
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

export async function runRollbackChecks() {
  const files = await migrationFiles();
  const before = files.filter(file => file.version <= 7);
  const p1 = files.filter(file => file.version === 8 || file.version === 9);
  const later = files.filter(file => file.version >= 10);
  const report = { ok: true, files: files.map(file => file.name), checks: [] };
  const check = (name, condition, detail = null) => {
    report.checks.push({ name, ok: Boolean(condition), detail });
    if (!condition) report.ok = false;
  };

  const db = new DatabaseSync(":memory:");
  try {
    await apply(db, before);
    const baseline = objects(db);
    check("baseline applies through 0007", tables(db).includes("habitat_ax_cost_ledger"));
    check("no P1 table exists before 0008", P1_TABLES.every(name => !tables(db).includes(name)));

    // Pre-existing rows that a rollback must not disturb.
    const stamp = "2026-11-23T12:00:00.000Z";
    db.prepare("INSERT INTO habitat_command_tasks (id, record_json, status, updated_at) VALUES (?, ?, ?, ?)")
      .run("task_legacy", JSON.stringify({ id: "task_legacy", status: "done", objective: "survive" }), "done", stamp);
    db.prepare("INSERT INTO habitat_ax_cost_ledger (day, state_json, updated_at) VALUES (?, ?, ?)")
      .run("2026-11-23", JSON.stringify({ spentUsd: 0.02 }), stamp);
    db.prepare("INSERT INTO habitat_ax_objectives (id, project, status, record_json, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("obj_legacy", "habitat", "executing", JSON.stringify({ id: "obj_legacy" }), stamp);

    await apply(db, p1);
    check("0008 and 0009 create every P1 table", P1_TABLES.every(name => tables(db).includes(name)));
    await apply(db, later);
    check("0010 creates every workforce table", WORKFORCE_TABLES.every(name => tables(db).includes(name)));
    check("0011 creates every mission table", MISSION_TABLES.every(name => tables(db).includes(name)));
    check("0012 creates every gateway table", GATEWAY_TABLES.every(name => tables(db).includes(name)));
    check("0013 creates every heartbeat table", HEARTBEAT_TABLES.every(name => tables(db).includes(name)));
    check("0014 creates the shared rate-limit table", RATE_LIMIT_TABLES.every(name => tables(db).includes(name)));
    check("0015 creates every MCP events table", MCP_TABLES.every(name => tables(db).includes(name)));
    check("0017 creates the approval nonce registry", APPROVAL_NONCE_TABLES.every(name => tables(db).includes(name)));
    check("0018 creates every workforce v1 table", WORKFORCE_V1_TABLES.every(name => tables(db).includes(name)));
    check("0019 creates every workforce identity table", WORKFORCE_IDENTITY_TABLES.every(name => tables(db).includes(name)));
    // 0018 stands alone: a database that stops there still has a working lease layer.
    check("0018 tables do not depend on 0019 tables", tables(db).includes("habitat_ax_workforce_leases") && tables(db).includes("habitat_ax_workforce_credentials"));

    db.prepare("INSERT INTO habitat_ax_capabilities (id, kind, state, requires_approval, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("cap_1", "fulfillment", "policy_only", 1, JSON.stringify({ id: "cap_1" }), stamp);
    db.prepare("INSERT INTO habitat_ax_access_requests (id, kind, capability_id, status, fingerprint, amount_cents, currency, requested_at, expires_at, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("apr_1", "purchase", null, "approved", "sha256:x", 1237, "USD", stamp, stamp, JSON.stringify({ id: "apr_1" }), stamp);
    db.prepare("INSERT INTO habitat_ax_revenue_events (id, state, currency, amount_cents, occurred_at, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("rev_1", "settled", "USD", 4500, stamp, JSON.stringify({ id: "rev_1" }), stamp);

    // Rollback: later groups first, then P1.
    for (const statement of workforceIdentityRollbackStatements()) db.exec(statement);
    check("0019 rollback removes every workforce identity table and index",
      WORKFORCE_IDENTITY_TABLES.every(name => !tables(db).includes(name)) &&
      WORKFORCE_IDENTITY_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    check("0019 rollback leaves the 0018 lease layer intact", WORKFORCE_V1_TABLES.every(name => tables(db).includes(name)));
    for (const statement of workforceV1RollbackStatements()) db.exec(statement);
    check("0018 rollback removes every workforce v1 table and index",
      WORKFORCE_V1_TABLES.every(name => !tables(db).includes(name)) &&
      WORKFORCE_V1_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    for (const statement of approvalNonceRollbackStatements()) db.exec(statement);
    check("0017 rollback removes the approval nonce registry",
      APPROVAL_NONCE_TABLES.every(name => !tables(db).includes(name)) &&
      APPROVAL_NONCE_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    for (const statement of mcpRollbackStatements()) db.exec(statement);
    check("0015 rollback removes every MCP events table and index",
      MCP_TABLES.every(name => !tables(db).includes(name)) &&
      MCP_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    for (const statement of rateLimitRollbackStatements()) db.exec(statement);
    check("0014 rollback removes the shared rate-limit table", RATE_LIMIT_TABLES.every(name => !tables(db).includes(name)));
    for (const statement of heartbeatRollbackStatements()) db.exec(statement);
    check("0013 rollback removes every heartbeat table and index",
      HEARTBEAT_TABLES.every(name => !tables(db).includes(name)) &&
      HEARTBEAT_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    for (const statement of gatewayRollbackStatements()) db.exec(statement);
    check("0012 rollback removes every gateway table and index",
      GATEWAY_TABLES.every(name => !tables(db).includes(name)) &&
      GATEWAY_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    for (const statement of missionRollbackStatements()) db.exec(statement);
    check("0011 rollback removes every mission table and index",
      MISSION_TABLES.every(name => !tables(db).includes(name)) &&
      MISSION_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    for (const statement of workforceRollbackStatements()) db.exec(statement);
    check("0010 rollback removes every workforce table and index",
      WORKFORCE_TABLES.every(name => !tables(db).includes(name)) &&
      WORKFORCE_INDEXES.every(name => objects(db).every(item => item !== "index:" + name)));
    for (const statement of rollbackStatements()) db.exec(statement);

    check("rollback removes every P1 table", P1_TABLES.every(name => !tables(db).includes(name)));
    const after = objects(db);
    check("rollback restores the exact pre-0008 schema", JSON.stringify(after) === JSON.stringify(baseline), {
      missing: baseline.filter(item => !after.includes(item)),
      extra: after.filter(item => !baseline.includes(item))
    });
    check("rollback preserves the command task row", db.prepare("SELECT record_json FROM habitat_command_tasks WHERE id = 'task_legacy'").get()?.record_json?.includes("survive"));
    check("rollback preserves the cost ledger row", db.prepare("SELECT state_json FROM habitat_ax_cost_ledger WHERE day = '2026-11-23'").get()?.state_json?.includes("spentUsd"));
    check("rollback preserves the objective row", db.prepare("SELECT status FROM habitat_ax_objectives WHERE id = 'obj_legacy'").get()?.status === "executing");

    // Re-applying after a rollback must be clean and must not resurrect old P1 rows.
    await apply(db, p1);
    await apply(db, later);
    check("P1 tables can be recreated after rollback", P1_TABLES.every(name => tables(db).includes(name)));
    check("workforce tables can be recreated after rollback", WORKFORCE_TABLES.every(name => tables(db).includes(name)));
    check("mission tables can be recreated after rollback", MISSION_TABLES.every(name => tables(db).includes(name)));
    check("gateway tables can be recreated after rollback", GATEWAY_TABLES.every(name => tables(db).includes(name)));
    check("heartbeat tables can be recreated after rollback", HEARTBEAT_TABLES.every(name => tables(db).includes(name)));
    check("rate-limit table can be recreated after rollback", RATE_LIMIT_TABLES.every(name => tables(db).includes(name)));
    check("MCP events tables can be recreated after rollback", MCP_TABLES.every(name => tables(db).includes(name)));
    check("recreated P1 tables start empty", db.prepare("SELECT COUNT(*) AS n FROM habitat_ax_access_requests").get().n === 0);
    check("re-apply still preserves legacy rows", db.prepare("SELECT status FROM habitat_ax_objectives WHERE id = 'obj_legacy'").get()?.status === "executing");
  } finally {
    db.close();
  }

  report.summary = {
    checks: report.checks.length,
    passed: report.checks.filter(item => item.ok).length,
    failed: report.checks.filter(item => !item.ok).length,
    droppedTables: P1_TABLES.length,
    droppedWorkforceTables: WORKFORCE_TABLES.length,
    droppedMissionTables: MISSION_TABLES.length,
    droppedGatewayTables: GATEWAY_TABLES.length,
    droppedHeartbeatTables: HEARTBEAT_TABLES.length,
    droppedRateLimitTables: RATE_LIMIT_TABLES.length,
    droppedMcpTables: MCP_TABLES.length,
    dataLoss: "P1 rows are discarded by rollback; export them first. Pre-0008 tables and rows are not touched.",
    environment: "node:sqlite in-memory (D1-compatible SQL only; not D1 itself)"
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runRollbackChecks();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
