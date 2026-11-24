#!/usr/bin/env node
/**
 * Read-only preflight for migration 0010 (workforce tables) against a real D1 database.
 *
 * It never writes: no CREATE, no ALTER, no migration record. The only statements it sends are a
 * schema read, and — only when the schema is already present — four COUNT(*) reads. If a table is
 * missing it prints the apply command and exits non-zero instead of repairing anything.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=... HABITAT_D1_DATABASE_ID=... HABITAT_D1_API_TOKEN=... \
 *     node scripts/workforce-schema-preflight.mjs
 *
 * See docs/WORKFORCE_D1_STAGING_MIGRATION.md for the full staging procedure.
 */

import { createD1Query } from "../nexus-runtime.mjs";
import { inspectWorkforceSchema, WORKFORCE_MIGRATION } from "../ax-workforce-runtime.mjs";

const env = process.env;
const required = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"];
const missing = required.filter(key => !String(env[key] || "").trim());

if (missing.length > 0) {
  console.log(JSON.stringify({
    ok: false,
    migration: WORKFORCE_MIGRATION,
    code: "d1_binding_incomplete",
    missingConfiguration: missing,
    wroteAnything: false
  }, null, 2));
  process.exit(1);
}

const query = createD1Query({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: env.HABITAT_D1_DATABASE_ID,
  apiToken: env.HABITAT_D1_API_TOKEN
});

try {
  const schema = await inspectWorkforceSchema({ query });
  const report = {
    ok: schema.ok,
    migration: WORKFORCE_MIGRATION,
    databaseIdSuffix: String(env.HABITAT_D1_DATABASE_ID).slice(-6),
    schema,
    wroteAnything: false
  };

  if (schema.ok) {
    const rows = await query(
      "SELECT (SELECT COUNT(*) FROM habitat_ax_workers) AS agents, " +
      "(SELECT COUNT(*) FROM habitat_ax_worker_assignments) AS assignments, " +
      "(SELECT COUNT(*) FROM habitat_ax_worker_results) AS results, " +
      "(SELECT COUNT(*) FROM habitat_ax_worker_audit) AS audit"
    );
    report.counts = rows?.[0] || null;
    report.nextSteps = [
      "Apply nothing: the migration is already present.",
      "Leave HABITAT_WORKFORCE_ENABLED unset until activation is approved.",
      "To verify hydration, start with the flag true in a staging service and read /system/status."
    ];
  } else {
    report.nextSteps = [
      "Export the database (dashboard Export or Time Travel bookmark) before writing.",
      "Apply with: npx wrangler d1 execute <database> --remote --file migrations/0010_ax_workforce.sql",
      "Re-run this preflight; it must report ok: true with missing: []."
    ];
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(schema.ok ? 0 : 1);
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    migration: WORKFORCE_MIGRATION,
    code: "preflight_failed",
    error: String(error?.message || error).slice(0, 200),
    wroteAnything: false
  }, null, 2));
  process.exit(1);
}
