/**
 * Runtime environment identity and production-database isolation.
 *
 * Both server.mjs and the device command bridge read these helpers, so the service, the health
 * endpoint, and the diagnostics endpoint can never disagree about which environment they are.
 *
 * The rules are deliberately conservative:
 * - An explicit HABITAT_RUNTIME_ENV of "production" or "nonproduction" is authoritative.
 * - Without it, NODE_ENV=production is treated as production (fail-safe), never as nonproduction.
 * - "production D1 conflict" means this process is configured with the exact database id declared
 *   as production.
 * - "production database undeclared" means a nonproduction process holds D1 credentials without a
 *   declared production id, so production isolation cannot be proven. That is treated exactly like
 *   a conflict: durable storage is refused and the credentials are sealed.
 */

export const PRODUCTION = "production";
export const NONPRODUCTION = "nonproduction";

export function resolveRuntimeEnvironment(env = process.env) {
  const configured = String(env.HABITAT_RUNTIME_ENV || "").trim().toLowerCase();
  if (configured === PRODUCTION || configured === NONPRODUCTION) return configured;
  const nodeEnvironment = String(env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnvironment === "production" ? PRODUCTION : NONPRODUCTION;
}

export function inspectD1Isolation(env = process.env) {
  const productionDatabaseId = String(env.HABITAT_PRODUCTION_D1_DATABASE_ID || "").trim();
  const configuredDatabaseId = String(env.HABITAT_D1_DATABASE_ID || "").trim();
  return {
    productionDatabaseId,
    configuredDatabaseId,
    productionDatabaseConfigured: Boolean(productionDatabaseId),
    databaseConfigured: Boolean(configuredDatabaseId),
    productionD1Conflict: Boolean(productionDatabaseId && configuredDatabaseId === productionDatabaseId)
  };
}

/**
 * Full isolation state for a process.
 *
 * `unsafe` is true when a nonproduction process must not be allowed to keep D1 credentials:
 * either it names the production database, or it has a database but no declared production id to
 * compare against. A production process is never unsafe on these grounds.
 */
export function inspectIsolation(env = process.env) {
  const runtime = resolveRuntimeEnvironment(env);
  const d1 = inspectD1Isolation(env);
  const production = runtime === PRODUCTION;
  const productionDatabaseUndeclared = Boolean(
    !production && d1.databaseConfigured && !d1.productionDatabaseConfigured
  );
  return {
    runtime,
    production,
    ...d1,
    productionDatabaseUndeclared,
    unsafe: !production && (d1.productionD1Conflict || productionDatabaseUndeclared)
  };
}

export function serviceName(env = process.env) {
  return String(env.HABITAT_SERVICE_NAME || "").trim() || "habitat";
}

/**
 * A nonproduction process may not hold production D1 credentials at all. Removing them from the
 * process environment is the only enforcement that also covers repositories created later
 * (tasks, content jobs, secret vault, Nexus), not just the ones constructed at startup.
 *
 * Returns true when credentials were sealed.
 */
export function sealProductionD1(env = process.env) {
  if (!inspectIsolation(env).unsafe) return false;
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]) {
    delete env[key];
  }
  return true;
}
