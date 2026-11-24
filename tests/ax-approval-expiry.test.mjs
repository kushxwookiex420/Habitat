import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalGate } from "../ax-approval-gate.mjs";
import { createMemoryNetworkRepository } from "../ax-network-repository.mjs";

const START = Date.parse("2026-11-23T12:00:00.000Z");
const subscription = { kind: "subscription", vendor: "zendrop", amountCents: 3900, currency: "USD" };

function harness({ ttlMs = 60_000 } = {}) {
  let clock = START;
  const store = createMemoryNetworkRepository();
  const gate = createApprovalGate({
    repository: store.approvals,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
    ttlMs
  });
  return {
    gate,
    store,
    advance(ms) { clock += ms; },
    raw(id) { return store.approvals.get(id); }
  };
}

test("a read reports expiry without writing it", async () => {
  const { gate, advance, raw } = harness();
  const created = await gate.request(subscription);
  assert.equal(created.ok, true);

  advance(61_000);
  const read = await gate.get(created.approval.id);
  assert.equal(read.ok, true);
  assert.equal(read.approval.status, "expired");
  assert.equal(read.approval.expired, true);
  assert.equal((await raw(created.approval.id)).status, "requested", "a GET must not persist the expiry");

  const listed = await gate.list({ status: "expired" });
  assert.equal(listed.count, 1, "the list filters on the effective status");
  assert.equal((await raw(created.approval.id)).status, "requested");
});

test("the scheduler sweep persists each due expiry exactly once", async () => {
  const { gate, advance, raw } = harness();
  const first = await gate.request(subscription);
  const second = await gate.request({ ...subscription, vendor: "spocket", amountCents: 4900 });
  advance(61_000);

  const report = await gate.expiryReport({ withinMs: 60 * 60_000 });
  assert.equal(report.ok, true);
  assert.equal(report.expired.length, 2);
  assert.equal(report.failed.length, 0);
  assert.equal((await raw(first.approval.id)).status, "expired");
  assert.equal((await raw(second.approval.id)).status, "expired");

  const again = await gate.expiryReport();
  assert.equal(again.expired.length, 0, "a second sweep finds nothing left to expire");
  assert.equal(again.failed.length, 0);
});

test("an approval about to expire is reported and left untouched", async () => {
  const { gate } = harness({ ttlMs: 30 * 60_000 });
  const created = await gate.request(subscription);

  const report = await gate.expiryReport({ withinMs: 60 * 60_000 });
  assert.equal(report.expired.length, 0);
  assert.equal(report.expiringSoon.length, 1);
  assert.equal(report.expiringSoon[0].id, created.approval.id);
  assert.equal((await gate.get(created.approval.id)).approval.status, "requested");

  const narrow = await gate.expiryReport({ withinMs: 60_000 });
  assert.equal(narrow.expiringSoon.length, 0, "the warning window is honoured");
});

test("a sweep never overwrites a decision that landed first", async () => {
  const store = createMemoryNetworkRepository();
  let clock = START;
  const options = { now: () => new Date(clock).toISOString(), nowMs: () => clock, ttlMs: 60_000 };
  const gate = createApprovalGate({ repository: store.approvals, ...options });
  const created = await gate.request(subscription);
  clock += 61_000;

  const racing = {
    get: id => store.approvals.get(id),
    put: record => store.approvals.put(record),
    list: input => store.approvals.list(input),
    async transition(id) {
      // The owner approves between the sweep's read and its conditional write.
      await store.approvals.put({ ...(await store.approvals.get(id)), status: "approved", decidedBy: "owner:phone-1" });
      return null;
    }
  };
  const sweeping = createApprovalGate({ repository: racing, ...options });
  const report = await sweeping.expiryReport();

  assert.equal(report.expired.length, 0);
  assert.deepEqual(report.failed, [created.approval.id]);
  assert.equal((await store.approvals.get(created.approval.id)).status, "approved");
});

test("an expired approval can never be approved afterwards", async () => {
  const { gate, advance } = harness();
  const created = await gate.request(subscription);
  advance(61_000);

  const decided = await gate.approve({ id: created.approval.id, by: "owner:phone-1" });
  assert.equal(decided.ok, false);
  assert.equal(decided.code, "approval_expired");
});

test("an approved but unexpired commitment stays spendable and is not swept", async () => {
  const { gate, advance } = harness({ ttlMs: 10 * 60_000 });
  const created = await gate.request(subscription);
  const approved = await gate.approve({ id: created.approval.id, by: "owner:phone-1" });
  assert.equal(approved.ok, true);

  advance(5 * 60_000);
  const report = await gate.expiryReport({ withinMs: 60 * 60_000 });
  assert.equal(report.expired.length, 0);
  assert.equal((await gate.pendingCommitments()).length, 1);
});
