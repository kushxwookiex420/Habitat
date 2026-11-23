import test from "node:test";
import assert from "node:assert/strict";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { createAxNetworkService } from "../ax-network-service.mjs";
import { createMemoryNetworkRepository } from "../ax-network-repository.mjs";

const BRIDGE = "axbridge_network_routes_0123456789";
const COMMAND = "axcmd_network_routes_0123456789";
const OWNER_DEVICE = "owner-phone-1";
const OWNER_TOKEN = "owner-device-token-1";

const bridgeAuth = { authorization: "Bearer " + BRIDGE };
const commandAuth = { authorization: "Bearer " + COMMAND };
const ownerHeaders = { "x-owner-device-id": OWNER_DEVICE, "x-owner-device-token": OWNER_TOKEN };
const occurredAt = "2026-11-23T10:00:00.000Z";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function matchRoute(app, key) {
  if (app.routes.has(key)) return { handlers: app.routes.get(key), params: {} };
  const [method, path] = key.split(" ");
  const parts = path.split("/").filter(Boolean);
  for (const [registered, handlers] of app.routes) {
    const [registeredMethod, registeredPath] = registered.split(" ");
    if (registeredMethod !== method) continue;
    const expected = registeredPath.split("/").filter(Boolean);
    if (expected.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < parts.length; index += 1) {
      if (expected[index].startsWith(":")) params[expected[index].slice(1)] = decodeURIComponent(parts[index]);
      else if (expected[index] !== parts[index]) { matched = false; break; }
    }
    if (matched) return { handlers, params };
  }
  return null;
}

async function invoke(app, key, req = {}) {
  const matched = matchRoute(app, key);
  assert.ok(matched, "registered route: " + key);
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; }
  };
  const request = { headers: {}, query: {}, body: {}, ...req, params: { ...matched.params, ...(req.params || {}) } };
  for (const handler of matched.handlers) {
    let advanced = false;
    await handler(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function mount({ withNetwork = true } = {}) {
  const app = makeApp();
  const network = withNetwork
    ? createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() })
    : null;
  registerUniversalCommandRoutes(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: BRIDGE, HABITAT_AX_COMMAND_TOKEN: COMMAND },
    repository: null,
    verifyDevice: async (token, deviceId) => token === OWNER_TOKEN && deviceId === OWNER_DEVICE,
    ownerDeviceIds: OWNER_DEVICE,
    networkProvider: () => network
  });
  return app;
}

const purchaseBody = {
  kind: "purchase",
  capabilityId: "fulfillment.purchase",
  vendor: "cjdropshipping",
  amountCents: 1237,
  currency: "USD",
  shippingCents: 549,
  taxCents: 0,
  items: [{ sku: "phone-case-pink", quantity: 1, unitCents: 688 }],
  destination: "US-CA",
  quoteId: "quote_routes_1",
  quoteExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
};

test("every network route answers 503 when the service is not mounted", async () => {
  const app = mount({ withNetwork: false });
  for (const key of [
    "GET /ax/command/network/status",
    "GET /ax/command/network/capabilities",
    "GET /ax/command/network/suppliers",
    "GET /ax/command/network/channels",
    "GET /ax/command/network/treasury",
    "GET /ax/command/network/approvals"
  ]) {
    const res = await invoke(app, key, { headers: bridgeAuth });
    assert.equal(res.statusCode, 503, key);
    assert.equal(res.body.code, "network_not_configured", key);
  }
});

test("the catalog, channels and treasury report are readable with the Ax credential", async () => {
  const app = mount();
  const capabilities = await invoke(app, "GET /ax/command/network/capabilities", { headers: commandAuth });
  assert.equal(capabilities.statusCode, 200);
  assert.ok(capabilities.body.count >= 15);

  const suppliers = await invoke(app, "GET /ax/command/network/suppliers", { headers: bridgeAuth });
  assert.equal(suppliers.statusCode, 200);
  assert.ok(suppliers.body.suppliers.length > 0);
  assert.equal(suppliers.body.catalog.connected, 0);

  const channels = await invoke(app, "GET /ax/command/network/channels", { headers: bridgeAuth });
  assert.equal(channels.statusCode, 200);
  assert.equal(channels.body.automatedApproval, false);

  const treasury = await invoke(app, "GET /ax/command/network/treasury", { headers: bridgeAuth });
  assert.equal(treasury.statusCode, 200);
  assert.equal(treasury.body.cashBasis, "settled_and_available_only");
  assert.equal(treasury.body.primary.cashCents, 0);
});

test("the Ax command token can request an approval but never decide one", async () => {
  const app = mount();
  const created = await invoke(app, "POST /ax/command/network/approvals", { headers: bridgeAuth, body: purchaseBody });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.approval.status, "requested");
  assert.match(created.body.approval.requestedBy, /^ax:/);
  const id = created.body.approval.id;

  const commandDecision = await invoke(app, "POST /ax/command/network/approvals/" + id + "/approve", {
    headers: { ...commandAuth, ...ownerHeaders },
    body: {}
  });
  assert.equal(commandDecision.statusCode, 403);
  assert.equal(commandDecision.body.code, "command_token_cannot_approve");

  const noDevice = await invoke(app, "POST /ax/command/network/approvals/" + id + "/approve", { headers: bridgeAuth, body: {} });
  assert.equal(noDevice.statusCode, 401);
  assert.equal(noDevice.body.code, "owner_required");

  const wrongDevice = await invoke(app, "POST /ax/command/network/approvals/" + id + "/approve", {
    headers: { ...bridgeAuth, ...ownerHeaders, "x-owner-device-token": "not-the-token" },
    body: {}
  });
  assert.equal(wrongDevice.statusCode, 401);
  assert.equal(wrongDevice.body.code, "owner_invalid");

  const denied = await invoke(app, "POST /ax/command/network/approvals/" + id + "/deny", {
    headers: { ...bridgeAuth, ...ownerHeaders },
    body: { reason: "no margin" }
  });
  assert.equal(denied.statusCode, 200);
  assert.equal(denied.body.approval.status, "denied");

  const afterDenial = await invoke(app, "GET /ax/command/network/approvals/" + id, { headers: bridgeAuth });
  assert.equal(afterDenial.body.approval.status, "denied");
});

