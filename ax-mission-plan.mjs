/**
 * Mission planning for the agent work cycle.
 *
 * A mission plan is not a model answer. It is a deterministic routing decision made from the
 * objective text, the acceptance criteria and the capabilities this build actually has. The
 * Director agent returns it, the work cycle persists it, and every step names a specialist whose
 * handler does real work. A capability that is not mounted is reported as missing; the cycle blocks
 * instead of inventing a result.
 *
 * There is no model call here, so routing is reviewable and free. A later revision may replace this
 * planner with a model, but the plan shape and the capability gate stay the same.
 */

export const MISSION_ROLE_IDS = Object.freeze([
  "memory",
  "research",
  "engineering",
  "operations",
  "security",
  "verification"
]);

const RESEARCH_SIGNAL = /\b(research|investigate|source|sources|cite|citation|evidence|compare|competitor|documentation|readme|repo|repository|file|code|test|build|bug|fix|implement|inspect)\b/i;
const ENGINEERING_SIGNAL = /\b(code|repo|repository|file|files|test|tests|build|bug|fix|implement|refactor|syntax|module|function|kotlin|javascript|typescript)\b/i;
const OPERATIONS_SIGNAL = /\b(health|deploy|monitor|queue|worker|scheduler|incident|uptime|log|logs|service|runtime)\b/i;

const STOPWORDS = new Set([
  "the", "and", "that", "this", "with", "from", "into", "then", "than", "must", "should",
  "will", "have", "has", "was", "were", "for", "are", "not", "all", "any", "can", "its",
  "their", "they", "them", "been", "being", "when", "where", "which", "while", "each"
]);

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Words a criterion and an evidence summary can be compared on. */
export function missionTerms(text, max = 10) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter(word => word.length >= 4 && !STOPWORDS.has(word))
  )].slice(0, max);
}

export function criterionStatements(criteria = []) {
  return (Array.isArray(criteria) ? criteria : [])
    .map(item => (typeof item === "string" ? item : item?.statement))
    .map(item => clean(item, 300))
    .filter(Boolean);
}

/**
 * Build an ordered plan.
 *
 * @param {object} input
 * @param {string} input.objective
 * @param {Array}  [input.criteria]   criterion records or statements
 * @param {object} [input.capabilities] role -> boolean, as reported by the agent runtime
 */
export function planMissionSteps({ objective, criteria = [], capabilities = {} } = {}) {
  const text = clean(objective, 2000);
  const statements = criterionStatements(criteria);
  const haystack = text + " " + statements.join(" ");
  const available = {
    memory: capabilities.memory === true,
    research: capabilities.research === true,
    engineering: capabilities.engineering === true,
    operations: capabilities.operations === true,
    security: capabilities.security !== false,
    verification: capabilities.verification !== false
  };

  const wantsResearch = RESEARCH_SIGNAL.test(haystack);
  const wantsEngineering = ENGINEERING_SIGNAL.test(haystack);
  const wantsOperations = OPERATIONS_SIGNAL.test(haystack);
  const steps = [];
  const missingCapabilities = [];

  if (available.memory) {
    steps.push({
      key: "memory",
      agent: "memory",
      objective: "Recall approved project memory and prior decisions relevant to: " + text,
      requiresApproval: false
    });
  }

  if (wantsResearch) {
    if (available.research) {
      steps.push({
        key: "research",
        agent: "research",
        objective: "Gather citable evidence from the configured research source for: " + text,
        requiresApproval: false
      });
    } else {
      missingCapabilities.push("research");
    }
  }

  if (wantsEngineering) {
    if (available.engineering) {
      steps.push({
        key: "engineering",
        agent: "engineering",
        objective: "Inspect the named code and run the allowlisted checks for: " + text,
        requiresApproval: false
      });
    } else {
      missingCapabilities.push("engineering");
    }
  }

  if (wantsOperations) {
    if (available.operations) {
      steps.push({
        key: "operations",
        agent: "operations",
        objective: "Probe mounted services and report real subsystem state for: " + text,
        requiresApproval: false
      });
    } else {
      missingCapabilities.push("operations");
    }
  }

  // Security review and independent verification are never optional: a result without both is not
  // a completed mission.
  steps.push({
    key: "security",
    agent: "security",
    objective: "Audit the adapter allowlist and permissions relevant to: " + text,
    requiresApproval: false
  });
  steps.push({
    key: "verification",
    agent: "verification",
    objective: "Independently check the recorded evidence against every acceptance criterion for: " + text,
    requiresApproval: false
  });

  const uniqueMissing = [...new Set(missingCapabilities)];
  return {
    ok: uniqueMissing.length === 0,
    strategy: "deterministic-routing",
    objective: text,
    criteria: statements,
    steps: steps.map((step, index) => ({ ...step, index })),
    capabilities: available,
    missingCapabilities: uniqueMissing,
    note: uniqueMissing.length
      ? "Required capabilities are not mounted: " + uniqueMissing.join(", ") + ". The mission is blocked rather than simulated."
      : "Every step has a mounted capability."
  };
}
