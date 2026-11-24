import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function files() {
  return (await readdir(MIGRATIONS)).filter(name => name.endsWith(".sql")).sort();
}

async function apply(db, names) {
  for (const name of names) db.exec(await readFile(path.join(MIGRATIONS, name), "utf8"));
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
}

test("migration order is numeric, unique and includes every readiness migration", async () => {
  const names = await files();
  const prefixes = names.map(name => Number(name.slice(0, 4)));
  assert.deepEqual(prefixes, [...new Set(prefixes)], "duplicate migration prefixes");
  assert.deepEqual(prefixes, [...prefixes].sort((a, b) => a - b), "migrations are not in order");
  for (const prefix of ["0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017"]) {
    assert.ok(names.some(name => name.startsWith(prefix + "_")), "missing migration " + prefix);
  }
});

test("a fresh database installs every migration with the expected tables and lease shape", async () => {
  const names = await files();
  const db = new DatabaseSync(":memory:");
  await apply(db, names);
  const present = tables(db);
  for (const table of [
    "habitat_ax_workers", "habitat_ax_missions", "habitat_ax_gateway_clients", "habitat_ax_gateway_nonces",
    "habitat_ax_gateway_audit", "habitat_ax_gateway_rate_limits", "habitat_ax_heartbeat_state",
    "habitat_ax_heartbeat_events", "habitat_ax_heartbeat_deliveries", "habitat_ax_mcp_subscriptions",
    "habitat_ax_mcp_verifications", "habitat_ax_mcp_events", "habitat_ax_mcp_deliveries",
    "habitat_ax_mcp_delivery_leases", "habitat_ax_approval_nonces"
  ]) {
    assert.ok(present.includes(table), "missing table " + table);
  }
  const nonceIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'habitat_ax_approval_nonces'").all().map(row => row.name);
  for (const name of ["habitat_ax_approval_nonces_mission", "habitat_ax_approval_nonces_approval", "habitat_ax_approval_nonces_expiry"]) {
    assert.ok(nonceIndexes.includes(name), "missing approval nonce index " + name);
  }
  const leaseColumns = db.prepare("PRAGMA table_info(habitat_ax_mcp_delivery_leases)").all().map(row => row.name);
  assert.deepEqual(leaseColumns.sort(), ["delivery_id", "expires_at", "owner"]);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.close();
});

test("uniqueness constraints protect identities, nonces, dedupe keys and deliveries", async () => {
  const db = new DatabaseSync(":memory:");
  await apply(db, await files());
  const insertClient = db.prepare("INSERT INTO habitat_ax_gateway_clients (id, label, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)");
  insertClient.run("gw-a", "A", "hash-1", "status:read", "2026-01-01T00:00:00Z");
  assert.throws(() => insertClient.run("gw-b", "B", "hash-1", "status:read", "2026-01-01T00:00:00Z"), /UNIQUE/);

  const approvalNonce = db.prepare("INSERT INTO habitat_ax_approval_nonces (nonce, key_id, mission_id, approval_id, decision, consumed_at) VALUES (?, 'k1', ?, ?, 'approve', ?)");
  approvalNonce.run("n-approval-1", "msn_a", "apr_a", "2026-01-01T00:00:00Z");
  assert.throws(() => approvalNonce.run("n-approval-1", "msn_b", "apr_b", "2026-01-01T00:00:00Z"), /UNIQUE|PRIMARY/);

  const nonce = db.prepare("INSERT INTO habitat_ax_gateway_nonces (client_id, nonce, expires_at) VALUES (?, ?, ?)");
  nonce.run("gw-a", "n1", "2026-01-01T00:00:00Z");
  assert.throws(() => nonce.run("gw-a", "n1", "2026-01-01T00:00:00Z"), /UNIQUE|PRIMARY/);

  const heartbeat = db.prepare("INSERT INTO habitat_ax_heartbeat_events (id, integration, kind, dedupe_key, priority, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)");
  heartbeat.run("evt_a", "chatgpt", "mission_status", "mission:m1:completed", 5, "{}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  assert.throws(() => heartbeat.run("evt_b", "chatgpt", "mission_status", "mission:m1:completed", 5, "{}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), /UNIQUE/);

  const subscription = db.prepare("INSERT INTO habitat_ax_mcp_subscriptions (id, principal, name, args_json, args_canonical, url, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  subscription.run("sub_a", "gw-a", "mission.completed", "{}", "{}", "https://example.com/cb", "v1:k1:x:y:z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  assert.throws(() => subscription.run("sub_b", "gw-a", "mission.completed", "{}", "{}", "https://example.com/cb", "v1:k1:x:y:z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), /UNIQUE/);

  const delivery = db.prepare("INSERT INTO habitat_ax_mcp_deliveries (id, subscription_id, event_seq, event_id, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)");
  delivery.run("dlv_a", "sub_a", 1, "evt_1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  assert.throws(() => delivery.run("dlv_b", "sub_a", 1, "evt_1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), /UNIQUE/);
  db.close();
});

test("an upgrade from 0014 preserves existing rows and adds MCP plus lease tables", async () => {
  const names = await files();
  const before = names.filter(name => Number(name.slice(0, 4)) <= 14);
  const after = names.filter(name => Number(name.slice(0, 4)) > 14);
  const db = new DatabaseSync(":memory:");
  await apply(db, before);
  db.prepare("INSERT INTO habitat_ax_gateway_clients (id, label, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)").run("gw-existing", "Existing", "hash-existing", "status:read", "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO habitat_ax_heartbeat_events (id, integration, kind, dedupe_key, priority, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)").run("evt_existing", "chatgpt", "mission_status", "existing", 5, "{}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

  await apply(db, after);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM habitat_ax_gateway_clients WHERE id = 'gw-existing'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM habitat_ax_heartbeat_events WHERE id = 'evt_existing'").get().count, 1);
  const present = tables(db);
  assert.ok(present.includes("habitat_ax_mcp_subscriptions"));
  assert.ok(present.includes("habitat_ax_mcp_delivery_leases"));

  // Re-running the full set must not fail or duplicate objects.
  await apply(db, names);
  assert.equal(tables(db).filter(name => name === "habitat_ax_mcp_delivery_leases").length, 1);
  db.close();
});
