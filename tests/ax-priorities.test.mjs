import test from "node:test";
import assert from "node:assert/strict";
import { nextTask, prioritizeWork } from "../ax-priorities.mjs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const item = (id, extra = {}) => ({
  id,
  title: "Work " + id,
  valueCents: 10000,
  confidence: 1,
  costCents: 1000,
  effortHours: 2,
  riskLevel: "low",
  ...extra
});

test("value per unit of risk-adjusted cost drives the order", () => {
  const result = prioritizeWork({
    items: [
      item("low", { valueCents: 10000 }),
      item("high", { valueCents: 50000 }),
      item("mid", { valueCents: 25000 })
    ],
    now: NOW
  });
  assert.deepEqual(result.ranked.map((entry) => entry.id), ["high", "mid", "low"]);
  assert.equal(result.selected.length, 3);
});

test("risk lowers the score at equal value and cost", () => {
  const result = prioritizeWork({
    items: [item("safe", { riskLevel: "low" }), item("risky", { riskLevel: "critical" })],
    now: NOW
  });
  assert.equal(result.ranked[0].id, "safe");
  assert.ok(result.ranked[0].score > result.ranked[1].score);
});

test("an item without a value estimate is never ranked above scored work", () => {
  const result = prioritizeWork({
    items: [item("valued", { valueCents: 100 }), item("guess", { valueCents: 0 })],
    now: NOW
  });
  assert.deepEqual(result.ranked.map((entry) => entry.id), ["valued"]);
  assert.equal(result.unscored.length, 1);
  assert.equal(result.unscored[0].reason, "no_value_estimate");
});

test("budget limits selection and defers the remainder with a reason", () => {
  const result = prioritizeWork({
    items: [item("cheap", { valueCents: 10000, costCents: 1000 }), item("expensive", { valueCents: 20000, costCents: 20000 })],
    budgetCents: 5000,
    now: NOW
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["cheap"]);
  assert.equal(result.deferred[0].id, "expensive");
  assert.equal(result.deferred[0].reason, "budget_exhausted");
  assert.equal(result.remainingBudgetCents, 4000);
});

test("hours limit selection independently of budget", () => {
  const result = prioritizeWork({
    items: [item("quick", { effortHours: 1 }), item("slow", { effortHours: 40 })],
    hoursAvailable: 5,
    now: NOW
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["quick"]);
  assert.equal(result.deferred[0].reason, "hours_exhausted");
});

test("an approval-gated item is selected but not executable now", () => {
  const result = prioritizeWork({ items: [item("gated", { requiresApproval: true }), item("open")], now: NOW });
  assert.equal(result.executableNow, 1);
  assert.equal(result.awaitingApproval, 1);
  assert.equal(result.selected.find((entry) => entry.id === "gated").reason, "awaiting_owner_approval");
  assert.equal(nextTask(result).id, "open");
});

test("an unknown capability is excluded before scoring", () => {
  const result = prioritizeWork({
    items: [item("unknown", { capabilityId: "made.up" }), item("known", { capabilityId: "model.planning" })],
    capabilityExists: (id) => id === "model.planning",
    now: NOW
  });
  assert.deepEqual(result.ranked.map((entry) => entry.id), ["known"]);
  assert.equal(result.excluded[0].code, "unknown_capability");
});

test("an overdue deadline outranks an otherwise identical item", () => {
  const result = prioritizeWork({
    items: [
      item("future", { deadlineAt: "2027-01-01T00:00:00.000Z" }),
      item("overdue", { deadlineAt: "2026-11-20T00:00:00.000Z" })
    ],
    now: NOW
  });
  assert.equal(result.ranked[0].id, "overdue");
  assert.equal(result.ranked[0].overdue, true);
});

test("effort has a monetary opportunity cost when one is supplied", () => {
  const withCost = prioritizeWork({ items: [item("x")], opportunityCostPerHourCents: 1000, now: NOW });
  const withoutCost = prioritizeWork({ items: [item("x")], now: NOW });
  assert.ok(withCost.ranked[0].effectiveCostCents > withoutCost.ranked[0].effectiveCostCents);
  assert.ok(withCost.ranked[0].score < withoutCost.ranked[0].score);
});

test("malformed items are excluded with a specific code", () => {
  const result = prioritizeWork({
    items: [
      { title: "no id", valueCents: 100 },
      item("no-title", { title: "" }),
      item("bad-risk", { riskLevel: "spicy" })
    ],
    now: NOW
  });
  assert.deepEqual(result.excluded.map((entry) => entry.code), ["item_id_required", "item_title_required", "invalid_risk_level"]);
  assert.equal(result.ranked.length, 0);
});

test("no items means no work, not a fabricated default", () => {
  const result = prioritizeWork({ now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.selected, []);
  assert.equal(nextTask(result), null);
});
