import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalGate } from "../ax-approval-gate.mjs";
import { createMemoryNetworkRepository } from "../ax-network-repository.mjs";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");

function setup() {
  const repo = createMemoryNetworkRepository();
  let clock = NOW;
  const gate = createApprovalGate({
    repository: repo.approvals,
    nowMs: () => clock,
    now: () => new Date(clock).toISOString(),
    ttlMs: 60_000
  });
  return { repo, gate, advance: milliseconds => { clock += milliseconds; } };
}

function purchase(overrides = {}) {
  return {
    kind: "purchase",
    capabilityId: "fulfillment.purchase",
    vendor: "cjdropshipping",
    amountCents: 1237,
    currency: "USD",
    shippingCents: 549,
    taxCents: 0,
    items: [{ sku: "phone-case-pink", quantity: 1, unitCents: 688 }],
    destination: "US-CA",
    quoteId: "quote_race",
    quoteExpiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    ...overrides
  };
}

test("the repository exposes compare-and-swap only for approvals", () => {
  const repo = createMemoryNetworkRepository();
  assert.equal(typeof repo.approvals.transition, "function");
  assert.equal(repo.capabilities.transition, undefined);
  assert.equal(repo.revenueEvents.transition, undefined);
});

test("an approve and a deny racing on one request cannot both win", async () => {
  const { gate } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "race-approve-deny" });
  const id = created.approval.id;

  const [approve, deny] = await Promise.all([
    gate.approve({ id, by: "owner:phone-1" }),
    gate.deny({ id, by: "owner:phone-1" })
  ]);

  const winners = [approve, deny].filter(outcome => outcome.ok === true);
  assert.equal(winners.length, 1, JSON.stringify({ approve, deny }));
  const losers = [approve, deny].filter(outcome => outcome.ok !== true);
  assert.equal(losers[0].code, "approval_conflict");

  const stored = await gate.get(id);
  assert.equal(stored.approval.status, winners[0].approval.status);
});

test("two consumptions with different execution keys cannot both spend the approval", async () => {
  const { gate } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "race-consume" });
  const id = created.approval.id;
  await gate.approve({ id, by: "owner:phone-1" });

  const [left, right] = await Promise.all([
    gate.consume({ id, by: "owner:phone-1", executionKey: "exec-left", amountCents: 1237 }),
    gate.consume({ id, by: "owner:phone-1", executionKey: "exec-right", amountCents: 1237 })
  ]);

  assert.equal([left, right].filter(outcome => outcome.ok === true).length, 1, JSON.stringify({ left, right }));
  const stored = await gate.get(id);
  assert.equal(stored.approval.status, "consumed");
  assert.ok(["exec-left", "exec-right"].includes(stored.approval.executionKey));
});

test("a request that expires while a decision is being written cannot be approved", async () => {
  const { gate, advance } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "race-expiry" });
  const id = created.approval.id;
  advance(61_000);
  const outcome = await gate.approve({ id, by: "owner:phone-1" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "approval_expired");
  assert.equal((await gate.get(id)).approval.status, "expired");
});

test("an expired request cannot be cancelled back to life", async () => {
  const { gate, advance } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "race-cancel" });
  advance(61_000);
  const outcome = await gate.cancel({ id: created.approval.id, by: "owner:phone-1" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "approval_expired");
});
