import test from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_BONUS_MAX, PRIORITY_MAX, PRIORITY_MIN, derivePriority } from "../ax-priority-policy.mjs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const HOUR = 3_600_000;
const derive = (signals) => derivePriority(signals, { now: NOW });

test("no signals produce the lowest priority, never a guess", () => {
  const result = derive({});
  assert.equal(result.priority, 0);
  assert.deepEqual(result.reasons, ["no signals supplied"]);
  assert.equal(derive(null).priority, 0);
  assert.equal(derive("nonsense").priority, 0);
});

test("urgent, overdue and high-impact work outranks routine work", () => {
  const critical = derive({ urgency: "critical", deadlineAt: new Date(NOW - HOUR).toISOString(), impact: "critical" });
  const routine = derive({ urgency: "low", deadlineAt: new Date(NOW + 60 * HOUR).toISOString(), impact: "low" });
  assert.equal(critical.priority, 90, "40 + 30 + 20");
  assert.ok(critical.priority > routine.priority);
  assert.ok(routine.priority > 0);
});

test("deadline pressure grows as the deadline approaches and saturates when overdue", () => {
  const far = derive({ deadlineAt: new Date(NOW + 72 * HOUR).toISOString() });
  const near = derive({ deadlineAt: new Date(NOW + 36 * HOUR).toISOString() });
  const soon = derive({ deadlineAt: new Date(NOW + HOUR).toISOString() });
  const overdue = derive({ deadlineAt: new Date(NOW - 5 * HOUR).toISOString() });
  assert.equal(far.priority, 0, "a deadline beyond the horizon adds no pressure");
  assert.ok(near.priority > far.priority);
  assert.ok(soon.priority > near.priority);
  assert.equal(overdue.factors.deadline, 1, "overdue is full deadline pressure");
  assert.equal(soon.factors.deadline, 1 - 1 / 72, "one hour out is almost full pressure");
  assert.ok(soon.priority > near.priority);
  assert.ok(overdue.priority >= soon.priority);
});

test("dependencies and blocked work raise priority but stay bounded", () => {
  const base = derive({ urgency: "normal", impact: "medium" });
  const fanOut = derive({ urgency: "normal", impact: "medium", dependencyCount: 5 });
  const blocked = derive({ urgency: "normal", impact: "medium", blockedCount: 2 });
  assert.ok(fanOut.priority > base.priority);
  assert.ok(blocked.priority > base.priority);
  assert.equal(blocked.factors.blockedBonus, 10);

  const everything = derive({
    urgency: "critical", impact: "critical", deadlineAt: new Date(NOW - HOUR).toISOString(),
    dependencyCount: 99, blockedCount: 99
  });
  assert.equal(everything.priority, PRIORITY_MAX, "the ceiling is enforced");
  assert.equal(everything.factors.blockedBonus, BLOCKED_BONUS_MAX);
});

test("priority is always an integer inside the queue's accepted range", () => {
  const cases = [
    {}, null, undefined, "x",
    { urgency: 1e9, impact: 1e9, dependencyCount: -5, blockedCount: -5 },
    { urgency: -3, impact: Infinity, deadlineAt: "not-a-date" },
    { urgency: NaN, impact: "unknown-label", deadlineAt: 0 },
    { dependencyCount: "7", blockedCount: "2" }
  ];
  for (const signals of cases) {
    const { priority } = derive(signals);
    assert.equal(Number.isInteger(priority), true, JSON.stringify(signals) + " produced a non-integer");
    assert.ok(priority >= PRIORITY_MIN && priority <= PRIORITY_MAX, JSON.stringify(signals) + " left the range");
  }
});

test("labels are case-insensitive and numeric 0..1 urgency is accepted", () => {
  assert.equal(derive({ urgency: "HIGH" }).priority, derive({ urgency: "high" }).priority);
  assert.equal(derive({ urgency: 1 }).priority, 40);
  assert.equal(derive({ urgency: 0 }).priority, 0);
  // A 1..5 impact scale is read as a fraction of 5.
  assert.equal(derive({ impact: 5 }).priority, 20);
  assert.equal(derive({ impact: 2.5 }).priority, 10);
});

test("the result explains itself so a human can audit the number", () => {
  const result = derive({ urgency: "high", impact: "medium", blockedCount: 1 });
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.reasons.length >= 3);
  assert.ok(result.reasons.some((reason) => reason.includes("blocked")));
  assert.equal(typeof result.factors.raw, "number");
});
