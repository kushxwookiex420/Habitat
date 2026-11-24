/**
 * Staging isolation guard.
 *
 * A staging service must never read or write the production database, even when an operator copies an
 * environment block by mistake. This module is a deny-list, not an authorization system: it refuses a
 * recognised production database id only when the process is explicitly marked as staging, so a
 * production deployment that never sets `HABITAT_ENVIRONMENT` keeps its existing behavior.
 *
 * The id below is already public in the isolation tests and in the staging documentation. It is not a
 * credential; the D1 API token is what grants access, and that stays in the environment.
 */

export const STAGING_ENVIRONMENT_VALUE = "staging";
export const STAGING_ENVIRONMENT_ENV = "HABITAT_ENVIRONMENT";
export const PRODUCTION_D1_DATABASE_ID = "3a906029-bc64-4e2a-b648-163e34a2d502";

export function stagingEnvironment(env = process.env) {
  return String(env?.[STAGING_ENVIRONMENT_ENV] || "").trim().toLowerCase() === STAGING_ENVIRONMENT_VALUE;
}

/**
 * Decide whether the configured database may be used by this process.
 *
 * - no database id: allowed here; the caller's own "binding incomplete" path handles it.
 * - staging marked + production id: refused, so the process must not serve against production data.
 * - anything else: allowed.
 */
export function databaseAllowed({ env = process.env, databaseId = "" } = {}) {
  const id = String(databaseId || "").trim().toLowerCase();
  if (!id) return { ok: true, reason: "no_database_configured" };
  if (stagingEnvironment(env) && id === PRODUCTION_D1_DATABASE_ID) {
    return { ok: false, reason: "staging_points_at_production_database" };
  }
  return { ok: true, reason: "allowed" };
}
