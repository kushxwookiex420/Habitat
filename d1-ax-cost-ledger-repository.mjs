import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Durable cost ledger storage for the governor.
 *
 * The governor calls `transact(day, mutator)`. This store reads the day's `state_json`, lets the
 * mutator produce the next state, then writes it with a compare-and-swap:
 *
 *   UPDATE ... WHERE day = ? AND state_json = ? RETURNING day
 *
 * A losing writer gets zero rows and retries against the fresh state. That is what makes the daily
 * ceiling hold across two Render instances or a restart, not just within one event loop.
 *
 * `query` may be injected (tests use SQLite); otherwise it is created from D1 credentials. The table
 * is created idempotently on first use, and migration 0007 declares the same schema for operators.
 */

function rows(result) {
  return Array.isArray(result) ? result[0]?.results || [] : [];
}

export function createD1CostLedgerStore({ accountId, databaseId, apiToken, fetchImpl = fetch, query = null, now = () => new Date().toISOString() } = {}) {
  const runQuery = query || createD1Query({ accountId, databaseId, apiToken, fetchImpl });
  let initializing = null;

  async function ensure() {
    if (!initializing) {
      initializing = (async () => {
        await runQuery("CREATE TABLE IF NOT EXISTS habitat_ax_cost_ledger (day TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
        await runQuery("CREATE INDEX IF NOT EXISTS habitat_ax_cost_ledger_updated_at ON habitat_ax_cost_ledger(updated_at DESC)");
        return { ok: true };
      })().catch(error => {
        initializing = null;
        throw error;
      });
    }
    return initializing;
  }

  async function read(day) {
    await ensure();
    const result = await runQuery("SELECT state_json FROM habitat_ax_cost_ledger WHERE day = ? LIMIT 1", [String(day)]);
    const json = rows(result)[0]?.state_json || null;
    if (!json) return null;
    try { return JSON.parse(json); } catch { return null; }
  }

  async function transact(day, mutator) {
    await ensure();
    const key = String(day);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const readResult = await runQuery("SELECT state_json FROM habitat_ax_cost_ledger WHERE day = ? LIMIT 1", [key]);
      const currentJson = rows(readResult)[0]?.state_json || null;
      let current = null;
      if (currentJson) {
        try { current = JSON.parse(currentJson); } catch { current = null; }
      }
      const { state, result } = mutator(current);
      const nextJson = JSON.stringify(state);
      if (currentJson === null) {
        const inserted = await runQuery(
          "INSERT INTO habitat_ax_cost_ledger (day, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(day) DO NOTHING RETURNING day",
          [key, nextJson, now()]
        );
        if (rows(inserted).length === 1) return result;
      } else {
        const updated = await runQuery(
          "UPDATE habitat_ax_cost_ledger SET state_json = ?, updated_at = ? WHERE day = ? AND state_json = ? RETURNING day",
          [nextJson, now(), key, currentJson]
        );
        if (rows(updated).length === 1) return result;
      }
      // Another writer won the race. Re-read and re-apply on the fresh state.
    }
    throw new Error("cost_ledger_conflict");
  }

  return Object.freeze({
    adapter: query ? "sql" : "cloudflare-d1",
    durable: true,
    table: "habitat_ax_cost_ledger",
    initialize: ensure,
    read,
    transact
  });
}

/** Build the store only when all D1 credentials exist; otherwise the caller keeps the memory store. */
export function createD1CostLedgerStoreFromEnv(env = process.env, { fetchImpl = fetch } = {}) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const databaseId = String(env.HABITAT_D1_DATABASE_ID || "").trim();
  const apiToken = String(env.HABITAT_D1_API_TOKEN || "").trim();
  if (!accountId || !databaseId || !apiToken) return null;
  return createD1CostLedgerStore({ accountId, databaseId, apiToken, fetchImpl });
}
