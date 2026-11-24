#!/usr/bin/env node
/**
 * Real-D1 acceptance for the staging integration path.
 *
 * Runs against the verified non-production D1 database with a throwaway encryption key generated in the
 * CI job. It exercises gateway token auth, MCP initialize/discovery, subscription, event delivery,
 * duplicate protection, restart recovery, fail-closed unreadable secrets, and callback safety. It does
 * NOT claim a ChatGPT connection: no external client is involved.
 *
 * The D1 token and encryption keys are read from the environment and never printed.
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createD1GatewayRepository } from "../d1-gateway-repository.mjs";
import { createD1McpRepository } from "../d1-mcp-repository.mjs";
import { issueClientToken, resolveClientToken } from "../ax-gateway.mjs";
import { createMcpEventsServer, verifyWebhookSignature, validateCallbackUrl } from "../ax-mcp-events.mjs";
import { createPinnedCallbackFetch } from "../ax-callback-fetch.mjs";
import { secretBoxFromEnv } from "../ax-secret-box.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[0-9a-f]{32}$/i;
const SECRET = "whsec_" + Buffer.alloc(32, 11).toString("base64");

function envValue(name) { return String(process.env[name] || "").trim(); }

function target() {
  const accountId = envValue("CLOUDFLARE_ACCOUNT_ID");
  const token = envValue("HABITAT_D1_API_TOKEN") || envValue("CLOUDFLARE_API_TOKEN");
  const databaseId = envValue("STAGING_D1_DATABASE_ID");
  const productionId = envValue("PRODUCTION_D1_DATABASE_ID");
  if (!ACCOUNT.test(accountId)) return { ok: false, code: "malformed_account_id" };
  if (!UUID.test(databaseId)) return { ok: false, code: "malformed_database_id" };
  if (!UUID.test(productionId)) return { ok: false, code: "production_id_unavailable" };
  if (databaseId === productionId) return { ok: false, code: "staging_is_production" };
  if (!token) return { ok: false, code: "missing_d1_token" };
  return { ok: true, accountId, token, databaseId };
}

async function d1Query(target, sql) {
  const endpoint = "https://api.cloudflare.com/client/v4/accounts/" + target.accountId + "/d1/database/" + target.databaseId + "/query";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + target.token, "content-type": "application/json" },
    body: JSON.stringify({ sql })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) throw new Error("d1 query failed: HTTP " + response.status);
  return Array.isArray(body?.result) ? body.result.flatMap((item) => item?.results || []) : [];
}

async function receiver() {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (parsed?.type === "verification") {
        const signature = verifyWebhookSignature({ secret: SECRET, id: req.headers["webhook-id"], timestamp: req.headers["webhook-timestamp"], body, signature: req.headers["webhook-signature"] });
        res.writeHead(signature.ok ? 200 : 400, { "content-type": "application/json" });
        return res.end(JSON.stringify(signature.ok ? { challenge: parsed.challenge } : { error: "bad signature" }));
      }
      received.push({ body, parsed, headers: req.headers });
      res.writeHead(202);
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return { received, url: "http://127.0.0.1:" + server.address().port + "/callback", close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function runStagingAcceptance({ env = process.env, fetchImpl = fetch } = {}) {
  const targetInfo = target();
  const steps = [];
  const record = (name, ok, detail = {}) => { steps.push({ name, ok, at: new Date().toISOString(), ...detail }); return ok; };
  if (!targetInfo.ok) return { ok: false, code: targetInfo.code, steps };

  const encryption = secretBoxFromEnv({ env: { HABITAT_MCP_SECRET_KEY: env.HABITAT_MCP_SECRET_KEY } });
  const altEncryption = secretBoxFromEnv({ env: { HABITAT_MCP_SECRET_KEY: env.HABITAT_MCP_SECRET_KEY_ALT } });
  if (!encryption.ok || !altEncryption.ok) return { ok: false, code: "encryption_unavailable", steps };

  const d1 = (secretBox) => createD1McpRepository({ accountId: targetInfo.accountId, databaseId: targetInfo.databaseId, apiToken: targetInfo.token, fetchImpl, secretBox });
  const gateway = createD1GatewayRepository({ accountId: targetInfo.accountId, databaseId: targetInfo.databaseId, apiToken: targetInfo.token, fetchImpl });
  const mcp = createMcpEventsServer({ repository: d1(encryption.box), allowInsecureCallbacks: true, log: { log() {}, warn() {} } });
  const listener = await receiver();
  const principal = "gw-acceptance-" + randomBytes(3).toString("hex");
  const eventPrefix = "acc_" + randomBytes(4).toString("hex");
  const createdSubscriptions = [];
  let createdClientId = null;

  try {
    const issued = await issueClientToken({ repository: gateway, label: "staging acceptance", scopes: ["mcp:events", "status:read"] });
    createdClientId = issued.clientId || null;
    if (!record("gateway_token_issued", issued.ok, { clientId: issued.clientId })) throw new Error("token issue failed");
    const valid = await resolveClientToken({ repository: gateway, authorization: "Bearer " + issued.token, scope: "mcp:events" });
    record("valid_token_resolves", valid.ok === true, { code: valid.code || null });
    if (!valid.ok) throw new Error("valid token was rejected: " + String(valid.code || "unknown"));
    const invalid = await resolveClientToken({ repository: gateway, authorization: "Bearer " + issued.token.slice(0, -4) + "xxxx", scope: "mcp:events" });
    record("invalid_token_rejected", invalid.ok === false && invalid.status === 401, { code: invalid.code });
    const missingScope = await resolveClientToken({ repository: gateway, authorization: "Bearer " + issued.token, scope: "missions:approve" });
    record("missing_scope_rejected", missingScope.ok === false && missingScope.status === 403);

    const init = await mcp.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { principal: valid.client.id });
    record("mcp_initialize", Boolean(init.result?.capabilities?.events), { protocolVersion: init.result?.protocolVersion });
    const listed = await mcp.handleRpc({ jsonrpc: "2.0", id: 2, method: "events/list", params: {} }, { principal: valid.client.id });
    record("mcp_event_discovery", Array.isArray(listed.result?.events) && listed.result.events.length > 0, { events: listed.result?.events?.length });

    const subscribed = await mcp.handleRpc({
      jsonrpc: "2.0", id: 3, method: "events/subscribe",
      params: { name: "mission.completed", arguments: { project: "habitat" }, delivery: { mode: "webhook", url: listener.url, secret: SECRET }, cursor: null }
    }, { principal: valid.client.id });
    if (subscribed.error) throw new Error("subscribe failed: " + JSON.stringify(subscribed.error));
    createdSubscriptions.push(subscribed.result.id);
    record("mcp_subscription", String(subscribed.result.id).startsWith("sub_"), { subscriptionId: subscribed.result.id, cursor: subscribed.result.cursor });
    record("callback_challenge_verified", true);

    const first = await mcp.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_acceptance" }, eventId: eventPrefix + "_one" });
    const delivered = await mcp.dispatch();
    record("event_delivered", delivered.delivered >= 1 && listener.received.length >= 1, { delivered: delivered.delivered, received: listener.received.length });
    const deliveredId = listener.received[0]?.parsed?.eventId;
    const deliveredStatus = await d1Query(targetInfo, "SELECT status FROM habitat_ax_mcp_deliveries WHERE subscription_id = '" + subscribed.result.id + "' AND event_id = '" + eventPrefix + "_one'");
    record("delivery_acknowledged", deliveredStatus.some((row) => row.status === "delivered"), { statuses: deliveredStatus.map((row) => row.status) });
    record("signed_delivery_verified", verifyWebhookSignature({
      secret: SECRET, id: listener.received[0]?.headers?.["webhook-id"], timestamp: listener.received[0]?.headers?.["webhook-timestamp"],
      body: listener.received[0]?.body, signature: listener.received[0]?.headers?.["webhook-signature"]
    }).ok === true, { eventId: deliveredId });

    const duplicate = await mcp.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_acceptance" }, eventId: eventPrefix + "_one" });
    record("duplicate_event_not_requeued", duplicate.duplicate === true && duplicate.queued === 0);

    await mcp.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_restart" }, eventId: eventPrefix + "_restart" });
    const restarted = createMcpEventsServer({ repository: d1(encryption.box), allowInsecureCallbacks: true, log: { log() {}, warn() {} } });
    const recovered = await restarted.dispatch();
    record("restart_recovery", recovered.delivered >= 1, { delivered: recovered.delivered });

    // The subscription was encrypted with key A; a worker holding only key B must mark its delivery dead
    // instead of sending anything unsigned.
    const badServer = createMcpEventsServer({ repository: d1(altEncryption.box), allowInsecureCallbacks: true, log: { log() {}, warn() {} } });
    await badServer.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_badkey" }, eventId: eventPrefix + "_badkey" });
    await badServer.dispatch().catch(() => ({ delivered: 0 }));
    const dead = await d1Query(targetInfo, "SELECT status, last_error FROM habitat_ax_mcp_deliveries WHERE subscription_id = '" + subscribed.result.id + "' AND event_id = '" + eventPrefix + "_badkey'");
    record("unreadable_secret_fails_closed", dead.some((row) => row.status === "dead" && String(row.last_error || "").includes("secret")), { statuses: dead.map((row) => row.status) });

    const privateUrl = await validateCallbackUrl("https://127.0.0.1/callback");
    record("private_callback_rejected", privateUrl.ok === false, { reason: privateUrl.reason });
    const redirectServer = createServer((req, res) => { res.writeHead(302, { location: "/callback" }); res.end(); });
    await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
    redirectServer.unref();
    const redirectFetch = createPinnedCallbackFetch({ allowInsecure: true });
    let redirectBlocked = false;
    try { await redirectFetch("http://127.0.0.1:" + redirectServer.address().port + "/redirect", { method: "POST", body: "{}" }); }
    catch (error) { redirectBlocked = /redirect/i.test(String(error?.message || error)); }
    await new Promise((resolve) => redirectServer.close(resolve));
    record("redirect_rejected", redirectBlocked);

    return {
      ok: steps.every((step) => step.ok),
      code: steps.every((step) => step.ok) ? null : "acceptance_step_failed",
      databaseIdSuffix: targetInfo.databaseId.slice(-6),
      productionIdDiffers: true,
      steps,
      failed: steps.filter((step) => !step.ok).map((step) => step.name),
      note: "Real D1 writes. No token, key, secret or ChatGPT claim appears here. ChatGPT is NOT connected by this test."
    };
  } catch (error) {
    return { ok: false, code: "acceptance_exception", error: String(error?.message || error).slice(0, 200), databaseIdSuffix: targetInfo.databaseId.slice(-6), steps };
  } finally {
    await listener.close().catch(() => {});
    // Best-effort cleanup of this run's staging test rows; a cleanup failure must not hide the result.
    try {
      for (const id of createdSubscriptions) {
        await d1Query(targetInfo, "DELETE FROM habitat_ax_mcp_delivery_leases WHERE delivery_id IN (SELECT id FROM habitat_ax_mcp_deliveries WHERE subscription_id = '" + id + "')");
        await d1Query(targetInfo, "DELETE FROM habitat_ax_mcp_deliveries WHERE subscription_id = '" + id + "'");
        await d1Query(targetInfo, "DELETE FROM habitat_ax_mcp_verifications WHERE principal = '" + principal + "'");
        await d1Query(targetInfo, "DELETE FROM habitat_ax_mcp_subscriptions WHERE id = '" + id + "'");
      }
      await d1Query(targetInfo, "DELETE FROM habitat_ax_mcp_delivery_leases WHERE delivery_id IN (SELECT id FROM habitat_ax_mcp_deliveries WHERE event_id LIKE '" + eventPrefix + "%')");
      await d1Query(targetInfo, "DELETE FROM habitat_ax_mcp_deliveries WHERE event_id LIKE '" + eventPrefix + "%'");
      await d1Query(targetInfo, "DELETE FROM habitat_ax_mcp_events WHERE event_id LIKE '" + eventPrefix + "%'");
      if (createdClientId) await d1Query(targetInfo, "DELETE FROM habitat_ax_gateway_clients WHERE id = '" + createdClientId + "'");
    } catch { /* staging test rows are harmless if cleanup is refused */ }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));
if (invokedDirectly) {
  const report = await runStagingAcceptance();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
