/**
 * Work prioritisation on expected value, cost, risk and available resources.
 *
 * The engine is deliberately arithmetic, not aspirational: every input is supplied by a caller that
 * has a record behind it, and an item without a value estimate is placed in `unscored` rather than
 * being given a flattering default. Nothing here discovers opportunities or invents revenue; it only
 * orders work that someone has already described.
 *
 * Ranking:
 *   expectedValue = valueCents x confidence
 *   riskFactor    = low 1, medium 1.5, high 2.5, critical 4
 *   effectiveCost = costCents x riskFactor + effortHours x opportunityCostPerHourCents
 *   score         = expectedValue / max(1, effectiveCost)
 *   deadline      = x1.5 when overdue, x1.25 when due within 48h
 *
 * Selection is greedy in score order while budget and hours last, so a high-score item that does not
 * fit is deferred with a reason instead of silently dropped.
 */

export const RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
export const RISK_FACTORS = Object.freeze({ low: 1, medium: 1.5, high: 2.5, critical: 4 });
const DEADLINE_BOOST_MS = 48 * 60 * 60 * 1000;

function clean(value, max = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toMs(value) {
  if (!value) return null;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? at : null;
}

export function prioritizeWork({
  items = [],
  budgetCents = 0,
  hoursAvailable = 0,
  opportunityCostPerHourCents = 0,
  capabilityExists = null,
  now = Date.now()
} = {}) {
  const excluded = [];
  const scored = [];
  const unscored = [];

  for (const raw of Array.isArray(items) ? items : []) {
    const id = clean(raw?.id, 120);
    if (!id) {
      excluded.push({ id: null, code: "item_id_required", error: "A work item needs an id." });
      continue;
    }
    const title = clean(raw?.title, 200);
    if (!title) {
      excluded.push({ id, code: "item_title_required", error: "A work item needs a title." });
      continue;
    }
    const riskLevel = clean(raw?.riskLevel || "medium", 20).toLowerCase();
    if (!RISK_LEVELS.includes(riskLevel)) {
      excluded.push({ id, code: "invalid_risk_level", error: "riskLevel must be one of " + RISK_LEVELS.join(", ") + "." });
      continue;
    }
    const capabilityId = clean(raw?.capabilityId, 120) || null;
    if (capabilityId && typeof capabilityExists === "function" && !capabilityExists(capabilityId)) {
      excluded.push({ id, code: "unknown_capability", error: "No capability with that id is registered." });
      continue;
    }
    const valueCents = number(raw?.valueCents, 0);
    const confidence = Math.min(1, Math.max(0, number(raw?.confidence, 0)));
    if (valueCents <= 0 || confidence <= 0) {
      unscored.push({
        id,
        title,
        reason: valueCents <= 0 ? "no_value_estimate" : "no_confidence",
        note: "An item without a recorded value estimate is not ranked above work with one."
      });
      continue;
    }
    const costCents = Math.max(0, number(raw?.costCents, 0));
    const effortHours = Math.max(0, number(raw?.effortHours, 0));
    const deadlineMs = toMs(raw?.deadlineAt);
    const expectedValueCents = Math.round(valueCents * confidence);
    const riskFactor = RISK_FACTORS[riskLevel];
    const effectiveCostCents = Math.max(
      1,
      Math.round(costCents * riskFactor + effortHours * Math.max(0, opportunityCostPerHourCents))
    );
    let deadlineMultiplier = 1;
    if (deadlineMs !== null) {
      if (deadlineMs <= now) deadlineMultiplier = 1.5;
      else if (deadlineMs - now <= DEADLINE_BOOST_MS) deadlineMultiplier = 1.25;
    }
    const score = Math.round(((expectedValueCents / effectiveCostCents) * deadlineMultiplier) * 1000) / 1000;
    scored.push({
      id,
      title,
      riskLevel,
      capabilityId,
      requiresApproval: Boolean(raw?.requiresApproval),
      expectedValueCents,
      effectiveCostCents,
      effortHours,
      deadlineAt: raw?.deadlineAt || null,
      overdue: deadlineMs !== null && deadlineMs <= now,
      score,
      valuePerHourCents: effortHours > 0 ? Math.round(expectedValueCents / effortHours) : null
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aDeadline = toMs(a.deadlineAt);
    const bDeadline = toMs(b.deadlineAt);
    if (aDeadline !== null && bDeadline !== null && aDeadline !== bDeadline) return aDeadline - bDeadline;
    if (aDeadline !== null && bDeadline === null) return -1;
    if (aDeadline === null && bDeadline !== null) return 1;
    return RISK_FACTORS[a.riskLevel] - RISK_FACTORS[b.riskLevel];
  });

  const selected = [];
  const deferred = [];
  let remainingBudget = Math.max(0, number(budgetCents, 0));
  let remainingHours = Math.max(0, number(hoursAvailable, 0));
  const unlimitedBudget = remainingBudget === 0;
  const unlimitedHours = remainingHours === 0;

  for (const item of scored) {
    if (!unlimitedBudget && item.effectiveCostCents > remainingBudget) {
      deferred.push({ ...item, reason: "budget_exhausted" });
      continue;
    }
    if (!unlimitedHours && item.effortHours > remainingHours) {
      deferred.push({ ...item, reason: "hours_exhausted" });
      continue;
    }
    selected.push({
      ...item,
      reason: item.requiresApproval ? "awaiting_owner_approval" : "ready"
    });
    if (!unlimitedBudget) remainingBudget -= item.effectiveCostCents;
    if (!unlimitedHours) remainingHours -= item.effortHours;
  }

  return {
    ok: true,
    asOf: new Date(now).toISOString(),
    ranked: scored,
    selected,
    deferred,
    unscored,
    excluded,
    remainingBudgetCents: unlimitedBudget ? null : remainingBudget,
    remainingHours: unlimitedHours ? null : remainingHours,
    executableNow: selected.filter((item) => !item.requiresApproval).length,
    awaitingApproval: selected.filter((item) => item.requiresApproval).length,
    note: "Value, cost and confidence come from the caller's records. No estimate is invented and nothing is executed here."
  };
}

/** Convenience: the next task to attempt, or null. Never returns an item that is not executable now. */
export function nextTask(result) {
  if (!result || !Array.isArray(result.selected)) return null;
  return result.selected.find((item) => !item.requiresApproval) || null;
}
