import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Local migration validation against SQLite.
 *
 * This is the closest check available without touching D1. It proves the SQL parses, is idempotent,
 * creates the expected tables and indexes, and preserves existing rows across an upgrade. It does
 * **not** prove Cloudflare D1 compatibility or that production has the schema; the report says so.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrationFiles() {
  const names = (await readdir(MIGRATIONS_DIR)).filter(name => name.endsWith(".sql")).sort();
  return names.map(name => ({ name, path: path.join(MIGRATIONS_DIR, name) }));
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

function indexes(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

async function applyAll(db, files) {
  for (const file of files) {
    const sql = await readFile(file.path, "utf8");
    db.exec(sql);
  }
}

export async function runMigrationChecks() {
  const files = await migrationFiles();
  const report = { ok: true, files: files.map(file => file.name), checks: [] };
  const check = (name, condition, detail = null) => {
    report.checks.push({ name, ok: Boolean(condition), detail });
    if (!condition) report.ok = false;
  };

  // Fresh database: every migration in order.
  const fresh = new DatabaseSync(":memory:");
  try {
    await applyAll(fresh, files);
    const freshTables = tables(fresh);
    const freshIndexes = indexes(fresh);
    for (const name of [
      "habitat_command_tasks",
      "habitat_ax_memory",
      "habitat_ax_notifications",
      "habitat_ax_objectives",
      "habitat_ax_incidents",
      "habitat_ax_security_events",
      "habitat_ax_scheduler",
      "habitat_ax_messages",
      "habitat_ax_cost_ledger",
      "habitat_ax_capabilities",
      "habitat_ax_access_requests",
      "habitat_ax_suppliers",
      "habitat_ax_supplier_offers",
      "habitat_ax_channel_rules",
      "habitat_ax_revenue_events",
      "habitat_ax_payouts",
      "habitat_ax_treasury_accounts",
      "habitat_ax_approval_nonces",
      "habitat_ax_workforce_workers",
      "habitat_ax_workforce_leases",
      "habitat_ax_workforce_executions",
      "habitat_ax_workforce_recovery",
      "habitat_ax_workforce_credentials",
      "habitat_ax_workforce_auth_nonces",
      "habitat_ax_workforce_operations",
      "habitat_ax_workforce_reassignments"
    ]) {
      check("fresh table " + name, freshTables.includes(name));
    }
    for (const name of [
      "habitat_ax_objectives_status",
      "habitat_ax_incidents_fingerprint",
      "habitat_ax_security_events_seq",
      "habitat_ax_security_events_category",
      "habitat_ax_messages_correlation",
      "habitat_ax_messages_status_updated",
      "habitat_ax_cost_ledger_updated_at",
      "habitat_ax_approval_nonces_mission",
      "habitat_ax_approval_nonces_approval",
      "habitat_ax_approval_nonces_expiry",
      "habitat_ax_workforce_leases_active_task",
      "habitat_ax_workforce_leases_worker",
      "habitat_ax_workforce_leases_expiry",
      "habitat_ax_workforce_leases_mission",
      "habitat_ax_workforce_executions_task",
      "habitat_ax_workforce_executions_state",
      "habitat_ax_workforce_workers_state",
      "habitat_ax_workforce_recovery_mission",
      "habitat_ax_workforce_recovery_kind",
      "habitat_ax_workforce_credentials_worker",
      "habitat_ax_workforce_credentials_expiry",
      "habitat_ax_workforce_auth_nonces_expiry",
      "habitat_ax_workforce_operations_state",
      "habitat_ax_workforce_operations_reference",
      "habitat_ax_workforce_reassignments_mission",
      "habitat_ax_capabilities_kind",
      "habitat_ax_capabilities_state",
      "habitat_ax_access_requests_status",
      "habitat_ax_access_requests_fingerprint",
      "habitat_ax_suppliers_layer",
      "habitat_ax_channel_rules_channel",
      "habitat_ax_revenue_events_state",
      "habitat_ax_payouts_state"
    ]) {
      check("fresh index " + name, freshIndexes.includes(name));
    }
    // Repeated execution must be a no-op, not an error.
    await applyAll(fresh, files);
    check("repeated migrations are idempotent", tables(fresh).length === freshTables.length && indexes(fresh).length === freshIndexes.length);

    // Insert representative rows, then run everything again and verify preservation.
    exactInsert(fresh, "habitat_ax_scheduler", {
      id: "primary",
      record_json: JSON.stringify({ tickCount: 1 }),
      revision: 1,
      lease_expires_at: null,
      updated_at: new Date().toISOString()
    });
    exactInsert(fresh, "habitat_ax_security_events", {
      id: "sec_test",
      seq: 1,
      category: "auth.failure",
      severity: "medium",
      outcome: "denied",
      actor: "anonymous",
      device_id: null,
      objective_id: null,
      run_id: null,
      task_id: null,
      correlation_id: null,
      record_json: JSON.stringify({ id: "sec_test", seq: 1 }),
      prev_hash: null,
      hash: "0".repeat(64),
      created_at: new Date().toISOString()
    });
    await applyAll(fresh, files);
    const schedulerRow = fresh.prepare("SELECT record_json FROM habitat_ax_scheduler WHERE id = 'primary'").get();
    const eventRow = fresh.prepare("SELECT record_json FROM habitat_ax_security_events WHERE id = 'sec_test'").get();
    check("re-running migrations preserves scheduler state", schedulerRow?.record_json?.includes("tickCount"));
    check("re-running migrations preserves security events", eventRow?.record_json?.includes("sec_test"));
    check("security sequence is unique", uniqueIndexHolds(fresh));
  } finally {
    fresh.close();
  }

  // Upgrade path: stop before 0005, write data, then apply 0005.
  const upgrade = new DatabaseSync(":memory:");
  try {
    const before = files.filter(file => Number(file.name.slice(0, 4)) <= 4);
    const after = files.filter(file => Number(file.name.slice(0, 4)) >= 5);
    await applyAll(upgrade, before);
    upgrade.prepare("INSERT INTO habitat_command_tasks (id, record_json, status, updated_at) VALUES (?, ?, ?, ?)")
      .run("task_legacy", JSON.stringify({ id: "task_legacy", status: "queued" }), "queued", new Date().toISOString());
    await applyAll(upgrade, after);
    const row = upgrade.prepare("SELECT record_json FROM habitat_command_tasks WHERE id = 'task_legacy'").get();
    check("upgrade preserves existing task data", row?.record_json?.includes("task_legacy"));
    check("upgrade adds security events table", tables(upgrade).includes("habitat_ax_security_events"));
    check("upgrade adds scheduler table", tables(upgrade).includes("habitat_ax_scheduler"));
    check("upgrade adds the Ax-NEXUS message table", tables(upgrade).includes("habitat_ax_messages"));
  } finally {
    upgrade.close();
  }

  // Upgrade path for the P1 network: stop before 0008, write cost-ledger and task data, then apply
  // 0008/0009. Nothing that existed before may be lost.
  const networkUpgrade = new DatabaseSync(":memory:");
  try {
    const before = files.filter(file => Number(file.name.slice(0, 4)) <= 7);
    const after = files.filter(file => Number(file.name.slice(0, 4)) >= 8);
    await applyAll(networkUpgrade, before);
    networkUpgrade.prepare("INSERT INTO habitat_ax_cost_ledger (day, state_json, updated_at) VALUES (?, ?, ?)")
      .run("2026-11-23", JSON.stringify({ spentUsd: 0.02 }), new Date().toISOString());
    await applyAll(networkUpgrade, after);
    const ledgerRow = networkUpgrade.prepare("SELECT state_json FROM habitat_ax_cost_ledger WHERE day = '2026-11-23'").get();
    check("P1 upgrade preserves the cost ledger", ledgerRow?.state_json?.includes("spentUsd"));
    check("P1 upgrade adds the capability registry", tables(networkUpgrade).includes("habitat_ax_capabilities"));
    check("P1 upgrade adds the approval ledger", tables(networkUpgrade).includes("habitat_ax_access_requests"));
    check("P1 upgrade adds treasury reporting tables", tables(networkUpgrade).includes("habitat_ax_revenue_events") && tables(networkUpgrade).includes("habitat_ax_payouts"));
    // The approval ledger accepts a financial row with no capability, which is the point of one table.
    networkUpgrade.prepare("INSERT INTO habitat_ax_access_requests (id, kind, capability_id, status, fingerprint, amount_cents, currency, requested_at, expires_at, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("apr_fin", "purchase", null, "requested", "sha256:test", 1234, "USD", new Date().toISOString(), new Date(Date.now() + 60000).toISOString(), "{}", new Date().toISOString());
    const approvalRow = networkUpgrade.prepare("SELECT kind, capability_id FROM habitat_ax_access_requests WHERE id = 'apr_fin'").get();
    check("financial approvals do not need a capability id", approvalRow?.kind === "purchase" && approvalRow?.capability_id === null);
  } finally {
    networkUpgrade.close();
  }

  report.summary = {
    checks: report.checks.length,
    passed: report.checks.filter(item => item.ok).length,
    failed: report.checks.filter(item => !item.ok).length,
    environment: "node:sqlite in-memory (D1-compatible SQL only; not D1 itself)"
  };
  return report;
}

function exactInsert(db, table, values) {
  const columns = Object.keys(values);
  db.prepare("INSERT INTO " + table + " (" + columns.join(", ") + ") VALUES (" + columns.map(() => "?").join(", ") + ")")
    .run(...columns.map(column => values[column]));
}

function uniqueIndexHolds(db) {
  try {
    db.prepare("INSERT INTO habitat_ax_security_events (id, seq, category, severity, outcome, record_json, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("sec_dup", 1, "auth.failure", "low", "denied", "{}", "f".repeat(64), new Date().toISOString());
    return false;
  } catch {
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runMigrationChecks();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
