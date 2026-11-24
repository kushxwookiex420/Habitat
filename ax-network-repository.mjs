import { createD1Query } from "./nexus-runtime.mjs";

/**
 * Storage for the capability network.
 *
 * Every table keeps its queryable columns beside a `record_json` document, matching the pattern the
 * rest of Habitat already uses. Table and column names are literals defined here, never built from
 * input, so no caller can name a table or a column.
 *
 * Two adapters share one interface: memory for a process with no D1 credentials, and D1 for a
 * durable deployment. `durable: false` is reported, never hidden.
 */

function rowsOf(result) {
  return Array.isArray(result) ? result[0]?.results || [] : [];
}

function decode(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const DEFINITIONS = Object.freeze({
  capabilities: Object.freeze({
    name: "habitat_ax_capabilities",
    columns: Object.freeze(["id", "kind", "state", "requires_approval", "record_json", "updated_at"]),
    filters: Object.freeze({ kind: "kind", state: "state" }),
    orderBy: "updated_at",
    project: record => ({
      id: record.id,
      kind: record.kind,
      state: record.state,
      requires_approval: record.requiresApproval ? 1 : 0,
      record_json: JSON.stringify(record),
      updated_at: record.updatedAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_capabilities (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 0, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_capabilities_kind ON habitat_ax_capabilities(kind)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_capabilities_state ON habitat_ax_capabilities(state)"
    ])
  }),
  approvals: Object.freeze({
    name: "habitat_ax_access_requests",
    columns: Object.freeze([
      "id", "kind", "capability_id", "status", "fingerprint", "amount_cents", "currency",
      "requested_at", "quote_expires_at", "expires_at", "decided_at", "decided_by",
      "consumed_at", "record_json", "updated_at"
    ]),
    filters: Object.freeze({ status: "status", kind: "kind" }),
    // Approval transitions are compare-and-swap on status, so two concurrent decisions cannot both
    // win and a consumed approval cannot be overwritten by a stale writer.
    casColumn: "status",
    orderBy: "updated_at",
    project: record => ({
      id: record.id,
      kind: record.kind,
      capability_id: record.capabilityId ?? null,
      status: record.status,
      fingerprint: record.fingerprint,
      amount_cents: Number(record.amountCents) || 0,
      currency: record.currency ?? null,
      requested_at: record.requestedAt,
      quote_expires_at: record.quoteExpiresAt ?? null,
      expires_at: record.expiresAt,
      decided_at: record.decidedAt ?? null,
      decided_by: record.decidedBy ?? null,
      consumed_at: record.consumedAt ?? null,
      record_json: JSON.stringify(record),
      updated_at: record.updatedAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_access_requests (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, capability_id TEXT, status TEXT NOT NULL, fingerprint TEXT NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT, requested_at TEXT NOT NULL, quote_expires_at TEXT, expires_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, consumed_at TEXT, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_access_requests_status ON habitat_ax_access_requests(status, updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_access_requests_kind ON habitat_ax_access_requests(kind, updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_access_requests_fingerprint ON habitat_ax_access_requests(fingerprint)"
    ])
  }),
  suppliers: Object.freeze({
    name: "habitat_ax_suppliers",
    columns: Object.freeze(["id", "layer", "order_model", "status", "record_json", "updated_at"]),
    filters: Object.freeze({ layer: "layer", order_model: "order_model", status: "status" }),
    orderBy: "updated_at",
    project: record => ({
      id: record.id,
      layer: record.layer,
      order_model: record.orderModel,
      status: record.status,
      record_json: JSON.stringify(record),
      updated_at: record.updatedAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_suppliers (id TEXT PRIMARY KEY NOT NULL, layer TEXT NOT NULL, order_model TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_suppliers_layer ON habitat_ax_suppliers(layer, status)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_suppliers_order_model ON habitat_ax_suppliers(order_model)"
    ])
  }),
  offers: Object.freeze({
    name: "habitat_ax_supplier_offers",
    columns: Object.freeze(["id", "supplier_id", "sku", "status", "record_json", "updated_at"]),
    filters: Object.freeze({ supplier_id: "supplier_id", status: "status" }),
    orderBy: "updated_at",
    project: record => ({
      id: record.id,
      supplier_id: record.supplierId,
      sku: record.sku ?? null,
      status: record.status,
      record_json: JSON.stringify(record),
      updated_at: record.updatedAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_supplier_offers (id TEXT PRIMARY KEY NOT NULL, supplier_id TEXT NOT NULL, sku TEXT, status TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_supplier_offers_supplier ON habitat_ax_supplier_offers(supplier_id, status)"
    ])
  }),
  channels: Object.freeze({
    name: "habitat_ax_channel_rules",
    columns: Object.freeze(["id", "channel", "decision", "record_json", "updated_at"]),
    filters: Object.freeze({ channel: "channel", decision: "decision" }),
    orderBy: "updated_at",
    project: record => ({
      id: record.id,
      channel: record.channel,
      decision: record.decision,
      record_json: JSON.stringify(record),
      updated_at: record.updatedAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_channel_rules (id TEXT PRIMARY KEY NOT NULL, channel TEXT NOT NULL, decision TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_channel_rules_channel ON habitat_ax_channel_rules(channel, decision)"
    ])
  }),
  revenueEvents: Object.freeze({
    name: "habitat_ax_revenue_events",
    columns: Object.freeze(["id", "state", "currency", "amount_cents", "occurred_at", "record_json", "created_at"]),
    filters: Object.freeze({ state: "state", currency: "currency" }),
    orderBy: "occurred_at",
    project: record => ({
      id: record.id,
      state: record.state,
      currency: record.currency,
      amount_cents: record.amountCents,
      occurred_at: record.occurredAt,
      record_json: JSON.stringify(record),
      created_at: record.createdAt || record.occurredAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_revenue_events (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, currency TEXT NOT NULL, amount_cents INTEGER NOT NULL, occurred_at TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_revenue_events_state ON habitat_ax_revenue_events(state, occurred_at DESC)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_revenue_events_currency ON habitat_ax_revenue_events(currency, occurred_at DESC)"
    ])
  }),
  payouts: Object.freeze({
    name: "habitat_ax_payouts",
    columns: Object.freeze(["id", "state", "currency", "amount_cents", "record_json", "updated_at"]),
    filters: Object.freeze({ state: "state", currency: "currency" }),
    orderBy: "updated_at",
    project: record => ({
      id: record.id,
      state: record.state,
      currency: record.currency,
      amount_cents: record.amountCents,
      record_json: JSON.stringify(record),
      updated_at: record.updatedAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_payouts (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, currency TEXT NOT NULL, amount_cents INTEGER NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_payouts_state ON habitat_ax_payouts(state, updated_at DESC)"
    ])
  }),
  accounts: Object.freeze({
    name: "habitat_ax_treasury_accounts",
    columns: Object.freeze(["id", "kind", "status", "record_json", "updated_at"]),
    filters: Object.freeze({ kind: "kind", status: "status" }),
    orderBy: "updated_at",
    project: record => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      record_json: JSON.stringify(record),
      updated_at: record.updatedAt
    }),
    create: Object.freeze([
      "CREATE TABLE IF NOT EXISTS habitat_ax_treasury_accounts (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS habitat_ax_treasury_accounts_kind ON habitat_ax_treasury_accounts(kind, status)"
    ])
  })
});

function clampLimit(value, fallback = 200, max = 5000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function memoryStore(definition) {
  const records = new Map();
  return Object.freeze({
    adapter: "memory",
    durable: false,
    table: definition.name,
    async put(record) {
      if (!record || typeof record.id !== "string" || !record.id.trim()) throw new Error("A " + definition.name + " row needs an id.");
      records.set(record.id, structuredClone(record));
      return structuredClone(record);
    },
    async get(id) {
      const found = records.get(String(id));
      return found ? structuredClone(found) : null;
    },
    async list({ limit = 200, ...criteria } = {}) {
      const result = [...records.values()]
        .filter(record => Object.entries(criteria).every(([key, value]) => value === null || value === undefined || String(record[key] ?? "") === String(value)))
        .sort((left, right) => String(right[definition.orderBy] ?? "").localeCompare(String(left[definition.orderBy] ?? "")))
        .slice(0, clampLimit(limit));
      return result.map(item => structuredClone(item));
    },
    ...(definition.casColumn ? {
      async transition(id, { expectStatus = null, next = null } = {}) {
        const current = records.get(String(id));
        if (!current || !next) return null;
        if (String(current[definition.casColumn]) !== String(expectStatus)) return null;
        if (String(next.id) !== String(id)) return null;
        records.set(String(id), structuredClone(next));
        return structuredClone(next);
      }
    } : {})
  });
}

function d1Store(definition, query) {
  const columns = definition.columns;
  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns.filter(column => column !== "id").map(column => column + " = excluded." + column).join(", ");
  const upsertSql = "INSERT INTO " + definition.name + " (" + columns.join(", ") + ") VALUES (" + placeholders + ") ON CONFLICT(id) DO UPDATE SET " + updates;

  return Object.freeze({
    adapter: "cloudflare-d1",
    durable: true,
    table: definition.name,
    async put(record) {
      if (!record || typeof record.id !== "string" || !record.id.trim()) throw new Error("A " + definition.name + " row needs an id.");
      const projected = definition.project(record);
      await query(upsertSql, columns.map(column => projected[column] ?? null));
      return structuredClone(record);
    },
    async get(id) {
      const result = await query("SELECT record_json FROM " + definition.name + " WHERE id = ? LIMIT 1", [String(id)]);
      return decode(rowsOf(result)[0]?.record_json);
    },
    async list({ limit = 200, ...criteria } = {}) {
      const clauses = [];
      const params = [];
      for (const [key, value] of Object.entries(criteria)) {
        const column = definition.filters[key];
        if (!column || value === null || value === undefined) continue;
        clauses.push(column + " = ?");
        params.push(String(value));
      }
      params.push(clampLimit(limit));
      const result = await query(
        "SELECT record_json FROM " + definition.name +
        (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
        " ORDER BY " + definition.orderBy + " DESC LIMIT ?",
        params
      );
      return rowsOf(result).map(row => decode(row.record_json)).filter(Boolean);
    },
    ...(definition.casColumn ? {
      async transition(id, { expectStatus = null, next = null } = {}) {
        if (!next || String(next.id) !== String(id)) return null;
        const projected = definition.project(next);
        const mutable = columns.filter(column => column !== "id");
        const sql = "UPDATE " + definition.name + " SET " + mutable.map(column => column + " = ?").join(", ") +
          " WHERE id = ? AND " + definition.casColumn + " = ? RETURNING id";
        const params = mutable.map(column => projected[column] ?? null).concat([String(id), String(expectStatus)]);
        const result = await query(sql, params);
        if (rowsOf(result).length !== 1) return null;
        return structuredClone(next);
      }
    } : {})
  });
}

function buildRepository({ query = null, durable = false }) {
  const stores = {};
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    stores[key] = query ? d1Store(definition, query) : memoryStore(definition);
  }
  let initializing = null;

  return Object.freeze({
    adapter: durable ? "cloudflare-d1" : "memory",
    durable,
    tables: Object.keys(DEFINITIONS).map(key => DEFINITIONS[key].name),
    ...stores,
    initialize() {
      if (!query) return Promise.resolve({ ok: true, adapter: "memory" });
      if (!initializing) {
        initializing = (async () => {
          for (const definition of Object.values(DEFINITIONS)) {
            for (const statement of definition.create) await query(statement);
          }
          return { ok: true, adapter: "cloudflare-d1" };
        })().catch(error => {
          initializing = null;
          throw error;
        });
      }
      return initializing;
    }
  });
}

export function createMemoryNetworkRepository() {
  return buildRepository({ query: null, durable: false });
}

export function createD1NetworkRepository({ accountId, databaseId, apiToken, fetchImpl = fetch } = {}) {
  if (![accountId, databaseId, apiToken].every(value => String(value || "").trim())) {
    throw new Error("D1 network storage requires CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID and HABITAT_D1_API_TOKEN.");
  }
  return buildRepository({
    query: createD1Query({ accountId, databaseId, apiToken, fetchImpl }),
    durable: true
  });
}

/** Durable when D1 is configured; otherwise an honest in-process store. */
export function createNetworkRepositoryFromEnv(env = process.env, { fetchImpl = fetch } = {}) {
  const accountId = String(env?.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const databaseId = String(env?.HABITAT_D1_DATABASE_ID || "").trim();
  const apiToken = String(env?.HABITAT_D1_API_TOKEN || "").trim();
  if (!accountId || !databaseId || !apiToken) return createMemoryNetworkRepository();
  return createD1NetworkRepository({ accountId, databaseId, apiToken, fetchImpl });
}
