/**
 * Suggested execution priority.
 *
 * Manual priority works only when a human is watching. This derives a starting priority from the
 * signals a planner already has — urgency, deadline, impact, fan-out and how much work is blocked
 * behind the task — so the queue orders itself sensibly before anyone touches it.
 *
 * Two boundaries are deliberate:
 *   - the result is always an integer in [0, 100], because the execution queue accepts nothing else;
 *   - a derived value is a hint. It is stored as a suggestion and never changes status, approvals or
 *     authentication. A task at priority 100 still waits for the same gates as one at 0.
 */

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;

/** Weights sum to 100 before the blocked-work bonus, and the total is clamped afterwards. */
export const PRIORITY_WEIGHTS = Object.freeze({
  urgency: 40,
  deadline: 30,
  impact: 20,
  fanOut: 10
});
export const BLOCKED_BONUS_MAX = 15;
/** An overdue task scores full deadline pressure regardless of how late it is. */
export const DEADLINE_HORIZON_HOURS = 72;

const URGENCY_LABELS = Object.freeze({ low: 0.1, normal: 0.35, high: 0.7, critical: 1 });
const IMPACT_LABELS = Object.freeze({ low: 0.15, medium: 0.4, high: 0.7, critical: 1 });

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

function labelScore(table, value) {
  if (typeof value !== "string") return null;
  return table[value.trim().toLowerCase()] ?? null;
}

/** 0..1 from a fractional number or a label; null when the caller supplied nothing usable. */
function urgencyScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const labelled = labelScore(URGENCY_LABELS, value);
  if (labelled !== null) return labelled;
  return clamp01(value);
}

function impactScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const labelled = labelScore(IMPACT_LABELS, value);
  if (labelled !== null) return labelled;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // A 1..5 impact scale is the common planner output; anything else is read as a 0..1 fraction.
  if (number > 1) return clamp01(number / 5);
  return clamp01(number);
}

function deadlineScore(deadlineAt, nowMs) {
  if (deadlineAt === undefined || deadlineAt === null || deadlineAt === "") return null;
  const at = typeof deadlineAt === "number" ? deadlineAt : Date.parse(String(deadlineAt));
  if (!Number.isFinite(at)) return null;
  const hours = (at - nowMs) / 3_600_000;
  if (hours <= 0) return 1;
  if (hours >= DEADLINE_HORIZON_HOURS) return 0;
  return clamp01(1 - hours / DEADLINE_HORIZON_HOURS);
}

function countOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(10, Math.floor(number));
}

/** The plan vocabulary Ax already uses maps onto urgency without inventing a second scale. */
export const RISK_TO_URGENCY = Object.freeze({ low: "low", medium: "normal", high: "high", critical: "critical" });
/** Expected value is normalised against this ceiling so "impact" stays a 0..1 fraction. */
export const VALUE_CEILING_CENTS = 100_000;

/**
 * Turn real plan data into policy signals.
 *
 * Everything here already exists in an Ax plan or work item: the risk level, an optional deadline, the
 * expected value and confidence, and the step's position. Plan position is the dependency signal a plan
 * actually carries — every later step depends on this one finishing — so a first step of five is ranked
 * above the last step of five without anyone typing a number.
 */
export function signalsForPlanStep(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const {
    riskLevel = null,
    deadlineAt = null,
    valueCents = null,
    confidence = null,
    blockedCount = null,
    index = null,
    totalSteps = null
  } = source;
  const signals = {};
  const urgency = RISK_TO_URGENCY[String(riskLevel || "").trim().toLowerCase()];
  if (urgency) signals.urgency = urgency;
  if (deadlineAt) signals.deadlineAt = deadlineAt;

  const value = Number(valueCents);
  if (Number.isFinite(value) && value > 0) {
    const confidenceFactor = Number.isFinite(Number(confidence))
      ? Math.min(1, Math.max(0, Number(confidence)))
      : 1;
    signals.impact = Math.min(1, value / VALUE_CEILING_CENTS) * confidenceFactor;
  }

  const total = Number(totalSteps);
  const position = Number(index);
  // A real step has a non-negative position inside the plan; anything else is malformed input and
  // must not manufacture dependents.
  if (Number.isFinite(total) && Number.isFinite(position) && position >= 0 && total > position) {
    const dependents = Math.max(0, total - position - 1);
    if (dependents > 0) signals.dependencyCount = dependents;
  }
  if (Number(blockedCount) > 0) signals.blockedCount = Number(blockedCount);
  return signals;
}

/**
 * @returns {{ priority: number, factors: object, reasons: string[] }}
 */
export function derivePriority(signals = {}, { now = Date.now() } = {}) {
  const input = signals && typeof signals === "object" ? signals : {};
  const reasons = [];

  const urgency = urgencyScore(input.urgency);
  const deadline = deadlineScore(input.deadlineAt ?? input.deadline, now);
  const impact = impactScore(input.impact);
  const fanOutCount = countOf(input.dependencyCount ?? input.dependencies);
  const blockedCount = countOf(input.blockedCount ?? input.blocked);

  let score = 0;
  if (urgency !== null) {
    score += urgency * PRIORITY_WEIGHTS.urgency;
    reasons.push("urgency " + urgency.toFixed(2));
  }
  if (deadline !== null) {
    score += deadline * PRIORITY_WEIGHTS.deadline;
    reasons.push(deadline === 1 ? "deadline passed" : "deadline pressure " + deadline.toFixed(2));
  }
  if (impact !== null) {
    score += impact * PRIORITY_WEIGHTS.impact;
    reasons.push("impact " + impact.toFixed(2));
  }
  if (fanOutCount > 0) {
    score += (fanOutCount / 10) * PRIORITY_WEIGHTS.fanOut;
    reasons.push(fanOutCount + " dependent task(s)");
  }
  const blockedBonus = blockedCount > 0 ? Math.min(BLOCKED_BONUS_MAX, blockedCount * 5) : 0;
  if (blockedBonus > 0) {
    score += blockedBonus;
    reasons.push(blockedCount + " blocked item(s) released");
  }

  const priority = Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(score)));
  return {
    priority,
    factors: {
      urgency,
      deadline,
      impact,
      dependencyCount: fanOutCount,
      blockedCount,
      blockedBonus,
      raw: Number(score.toFixed(2))
    },
    reasons: reasons.length ? reasons : ["no signals supplied"]
  };
}
