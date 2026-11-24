import test from "node:test";
import assert from "node:assert/strict";
import { runStagingMigration, FROM_MIGRATION, EXPECTED_TABLES } from "../scripts/staging-migrate.mjs";
import { migrationFiles } from "../scripts/d1-staging-verify.mjs";
import { P1_TABLES } from "../scripts/migration-rollback-check.mjs";

const ACCOUNT = "e43f2644d05e76ecbcf537d67480d607";
const STAGING = "baaa7965-c723-4d42-831c-a9530762f726";
const PRODUCTION = "3a906029-bc64-4e2a-b648-163e34a2d502";
const TOKEN = "staging-secret-token-never-print";
const BOOKMARK = "0000001a-00000000-0000-0000-0000-000000000000";

const env = () => ({
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  HABITAT_D1_API_TOKEN: TOKEN,
  STAGING_D1_DATABASE_ID: STAGING,
  PRODUCTION_D1_DATABASE_ID: PRODUCTION
});

function d1Sim({ bookmarkStatus = 200 } = {}) {
  const objects = new Set([...P1_TABLES.map((name) => "table:" + name), "table:habitat_ax_capabilities"]);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if ((options.method || "GET") === "GET") {
      calls.push({ url, method: "GET" });
      if (bookmarkStatus !== 200) {
        return { ok: false, status: bookmarkStatus, json: async () => ({ success: false, errors: [{ message: "bookmark denied" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, result: { bookmark: BOOKMARK } }) };
    }
    const sql = JSON.parse(options.body).sql;
    calls.push({ url, method: "POST", sql });
    for (const statement of sql.split(";")) {
      const table = statement.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
      if (table) objects.add("table:" + table[1]);
      const index = statement.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/i);
      if (index) objects.add("index:" + index[1]);
    }
    const rows = [...objects].map((entry) => {
      const [type, name] = entry.split(":");
      return { type, name };
    });
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  return { fetchImpl, calls, objects };
}

test("migration refuses before any request when a production id is unavailable", async () => {
  const sim = d1Sim();
  const report = await runStagingMigration({ env: { ...env(), PRODUCTION_D1_DATABASE_ID: "" }, fetchImpl: sim.fetchImpl });
  assert.equal(report.code, "production_id_unavailable");
  assert.equal(sim.calls.length, 0);
});

test("migration refuses before any request when the target is production", async () => {
  const sim = d1Sim();
  const report = await runStagingMigration({ env: { ...env(), STAGING_D1_DATABASE_ID: PRODUCTION }, fetchImpl: sim.fetchImpl });
  assert.equal(report.code, "staging_is_production");
  assert.equal(sim.calls.length, 0);
});

test("no bookmark means no migration and no write", async () => {
  const sim = d1Sim({ bookmarkStatus: 500 });
  const report = await runStagingMigration({ env: env(), fetchImpl: sim.fetchImpl });
  assert.equal(report.ok, false);
  assert.equal(report.code, "backup_unavailable");
  assert.equal(sim.calls.length, 1, "only the failed bookmark read");
  assert.equal(sim.calls.some((call) => call.method === "POST"), false);
});

test("a stored bookmark is returned and only 0010-0016 are applied", async () => {
  const sim = d1Sim();
  const report = await runStagingMigration({ env: env(), fetchImpl: sim.fetchImpl, rootDir: process.cwd() });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.backup.bookmark, BOOKMARK);
  assert.deepEqual(report.applied, migrationFiles(process.cwd()).filter((name) => Number(name.slice(0, 4)) >= Number(FROM_MIGRATION)));
  assert.ok(report.applied.every((name) => Number(name.slice(0, 4)) >= 10));
  assert.deepEqual(report.missingTables, []);
  assert.deepEqual(report.missingIndexes, []);
  for (const table of EXPECTED_TABLES) assert.ok(sim.objects.has("table:" + table), "missing " + table);
  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes(TOKEN), false);
  assert.equal(serialised.includes(ACCOUNT), false);
  assert.equal(sim.calls.some((call) => call.url.includes(PRODUCTION)), false);
});

test("an incomplete post-migration schema fails verification", async () => {
  const sim = d1Sim();
  const original = sim.fetchImpl;
  let posts = 0;
  const fetchImpl = async (url, options = {}) => {
    if ((options.method || "GET") !== "GET") {
      posts += 1;
      // Apply nothing, but keep the response shape valid.
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [] }] }) };
    }
    return original(url, options);
  };
  const report = await runStagingMigration({ env: env(), fetchImpl, rootDir: process.cwd() });
  assert.ok(posts > 0);
  assert.equal(report.ok, false);
  assert.equal(report.code, "p1_tables_missing", "the underlying verifier fails before readiness is claimed");
});
