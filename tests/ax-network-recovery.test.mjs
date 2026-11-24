import test from "node:test";
import assert from "node:assert/strict";
import { createAxNetworkService } from "../ax-network-service.mjs";
import { createMemoryNetworkRepository } from "../ax-network-repository.mjs";
import { createCapabilityRegistry } from "../ax-capability-registry.mjs";

const occurredAt = "2026-11-23T10:00:00.000Z";

/** A memory store whose supplier write can fail once, to interrupt the boot-time seed. */
function interruptibleRepository() {
  const store = createMemoryNetworkRepository();
  let failNextSupplierPut = false;
  return {
    ...store,
    suppliers: {
      ...store.suppliers,
      async put(record) {
        if (failNextSupplierPut) {
          failNextSupplierPut = false;
          throw new Error("store_unavailable");
        }
        return store.suppliers.put(record);
      }
    },
    failOnce() { failNextSupplierPut = true; }
  };
}

test("an interrupted seed can be retried and leaves no poisoned latch", async () => {
  const repository = interruptibleRepository();
  const service = createAxNetworkService({ env: {}, repository });

  repository.failOnce();
  await assert.rejects(() => service.initialize(), /store_unavailable/);

  // The failed attempt must not memoise a rejected promise: reads keep working, and a retry seeds.
  const reads = await service.capabilities();
  assert.equal(reads.ok, true);
  const seeded = await service.initialize();
  assert.equal(seeded.ok, true);
  assert.equal(seeded.capabilities, createCapabilityRegistry({ env: {} }).capabilities.length);
  assert.equal(seeded.suppliers > 0, true);
});

test("an interrupted seed is completed by a later initialize, not by a write on read", async () => {
  const repository = interruptibleRepository();
  const service = createAxNetworkService({ env: {}, repository });
  repository.failOnce();
  await assert.rejects(() => service.initialize(), /store_unavailable/);

  const before = await repository.capabilities.list({ limit: 10 });
  await service.suppliers();
  const after = await repository.capabilities.list({ limit: 10 });
  assert.equal(before.length, after.length, "reading a catalog does not seed the store");

  await service.initialize();
  const seeded = await repository.suppliers.list({ limit: 100 });
  assert.equal(seeded.length > 0, true);
});

test("an approval request naming an unregistered capability is refused and not stored", async () => {
  const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
  const refused = await service.requestApproval({
    kind: "subscription",
    capabilityId: "made.up.capability",
    vendor: "zendrop",
    amountCents: 3900,
    currency: "USD"
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "unknown_capability");
  assert.equal((await service.approvals()).count, 0);

  const accepted = await service.requestApproval({
    kind: "subscription",
    capabilityId: "model.planning",
    vendor: "zendrop",
    amountCents: 3900,
    currency: "USD"
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.approval.capabilityId, "model.planning");
});

test("an approval request with no capability id stays valid but unbound", async () => {
  const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
  const outcome = await service.requestApproval({ kind: "subscription", vendor: "zendrop", amountCents: 3900, currency: "USD" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.approval.capabilityId, null);
});

test("a replayed approval request is idempotent, not duplicated", async () => {
  const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
  const body = {
    kind: "subscription",
    capabilityId: "model.planning",
    vendor: "zendrop",
    amountCents: 3900,
    currency: "USD",
    idempotencyKey: "replay-key-1"
  };
  const first = await service.requestApproval(body);
  assert.equal(first.ok, true);
  const replay = await service.requestApproval(body);
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.approval.id, first.approval.id);
  assert.equal((await service.approvals()).count, 1, "a replay does not create a second approval");
});

test("a different action under the same idempotency key is not silently reused", async () => {
  const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
  const first = await service.requestApproval({
    kind: "subscription",
    vendor: "zendrop",
    amountCents: 3900,
    currency: "USD",
    idempotencyKey: "replay-key-2"
  });
  assert.equal(first.ok, true);
  const different = await service.requestApproval({
    kind: "subscription",
    vendor: "spocket",
    amountCents: 4900,
    currency: "USD",
    idempotencyKey: "replay-key-2"
  });
  // The stored row wins; the caller must compare the binding rather than assume its own.
  assert.equal(different.approval.vendor, "zendrop");
  assert.equal(different.approval.amountCents, 3900);
});

test("a replayed refund is refused by the ledger", async () => {
  const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
  const base = {
    state: "refunded",
    amountCents: 1200,
    currency: "USD",
    occurredAt,
    source: "manual-report",
    evidence: ["refund_9"],
    externalId: "refund_9",
    actor: "owner:phone-1"
  };

  const first = await service.recordRevenue({ ...base, id: "rev_refund_1" });
  assert.equal(first.ok, true);
  assert.equal(first.externalActionPerformed, false);

  const replay = await service.recordRevenue({ ...base, id: "rev_refund_2", evidence: ["case_12"] });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "duplicate_refund");

  const treasury = await service.treasury();
  assert.equal(treasury.primary.refundedCents, 1200, "cash is reduced once");
  assert.equal(treasury.rejectedCount, 0, "the duplicate never reached the summary");
});

test("a refund must name the transaction it reverses", async () => {
  const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
  const outcome = await service.recordRevenue({
    id: "rev_unreferenced",
    state: "reversed",
    amountCents: 1200,
    currency: "USD",
    occurredAt,
    source: "manual-report",
    evidence: ["case_12"],
    actor: "owner:phone-1"
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "refund_reference_required");
});

test("a duplicate that reached the store by another path is still deduplicated on read", async () => {
  const repository = createMemoryNetworkRepository();
  const service = createAxNetworkService({ env: {}, repository });
  const base = {
    state: "refunded",
    amountCents: 500,
    currency: "USD",
    occurredAt,
    source: "manual-report",
    evidence: ["refund_7"],
    externalId: "refund_7"
  };
  // Written directly to the store, bypassing the service's write-time guard.
  await repository.revenueEvents.put({ ...base, id: "seed_1", actor: "owner:phone-1" });
  await repository.revenueEvents.put({ ...base, id: "seed_2", evidence: ["case_99"], actor: "owner:phone-1" });

  const treasury = await service.treasury();
  assert.equal(treasury.primary.refundedCents, 500);
  assert.equal(treasury.rejectedCount, 1);
  assert.equal(treasury.rejectedEvents[0].code, "duplicate_refund");
});

test("an available amount recorded after the same settled receipt never double-counts", async () => {
  const service = createAxNetworkService({ env: {}, repository: createMemoryNetworkRepository() });
  const base = {
    amountCents: 2500,
    currency: "USD",
    occurredAt,
    source: "tiktok-settlement",
    evidence: ["payout_42"],
    externalId: "payout_42",
    actor: "owner:phone-1"
  };
  const settled = await service.recordRevenue({ ...base, id: "cash_settled", state: "settled" });
  assert.equal(settled.ok, true);
  const available = await service.recordRevenue({ ...base, id: "cash_available", state: "available" });
  assert.equal(available.ok, true, "observing the later state is allowed; the summary decides");

  const treasury = await service.treasury();
  assert.equal(treasury.primary.cashCents, 2500);
  assert.equal(treasury.rejectedCount, 1);
  assert.equal(treasury.rejectedEvents[0].code, "duplicate_cash_transaction");
});
