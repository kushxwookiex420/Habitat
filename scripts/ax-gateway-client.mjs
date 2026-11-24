#!/usr/bin/env node
/**
 * Gateway client administration. This is the only way a token is minted or revoked: there is no HTTP
 * route that creates credentials, so a compromised client cannot mint peers.
 *
 * Usage (staging D1 only):
 *   node scripts/ax-gateway-client.mjs create --label "ChatGPT" --scopes status:read,missions:read,missions:write
 *   node scripts/ax-gateway-client.mjs list
 *   node scripts/ax-gateway-client.mjs revoke --id gw-abc123
 *
 * Requires CLOUDFLARE_ACCOUNT_ID, HABITAT_D1_DATABASE_ID, HABITAT_D1_API_TOKEN.
 * The token is printed once. It is never stored in plaintext and cannot be recovered later.
 */

import { createD1GatewayRepository } from "../d1-gateway-repository.mjs";
import { GATEWAY_SCOPES, issueClientToken } from "../ax-gateway.mjs";

const env = process.env;
const required = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"];
const missing = required.filter(key => !String(env[key] || "").trim());
if (missing.length) {
  console.log(JSON.stringify({ ok: false, code: "d1_binding_incomplete", missingConfiguration: missing }, null, 2));
  process.exit(1);
}

const argv = process.argv.slice(2);
const command = argv[0];
function flag(name, fallback = null) {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : fallback;
}

const repository = createD1GatewayRepository({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: env.HABITAT_D1_DATABASE_ID,
  apiToken: env.HABITAT_D1_API_TOKEN
});

const schema = await repository.verifySchema().catch(error => ({ ok: false, missing: [String(error?.message || error)] }));
if (!schema.ok) {
  console.log(JSON.stringify({ ok: false, code: "gateway_schema_missing", migration: "0012_ax_gateway", missing: schema.missing || [] }, null, 2));
  process.exit(1);
}

if (command === "create") {
  const scopes = String(flag("scopes", "status:read,missions:read") || "").split(",").map(item => item.trim()).filter(Boolean);
  if (!scopes.every(scope => GATEWAY_SCOPES.includes(scope))) {
    console.log(JSON.stringify({ ok: false, code: "scope_unknown", allowed: GATEWAY_SCOPES }, null, 2));
    process.exit(1);
  }
  const issued = await issueClientToken({ repository, label: flag("label", "ChatGPT"), scopes, expiresAt: flag("expires") });
  console.log(JSON.stringify(issued, null, 2));
} else if (command === "list") {
  const clients = await repository.listClients();
  console.log(JSON.stringify({
    ok: true,
    clients: clients.map(client => ({
      id: client.id, label: client.label, scopes: client.scopes,
      createdAt: client.createdAt, expiresAt: client.expiresAt, revoked: Boolean(client.revokedAt), lastUsedAt: client.lastUsedAt
    }))
  }, null, 2));
} else if (command === "revoke") {
  const id = flag("id");
  if (!id) {
    console.log(JSON.stringify({ ok: false, code: "client_id_required" }, null, 2));
    process.exit(1);
  }
  const revoked = await repository.revokeClient(id, { reason: flag("reason") });
  console.log(JSON.stringify({ ...revoked, clientId: id }, null, 2));
  if (!revoked.ok) process.exit(1);
} else {
  console.log(JSON.stringify({ ok: false, code: "command_unknown", allowed: ["create", "list", "revoke"] }, null, 2));
  process.exit(1);
}