test("only the owner device may assert that revenue is settled cash", async () => {
  const app = mount();
  const cashBody = {
    id: "rev_cash_1",
    state: "available",
    amountCents: 4500,
    currency: "USD",
    occurredAt,
    source: "tiktok-settlement",
    evidence: ["payout_2026_11_23"]
  };

  const agentCash = await invoke(app, "POST /ax/command/network/treasury/events", { headers: commandAuth, body: cashBody });
  assert.equal(agentCash.statusCode, 403);
  assert.equal(agentCash.body.code, "command_token_cannot_approve");

  const noOwner = await invoke(app, "POST /ax/command/network/treasury/events", { headers: bridgeAuth, body: cashBody });
  assert.equal(noOwner.statusCode, 401);

  const pipeline = await invoke(app, "POST /ax/command/network/treasury/events", {
    headers: commandAuth,
    body: { ...cashBody, id: "rev_est_1", state: "estimated", amountCents: 9000, evidence: undefined }
  });
  assert.equal(pipeline.statusCode, 201);

  const ownerCash = await invoke(app, "POST /ax/command/network/treasury/events", {
    headers: { ...bridgeAuth, ...ownerHeaders },
    body: cashBody
  });
  assert.equal(ownerCash.statusCode, 201);
  assert.equal(ownerCash.body.event.actor, "owner:" + OWNER_DEVICE);

  const treasury = await invoke(app, "GET /ax/command/network/treasury", { headers: bridgeAuth });
  assert.equal(treasury.body.primary.cashCents, 4500);
  assert.equal(treasury.body.primary.estimatedCents, 9000);
  assert.equal(treasury.body.primary.availableToSpendCents, 4500);
});

test("a settled amount without evidence is refused even from the owner", async () => {
  const app = mount();
  const res = await invoke(app, "POST /ax/command/network/treasury/events", {
    headers: { ...bridgeAuth, ...ownerHeaders },
    body: { id: "rev_bad_1", state: "settled", amountCents: 100, currency: "USD", occurredAt, source: "manual" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "cash_evidence_required");
});

test("a payout observation is owner-only and cannot move money", async () => {
  const app = mount();
  const body = { id: "po_1", state: "in_transit", amountCents: 800, currency: "USD", channel: "tiktok" };
  const agent = await invoke(app, "POST /ax/command/network/treasury/payouts", { headers: commandAuth, body });
  assert.equal(agent.statusCode, 403);

  const owner = await invoke(app, "POST /ax/command/network/treasury/payouts", { headers: { ...bridgeAuth, ...ownerHeaders }, body });
  assert.equal(owner.statusCode, 201);
  assert.equal(owner.body.externalActionPerformed, false);

  const treasury = await invoke(app, "GET /ax/command/network/treasury", { headers: bridgeAuth });
  assert.equal(treasury.body.primary.payoutsInTransitCents, 800);
  assert.equal(treasury.body.primary.cashCents, 0);
});

test("channel eligibility is evaluated per order and never auto-approves", async () => {
  const app = mount();
  const review = await invoke(app, "POST /ax/command/network/channels/eligibility", {
    headers: commandAuth,
    body: { channel: "tiktok_shop_us", inventoryOwnership: "seller_owned", fulfillmentModel: "us_3pl", destinationCountry: "US" }
  });
  assert.equal(review.statusCode, 200);
  assert.equal(review.body.evaluation.decision, "MANUAL_REVIEW");
  assert.equal(review.body.evaluation.automatedPurchase, false);

  const denied = await invoke(app, "POST /ax/command/network/channels/eligibility", {
    headers: commandAuth,
    body: { channel: "tiktok_shop_us", inventoryOwnership: "third_party", fulfillmentModel: "international_supplier_direct", destinationCountry: "US" }
  });
  assert.equal(denied.body.evaluation.decision, "DENY");

  const empty = await invoke(app, "POST /ax/command/network/channels/eligibility", { headers: commandAuth, body: {} });
  assert.equal(empty.body.evaluation.decision, "DENY");
});

test("no purchase, consume, order or transfer route is registered", () => {
  const app = mount();
  for (const key of [
    "POST /ax/command/network/approvals/apr_test/consume",
    "POST /ax/command/network/orders",
    "POST /ax/command/network/treasury/transfers",
    "POST /ax/command/network/fulfillment/orders",
    "POST /ax/command/network/suppliers/order"
  ]) {
    assert.equal(matchRoute(app, key), null, key);
  }
});

test("a fulfiller is refused by the supplier fit check through the route", async () => {
  const app = mount();
  const res = await invoke(app, "POST /ax/command/network/suppliers/fit", {
    headers: commandAuth,
    body: { supplierId: "printful", quantity: 1, inventoryOwnership: "seller_owned" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.evaluation.ok, false);
  assert.ok(res.body.evaluation.reasons.includes("automation_or_fulfiller_not_a_supplier"));
  assert.equal(res.body.evaluation.orderSubmitted, false);
});
