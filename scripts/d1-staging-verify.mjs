#!/usr/bin/env node
/**
 * Read-only (or explicitly confirmed) verification of the non-production D1 database.
 *
 * The point of this script is to be runnable by CI with the repository's existing
 * `HABITAT_D1_API_TOKEN` secret, so D1 evidence can be produced without the token ever being
 * printed, copied into a file or handed to an operator's shell.
 *
 * Safety:
 *  - refuses a malformed account or database id;
 *  - refuses when the target id equals `PRODUCTION_D1_DATABASE_ID`;
 *  - `--mode verify` issues statements that only read (`SELECT`);
 *  - `--mode migrate` applies the numbered migrations to the target and then verifies the result;
 *    it requires the target to be a non-production id and is the only write path here;
 *  - never returns or logs the token.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { P1_TABLES } from "./migration-rollback-check.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const MODES = Object.freeze(["verify", "migrate"]);
const SCHEMA_SQL = "SELECT type, name FROM sqlite_master WHERE name LIKE 'habitat%' ORDER BY type, name";

function trimmed(value) {
  return String(value ?? "").trim();
}

/**
 * Every numbered migration, in filename order. Application is idempotent (every statement is
 * `IF NOT EXISTS`), so a staging rehearsal can safely start from 0001 on a database that already
 * carries some of these tables.
 */
export function migrationFiles(rootDir) {
  const dir = path.join(rootDir, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

/**
 * @param {object} input
 * @param {object}  [input.env]
 * @param {string}  [input.rootDir]
 * @param {string}  [input.mode]      verify | migrate
 * @param {Function}[input.fetchImpl]
 * @param {Function}[input.log]       receives human progress lines
 */
export async function runD1StagingVerification({
  env = process.env,
  rootDir = process.cwd(),
  mode = "verify",
  fetchImpl = fetch,
  log = () => {}
} = {}) {
  const accountId = trimmed(env.CLOUDFLARE_ACCOUNT_ID);
  const token = trimmed(env.HABITAT_D1_API_TOKEN) || trimmed(env.CLOUDFLARE_API_TOKEN);
  const databaseId = trimmed(env.STAGING_D1_DATABASE_ID);
  const productionId = trimmed(env.PRODUCTION_D1_DATABASE_ID);

  const fail = (code, error, extra = {}) => ({ ok: false, code, error, mode, ...extra });

  if (!MODES.includes(mode)) return fail("mode_not_allowed", "mode must be one of " + MODES.join(", ") + ".");
  if (!accountId || !token || !databaseId) {
    return fail("missing_configuration", "CLOUDFLARE_ACCOUNT_ID, a D1 API token and STAGING_D1_DATABASE_ID are required.");
  }
  if (!ACCOUNT_ID.test(accountId)) return fail("malformed_account_id", "CLOUDFLARE_ACCOUNT_ID must be the 32-character Cloudflare account id.");
  if (!UUID.test(databaseId)) return fail("malformed_database_id", "The target database id must be a D1 UUID (36 characters with dashes).");
  if (!UUID.test(productionId)) {
    return fail("production_id_unavailable", "PRODUCTION_D1_DATABASE_ID must be a D1 UUID; refusing to run without a usable isolation guard.");
  }
  if (databaseId === productionId) {
    return fail("staging_is_production", "The target database id equals the production database id. Nothing was sent.");
  }

  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/d1/database/" + databaseId + "/query";

  async function query(sql) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ sql })
      });
    } catch (error) {
      return { ok: false, code: "d1_unreachable", error: String(error?.message || error).slice(0, 200) };
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body?.success === false) {
      const detail = body?.errors?.map((item) => item?.message).filter(Boolean).join("; ") || "HTTP " + response.status;
      return { ok: false, code: "d1_error", error: String(detail).slice(0, 300) };
    }
    // The HTTP API returns one result per statement, each with `results`.
    const results = Array.isArray(body?.result) ? body.result.flatMap((item) => item?.results || []) : [];
    return { ok: true, rows: results };
  }

  async function inspect() {
    const schema = await query(SCHEMA_SQL);
    if (!schema.ok) return schema;
    const objects = schema.rows.map((row) => ({ type: String(row.type || ""), name: String(row.name || "") }));
    const tables = objects.filter((item) => item.type === "table").map((item) => item.name);
    const presence = Object.fromEntries(P1_TABLES.map((name) => [name, tables.includes(name)]));
    return {
      ok: true,
      objects,
      tables,
      p1Tables: presence,
      p1TableCount: Object.values(presence).filter(Boolean).length,
      missingP1Tables: Object.keys(presence).filter((name) => !presence[name])
    };
  }

  log("target database " + databaseId.slice(0, 8) + "… (non-production; isolation guard passed)");

  const before = await inspect();
  if (!before.ok) return { ...before, mode };

  const applied = [];
  if (mode === "migrate") {
    for (const name of migrationFiles(rootDir)) {
      const sql = readFileSync(path.join(rootDir, "migrations", name), "utf8");
      const outcome = await query(sql);
      if (!outcome.ok) {
        return { ok: false, code: "migration_failed", error: "migration " + name + ": " + outcome.error, mode, applied };
      }
      applied.push(name);
      log("applied " + name);
    }
  }

  const after = mode === "migrate" ? await inspect() : before;
  if (!after.ok) return { ...after, mode, applied };

  const verified = after.missingP1Tables.length === 0;
  return {
    ok: verified,
    code: verified ? null : "p1_tables_missing",
    mode,
    accountIdSuffix: accountId.slice(-4),
    databaseId,
    productionIdDiffers: databaseId !== productionId,
    before: { objectCount: before.objects.length, p1TableCount: before.p1TableCount },
    after: {
      objectCount: after.objects.length,
      tableCount: after.tables.length,
      indexCount: after.objects.filter((item) => item.type === "index").length,
      p1TableCount: after.p1TableCount,
      missingP1Tables: after.missingP1Tables,
      tables: after.tables
    },
    applied,
    note: "No token, header or credential value appears in this report. Production was never targeted."
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const argIndex = process.argv.indexOf("--mode");
  const mode = argIndex > -1 ? String(process.argv[argIndex + 1] || "verify") : "verify";
  const report = await runD1StagingVerification({ mode, log: (line) => console.error(line) });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
