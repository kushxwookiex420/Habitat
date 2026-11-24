import test from "node:test";
import assert from "node:assert/strict";
import { createAxNetworkService } from "../ax-network-service.mjs";
import { createMemoryNetworkRepository } from "../ax-network-repository.mjs";
import { createCapabilityRegistry, GATED_SIDE_EFFECTS } from "../ax-capability-registry.mjs";

async function exercise(service) {
  await service.initialize();
  await service.capabilities();
  await service.suppliers({ layer: "supplier" });
  await service.supplier("cjdropshipping");
  await service.evaluateSupplier({ supplierId: "cjdropshipping", quantity: 1, inventoryOwnership: "seller_owned", destinationCountry: "US" });
  await service.channels();
  await service.evaluateChannel({ channel: "tiktok_shop_us", inventoryOwnership: "seller_owned", fulfillmentModel: "us_3pl", destinationCountry: "US" });
  await service.treasury();
  await service.revenueEvents();
  await service.payouts();
  await service.recordRevenue({ id: "r1", state: "estimated", amountCents: 100, currency: "USD", occurredAt: "2026-11-23T10:00:00Z", source: "review" });
  const created = await service.requestApproval({ kind: "subscription", vendor: "zendrop", amountCents: 100, currency: "USD" });
  await service.approvals();
  await service.approval(created.approval.id);
  await service.approve({ id: created.approval.id, by: "owner:phone-1" });
  await service.approvalExpiry();
  await service.status();
  return created;
}

test("no service method performs an outbound request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("outbound network is disabled during this review");
  };
  try {
    const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
    await exercise(service);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("a process with no D1 credentials never attempts a D1 request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("outbound network is disabled during this review");
  };
  try {
    const service = createAxNetworkService({ env: {} });
    assert.equal(service.adapter, "memory");
    assert.equal(service.durable, false);
    await exercise(service);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("every gated capability is non-available, approval-gated and free-first", () => {
  const registry = createCapabilityRegistry({ env: {} });
  for (const capability of registry.capabilities) {
    if (!GATED_SIDE_EFFECTS.includes(capability.sideEffects)) continue;
    assert.notEqual(capability.state, "available", capability.id);
    assert.equal(capability.requiresApproval, true, capability.id);
  }
  for (const id of ["fulfillment.purchase", "fulfillment.publish", "treasury.transfer", "treasury.payout_account", "integration.oauth", "website.deploy", "android.control"]) {
    const capability = registry.get(id);
    assert.equal(capability.state, "policy_only", id);
    assert.equal(capability.requiresApproval, true, id);
  }
});

test("a paid capability can never be reported as available without approval", () => {
  const registry = createCapabilityRegistry({ env: { OPENAI_API_KEY: "configured-in-this-test" } });
  for (const capability of registry.capabilities.filter(item => item.cost.model === "paid")) {
    assert.equal(capability.requiresApproval, true, capability.id);
  }
  const planning = registry.get("model.planning");
  assert.equal(planning.requiresApproval, true);
  assert.equal(planning.freeFirst, true);
});
