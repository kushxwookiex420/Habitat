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
  const p1 = files.filter(file => file.version >= 8);
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

    db.prepare("INSERT INTO habitat_ax_capabilities (id, kind, state, requires_approval, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("cap_1", "fulfillment", "policy_only", 1, JSON.stringify({ id: "cap_1" }), stamp);
    db.prepare("INSERT INTO habitat_ax_access_requests (id, kind, capability_id, status, fingerprint, amount_cents, currency, requested_at, expires_at, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("apr_1", "purchase", null, "approved", "sha256:x", 1237, "USD", stamp, stamp, JSON.stringify({ id: "apr_1" }), stamp);
    db.prepare("INSERT INTO habitat_ax_revenue_events (id, state, currency, amount_cents, occurred_at, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("rev_1", "settled", "USD", 4500, stamp, JSON.stringify({ id: "rev_1" }), stamp);

    // Rollback.
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
    check("P1 tables can be recreated after rollback", P1_TABLES.every(name => tables(db).includes(name)));
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
