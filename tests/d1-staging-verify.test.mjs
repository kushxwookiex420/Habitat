import test from "node:test";
import assert from "node:assert/strict";
import { runD1StagingVerification, migrationFiles } from "../scripts/d1-staging-verify.mjs";
import { P1_TABLES } from "../scripts/migration-rollback-check.mjs";

const ACCOUNT = "e43f2644d05e76ecbcf537d67480d607";
const STAGING = "baaa7965-c723-4d42-831c-a9530762f726";
const PRODUCTION = "3a906029-bc64-4e2a-b648-163e34a2d502";
const TOKEN = "d1-secret-token-value-do-not-print";

const baseEnv = () => ({
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  HABITAT_D1_API_TOKEN: TOKEN,
  STAGING_D1_DATABASE_ID: STAGING,
  PRODUCTION_D1_DATABASE_ID: PRODUCTION
});

/** Simulates the D1 HTTP API: tracks objects and applies simple CREATE statements. */
function d1Sim({ initial = [] } = {}) {
  const objects = new Set(initial);
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, sql: body.sql });
    const statements = body.sql.split(";");
    for (const statement of statements) {
      const table = statement.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
      if (table) objects.add("table:" + table[1]);
      const index = statement.match(/CREATE INDEX IF NOT EXISTS\s+(\w+)/i);
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

const fullSchema = [
  ...P1_TABLES.map((name) => "table:" + name),
  "table:habitat_ax_capabilities",
  "index:habitat_ax_capabilities_kind"
];

test("a missing configuration is refused before any request", async () => {
  const sim = d1Sim();
  const report = await runD1StagingVerification({ env: {}, fetchImpl: sim.fetchImpl });
  assert.equal(report.ok, false);
  assert.equal(report.code, "missing_configuration");
  assert.equal(sim.calls.length, 0);
});

test("the account id must be the 32-character account id, not a database id", async () => {
  const sim = d1Sim();
  const report = await runD1StagingVerification({
    env: { ...baseEnv(), CLOUDFLARE_ACCOUNT_ID: STAGING },
    fetchImpl: sim.fetchImpl
  });
  assert.equal(report.code, "malformed_account_id");
  assert.equal(sim.calls.length, 0);
});

test("a malformed target id is refused, not guessed", async () => {
  const sim = d1Sim();
  const report = await runD1StagingVerification({
    env: { ...baseEnv(), STAGING_D1_DATABASE_ID: "baaa7965c7234d42831ca9530762f726" },
    fetchImpl: sim.fetchImpl
  });
  assert.equal(report.code, "malformed_database_id");
  assert.equal(sim.calls.length, 0);
});

test("without a usable production id the guard refuses to run", async () => {
  const sim = d1Sim();
  const report = await runD1StagingVerification({
    env: { ...baseEnv(), PRODUCTION_D1_DATABASE_ID: ACCOUNT },
    fetchImpl: sim.fetchImpl
  });
  assert.equal(report.code, "production_id_unavailable");
  assert.equal(sim.calls.length, 0);
});

test("a target equal to production is refused with no request at all", async () => {
  const sim = d1Sim();
  const report = await runD1StagingVerification({
    env: { ...baseEnv(), STAGING_D1_DATABASE_ID: PRODUCTION },
    fetchImpl: sim.fetchImpl
  });
  assert.equal(report.code, "staging_is_production");
  assert.equal(sim.calls.length, 0, "production must never receive a request");
});

test("verify mode is read-only and reports the missing P1 tables", async () => {
  const sim = d1Sim({ initial: ["table:habitat_tasks"] });
  const report = await runD1StagingVerification({ env: baseEnv(), fetchImpl: sim.fetchImpl, mode: "verify" });
  assert.equal(report.ok, false);
  assert.equal(report.code, "p1_tables_missing");
  assert.equal(report.applied.length, 0);
  assert.equal(sim.calls.length, 1, "verify issues exactly one statement");
  assert.match(sim.calls[0].sql, /^SELECT/);
  assert.equal(report.after.missingP1Tables.length, P1_TABLES.length);
});

test("verify mode passes once every P1 table exists", async () => {
  const sim = d1Sim({ initial: fullSchema });
  const report = await runD1StagingVerification({ env: baseEnv(), fetchImpl: sim.fetchImpl, mode: "verify" });
  assert.equal(report.ok, true, JSON.stringify(report.after));
  assert.equal(report.after.p1TableCount, P1_TABLES.length);
  assert.equal(report.applied.length, 0);
});

test("migrate mode applies every numbered migration and then verifies", async () => {
  const sim = d1Sim({ initial: ["table:habitat_tasks"] });
  const report = await runD1StagingVerification({ env: baseEnv(), fetchImpl: sim.fetchImpl, mode: "migrate" });
  const files = migrationFiles(process.cwd());
  assert.ok(files.length >= 9, "the full migration set is present (0001-0009)");
  assert.deepEqual(report.applied, files, "every migration is applied in filename order");
  assert.equal(sim.calls.length, files.length + 2, "one call per migration, plus an inspect before and after");
  assert.equal(report.ok, true, JSON.stringify(report.after));
  assert.equal(report.after.p1TableCount, P1_TABLES.length);
});

test("a D1 error stops the run and is reported without the token", async () => {
  const report = await runD1StagingVerification({
    env: baseEnv(),
    mode: "migrate",
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: "Authentication error" }] }) })
  });
  assert.equal(report.ok, false);
  assert.equal(report.code, "d1_error");
  assert.match(report.error, /Authentication error/);
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
});

test("neither mode exposes the token or the account id in full", async () => {
  const sim = d1Sim({ initial: fullSchema });
  const report = await runD1StagingVerification({ env: baseEnv(), fetchImpl: sim.fetchImpl, mode: "verify" });
  const serialised = JSON.stringify(report);
  assert.equal(serialised.includes(TOKEN), false);
  assert.equal(serialised.includes(ACCOUNT), false, "the account id is reported only as a suffix");
  assert.equal(report.accountIdSuffix, ACCOUNT.slice(-4));
});

test("the endpoint addresses the target database, never production", async () => {
  const sim = d1Sim({ initial: fullSchema });
  await runD1StagingVerification({ env: baseEnv(), fetchImpl: sim.fetchImpl, mode: "verify" });
  assert.ok(sim.calls[0].url.includes(STAGING));
  assert.equal(sim.calls.some((call) => call.url.includes(PRODUCTION)), false);
});

test("an unknown mode is refused", async () => {
  const sim = d1Sim();
  const report = await runD1StagingVerification({ env: baseEnv(), fetchImpl: sim.fetchImpl, mode: "drop" });
  assert.equal(report.code, "mode_not_allowed");
  assert.equal(sim.calls.length, 0);
});
