import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalGate, APPROVAL_KINDS } from "../ax-approval-gate.mjs";
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
  return { gate, repo, advance: milliseconds => { clock += milliseconds; } };
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
    quoteId: "quote_2026_11_23",
    quoteExpiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    ...overrides
  };
}

test("a purchase request must carry the whole quote binding", async () => {
  const { gate } = setup();
  const outcome = await gate.request({ kind: "purchase", vendor: "cjdropshipping", amountCents: 100 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "invalid_approval_request");
  for (const field of ["currency", "items", "shippingCents", "taxCents", "destination", "quoteId", "quoteExpiresAt"]) {
    assert.ok(outcome.missing.includes(field), field);
  }
  assert.deepEqual([...APPROVAL_KINDS].includes("purchase"), true);
});

test("an expired or over-long quote window is refused before a request exists", async () => {
  const { gate } = setup();
  const expired = await gate.request(purchase({ quoteExpiresAt: new Date(NOW - 1000).toISOString() }));
  assert.equal(expired.code, "quote_expired");

  const tooLong = await gate.request(purchase({ quoteExpiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString() }));
  assert.equal(tooLong.code, "quote_window_too_long");
});

test("only an owner actor may decide, and the refusal names the actor class", async () => {
  const { gate } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "req-1" });
  assert.equal(created.ok, true);
  const id = created.approval.id;

  for (const by of ["ax:bridge", "ax", "nexus", "scheduler", "system", "", "someone"]) {
    const refused = await gate.approve({ id, by });
    assert.equal(refused.ok, false, by || "(empty)");
    assert.equal(refused.code, "owner_required", by || "(empty)");
  }
  const stillRequested = await gate.get(id);
  assert.equal(stillRequested.approval.status, "requested");
  assert.equal(stillRequested.approval.decidedAt, null);
});

test("the owner decision is recorded once and replayed idempotently", async () => {
  const { gate } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "req-2" });
  const id = created.approval.id;

  const approved = await gate.approve({ id, by: "owner:phone-1" });
  assert.equal(approved.ok, true);
  assert.equal(approved.approval.status, "approved");
  assert.equal(approved.approval.decidedBy, "owner:phone-1");
  assert.equal(approved.externalActionPerformed, false);

  const replay = await gate.approve({ id, by: "owner:phone-1" });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);

  const flip = await gate.deny({ id, by: "owner:phone-1" });
  assert.equal(flip.ok, false);
  assert.equal(flip.code, "already_decided");
});

test("a denial is terminal and cannot be approved afterwards", async () => {
  const { gate } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "req-3" });
  const denied = await gate.deny({ id: created.approval.id, by: "owner:phone-1", reason: "margin too thin" });
  assert.equal(denied.approval.status, "denied");
  const later = await gate.approve({ id: created.approval.id, by: "owner:phone-1" });
  assert.equal(later.code, "already_decided");
});

test("consumption is single use and bound to the exact amount, vendor and destination", async () => {
  const { gate } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "req-4" });
  await gate.approve({ id: created.approval.id, by: "owner:phone-1" });
  const id = created.approval.id;

  const mismatch = await gate.consume({ id, by: "owner:phone-1", executionKey: "exec-1", amountCents: 9999 });
  assert.equal(mismatch.code, "approval_binding_mismatch");
  assert.ok(mismatch.mismatches.includes("amountCents"));

  const wrongVendor = await gate.consume({ id, by: "owner:phone-1", executionKey: "exec-1", vendor: "aliexpress" });
  assert.equal(wrongVendor.code, "approval_binding_mismatch");

  const first = await gate.consume({ id, by: "owner:phone-1", executionKey: "exec-1", amountCents: 1237, currency: "USD", vendor: "cjdropshipping", destination: "US-CA" });
  assert.equal(first.ok, true);
  assert.equal(first.approval.status, "consumed");
  assert.equal(first.externalActionPerformed, false);

  const replay = await gate.consume({ id, by: "owner:phone-1", executionKey: "exec-1" });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);

  const second = await gate.consume({ id, by: "owner:phone-1", executionKey: "exec-2" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "already_consumed");
});

test("consumption needs the owner and an execution key", async () => {
  const { gate } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "req-5" });
  await gate.approve({ id: created.approval.id, by: "owner:phone-1" });
  assert.equal((await gate.consume({ id: created.approval.id, by: "ax:bridge", executionKey: "e" })).code, "owner_required");
  assert.equal((await gate.consume({ id: created.approval.id, by: "owner:phone-1" })).code, "execution_key_required");
});

test("an approval expires and cannot be revived", async () => {
  const { gate, advance } = setup();
  const created = await gate.request({ ...purchase(), idempotencyKey: "req-6" });
  advance(61_000);
  const read = await gate.get(created.approval.id);
  assert.equal(read.approval.status, "expired");
  const approve = await gate.approve({ id: created.approval.id, by: "owner:phone-1" });
  assert.equal(approve.code, "approval_expired");
  const consume = await gate.consume({ id: created.approval.id, by: "owner:phone-1", executionKey: "e" });
  assert.equal(consume.code, "approval_expired");
});

test("an idempotency key replays and an identical open request is refused", async () => {
  const { gate } = setup();
  const first = await gate.request({ ...purchase(), idempotencyKey: "same-key" });
  const again = await gate.request({ ...purchase(), idempotencyKey: "same-key" });
  assert.equal(first.approval.id, again.approval.id);
  assert.equal(again.replayed, true);

  const other = await gate.request(purchase());
  assert.equal(other.ok, false);
  assert.equal(other.code, "duplicate_request");
  assert.equal(other.existingId, first.approval.id);
});

test("credentials in a request are refused, and pending commitments are reported", async () => {
  const { gate } = setup();
  const secret = await gate.request({
    ...purchase({ idempotencyKey: "req-7" }),
    metadata: { note: "use sk-live-abcdefghijklmnop for the supplier" }
  });
  assert.equal(secret.ok, false);
  assert.equal(secret.code, "secret_material_refused");

  const created = await gate.request({ ...purchase(), idempotencyKey: "req-8" });
  await gate.approve({ id: created.approval.id, by: "owner:phone-1" });
  const commitments = await gate.pendingCommitments();
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0].amountCents, 1237);
  assert.equal(commitments[0].externalActionPerformed, false);
});
