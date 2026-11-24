import test from "node:test";
import assert from "node:assert/strict";
import { createD1RowQuery } from "../nexus-runtime.mjs";
import { createD1GatewayRepository } from "../d1-gateway-repository.mjs";
import { issueClientToken, resolveClientToken } from "../ax-gateway.mjs";

const ACCOUNT = "e43f2644d05e76ecbcf537d67480d607";
const DATABASE = "baaa7965-c723-4d42-831c-a9530762f726";
const TOKEN = "d1-token-not-for-output";

function d1Response(results) {
  return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results }] }) };
}

test("row query flattens every D1 result block and write responses to rows", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const { sql } = JSON.parse(options.body);
    calls.push(sql);
    if (/^CREATE/i.test(sql)) return d1Response([]);
    if (/^SELECT/i.test(sql)) return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [{ id: "a" }] }, { results: [{ id: "b" }] }] }) };
    return d1Response([]);
  };
  const query = createD1RowQuery({ accountId: ACCOUNT, databaseId: DATABASE, apiToken: TOKEN, fetchImpl });
  assert.deepEqual(await query("SELECT 1"), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(await query("CREATE TABLE x (id TEXT)"), []);
  assert.equal(JSON.stringify(calls).includes(TOKEN), false);
});

test("a gateway client created through the real D1 adapter resolves immediately", async () => {
  const clients = new Map();
  const fetchImpl = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    if (/^CREATE/i.test(sql)) return d1Response([]);
    if (/^INSERT INTO habitat_ax_gateway_clients/i.test(sql)) {
      const [id, label, tokenHash, scopes, createdAt, expiresAt] = params;
      clients.set(id, { id, label, token_hash: tokenHash, scopes, created_at: createdAt, expires_at: expiresAt, revoked_at: null, last_used_at: null });
      return d1Response([]);
    }
    if (/^SELECT \* FROM habitat_ax_gateway_clients WHERE id/i.test(sql)) return d1Response([clients.get(params[0])].filter(Boolean));
    if (/^UPDATE habitat_ax_gateway_clients SET last_used_at/i.test(sql)) return d1Response([]);
    return d1Response([]);
  };
  const repository = createD1GatewayRepository({ accountId: ACCOUNT, databaseId: DATABASE, apiToken: TOKEN, fetchImpl });
  const issued = await issueClientToken({ repository, label: "row adapter", scopes: ["mcp:events"] });
  assert.equal(issued.ok, true);
  const resolved = await resolveClientToken({ repository, authorization: "Bearer " + issued.token, scope: "mcp:events" });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.client.scopes.includes("mcp:events"), true);
  const rejected = await resolveClientToken({ repository, authorization: "Bearer " + issued.token.slice(0, -4) + "xxxx", scope: "mcp:events" });
  assert.equal(rejected.code, "gateway_token_invalid");
});
