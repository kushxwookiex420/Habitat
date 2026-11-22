import { createHash } from "node:crypto";
import { planMissionSteps, missionTerms, MISSION_ROLE_IDS } from "./ax-mission-plan.mjs";

/**
 * Specialized agent runtime.
 *
 * These are not seven labels on one prompt. Each agent declares a capability manifest (what it may
 * read, what it may never do, which permissions it needs), and its handler performs a distinct,
 * bounded piece of work against a real dependency:
 *
 *   research     → an injected search transport (absent ⇒ capability_unavailable, no invention)
 *   engineering  → an injected sandbox/adapter runner (absent ⇒ capability_unavailable)
 *   security     → audits the registry's adapters and permissions
 *   operations   → probes mounted subsystems through diagnostics
 *   memory       → retrieves approved memory and returns citations
 *   content      → builds a draft-only content plan; publishing always needs approval
 *   device       → reports the real phone capability manifest and connection state
 *
 * Ax stays the coordinator: a delegated result is only an input. `review()` re-checks the evidence,
 * the confidence and the declared permissions before Ax may use it, and a sensitive action in an
 * agent's output is downgraded to an approval request rather than executed.
 *
 * Runaway protection is enforced here, not in prompts: maximum depth, cycle rejection, maximum
 * delegations, a wall-clock deadline and a per-delegation cost ceiling.
 */

export const AGENT_IDS = Object.freeze(["director", "research", "engineering", "security", "operations", "memory", "verification", "content", "device"]);

export const AGENT_LIMITS = Object.freeze({
  maxDepth: 2,
  maxDelegations: 12,
  maxWallClockMs: 60_000,
  maxDelegationCostUsd: 0.02,
  minConfidence: 0.2,
  maxEvidence: 20,
  maxSummary: 800,
  minSummary: 12
});

const SENSITIVE_ACTION = /^(publish|purchase|refund|deploy|account\.|device\.(destructive|shell)|payment\.)/i;

/**
 * Capability manifests. `available` is decided at runtime by whether the dependency was supplied;
 * the declared `requires` list names it, so an unavailable agent can explain exactly what is missing
 * instead of returning a generic failure.
 */
export const AGENT_MANIFESTS = Object.freeze({
  /**
   * Director decomposes an objective. It deliberately has no model dependency: the routing rule is
   * deterministic, so a plan can be reviewed and replayed, and a mission cannot be invented into
   * existence by a prompt.
   */
  director: Object.freeze({
    id: "director",
    name: "Director",
    purpose: "Decompose an objective into ordered work for the specialists that can actually do it.",
    requires: null,
    permissions: ["plan.write", "agent.route"],
    forbidden: ["publish", "purchase", "deploy", "credential.read"],
    approvalRequired: [],
    produces: "ordered mission plan",
    maxProviderCostUsd: 0
  }),
  research: Object.freeze({
    id: "research",
    name: "Research",
    purpose: "Gather sources and evaluate claims with explicit citations.",
    requires: "research",
    permissions: ["web.read"],
    forbidden: ["web.write", "purchase", "publish"],
    approvalRequired: [],
    produces: "sourced notes",
    maxProviderCostUsd: 0.01
  }),
  engineering: Object.freeze({
    id: "engineering",
    name: "Engineering",
    purpose: "Inspect code, run the read-only adapter path and report test evidence.",
    requires: "engineering",
    permissions: ["repo.read", "sandbox.exec"],
    forbidden: ["repo.write.outside.workspace", "deploy", "publish"],
    approvalRequired: ["repo.write", "deploy"],
    produces: "change or test evidence",
    maxProviderCostUsd: 0.02
  }),
  security: Object.freeze({
    id: "security",
    name: "Security",
    purpose: "Audit adapter allowlists, permissions and unsafe behaviour.",
    requires: null,
    permissions: ["policy.read", "registry.read"],
    forbidden: ["credential.read", "policy.weaken"],
    approvalRequired: [],
    produces: "severity-ranked findings",
    maxProviderCostUsd: 0
  }),
  operations: Object.freeze({
    id: "operations",
    name: "Operations",
    purpose: "Probe services, queues, scheduler and workers; report real subsystem state.",
    requires: "diagnostics",
    permissions: ["health.read", "logs.read"],
    forbidden: ["deploy", "database.write", "purchase"],
    approvalRequired: ["deploy"],
    produces: "health evidence",
    maxProviderCostUsd: 0
  }),
  memory: Object.freeze({
    id: "memory",
    name: "Memory",
    purpose: "Retrieve approved project memory and propose durable knowledge.",
    requires: "memory",
    permissions: ["memory.read", "memory.propose"],
    forbidden: ["memory.promote", "credential.read"],
    approvalRequired: ["memory.promote"],
    produces: "cited memory context",
    maxProviderCostUsd: 0
  }),
  /**
   * Verification is independent of the agents that produced the work. It re-reads the stored
   * evidence against the acceptance criteria and returns checks the objective service can record. It
   * may reject a result, but it can never approve an action or complete an objective by itself.
   */
  verification: Object.freeze({
    id: "verification",
    name: "Verification",
    purpose: "Independently check recorded evidence against acceptance criteria and reject unsupported claims.",
    requires: null,
    permissions: ["verification.read", "verification.verify"],
    forbidden: ["verification.override", "publish", "purchase", "deploy", "credential.read"],
    approvalRequired: [],
    produces: "acceptance checks",
    maxProviderCostUsd: 0
  }),
  content: Object.freeze({
    id: "content",
    name: "Content",
    purpose: "Prepare DropPilot and Vice City Files drafts without publishing.",
    requires: null,
    permissions: ["content.draft"],
    forbidden: ["publish", "purchase", "customer.contact"],
    approvalRequired: ["publish", "purchase"],
    produces: "draft plan",
    maxProviderCostUsd: 0
  }),
  device: Object.freeze({
    id: "device",
    name: "Device",
    purpose: "Report the paired phone's capabilities and state; never act without approval.",
    requires: "device",
    permissions: ["device.status.read"],
    forbidden: ["device.shell", "device.destructive", "device.privacy"],
    approvalRequired: ["device.command"],
    produces: "device state and capability report",
    maxProviderCostUsd: 0
  })
});

/**
 * Deterministic routing. Distinct objectives land on distinct agents. `director` and `verification`
 * are intentionally absent: they are assigned by role, never guessed from keywords, because a
 * verification request must not be routed to the agent that wrote the work.
 */
const ROUTING = Object.freeze([
  { agent: "research", weight: 3, pattern: /\b(research|source|compare|investigate|find out|cite|market|competitor)\b/i },
  { agent: "engineering", weight: 3, pattern: /\b(code|repo|test|build|bug|refactor|implement|typescript|kotlin|fix)\b/i },
  { agent: "security", weight: 3, pattern: /\b(security|permission|audit|threat|vulnerab|exploit|token|auth)\b/i },
  { agent: "operations", weight: 3, pattern: /\b(health|deploy|monitor|queue|worker|scheduler|incident|uptime|log)\b/i },
  { agent: "memory", weight: 3, pattern: /\b(remember|memory|recall|decision|history|preference|context)\b/i },
  { agent: "content", weight: 3, pattern: /\b(droppilot|vice city|content|script|video|caption|listing|tiktok|shopify)\b/i },
  { agent: "device", weight: 3, pattern: /\b(phone|device|android|bridge|pair|battery|heartbeat)\b/i }
]);

export function selectAgent(objective) {
  const text = String(objective || "");
  const scored = ROUTING.map(entry => {
    const matches = text.match(new RegExp(entry.pattern.source, "gi")) || [];
    return { agent: entry.agent, score: matches.length * entry.weight };
  }).sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));
  const best = scored[0];
  if (!best || best.score === 0) {
    return { agent: "operations", reason: "no specialist keyword matched; operations performs the safe default health check", score: 0 };
  }
  return { agent: best.agent, reason: "matched " + best.score + " routing signal(s) for " + best.agent, score: best.score };
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 32);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })
  ]);
}

/**
 * The runtime.
 *
 * Handlers are injected so tests can prove routing and evidence collection without a network or a
 * paid model. A missing handler is reported as an unavailable capability, never simulated.
 */
export function createAgentRuntime({
  dependencies = {},
  limits = {},
  log = console,
  onSecurityEvent = null,
  now = () => new Date().toISOString()
} = {}) {
  const config = { ...AGENT_LIMITS, ...limits };
  let delegations = 0;
  const scopes = new Map();

  function scopeOf(name) {
    const key = clean(name, 160) || "process";
    if (!scopes.has(key)) scopes.set(key, { startedAt: Date.now(), delegations: 0 });
    return scopes.get(key);
  }

  function available(id) {
    const manifest = AGENT_MANIFESTS[id];
    if (!manifest) return false;
    if (!manifest.requires) return true;
    if (id === "security") return true; // audits only what it was given
    const dependency = dependencies[manifest.requires];
    return dependency !== undefined && dependency !== null;
  }

  function capabilityMatrix() {
    return AGENT_IDS.map(id => {
      const manifest = AGENT_MANIFESTS[id];
      return {
        id: manifest.id,
        name: manifest.name,
        purpose: manifest.purpose,
        implemented: true,
        available: available(id),
        missingCapability: available(id) ? null : manifest.requires,
        permissions: manifest.permissions.slice(),
        forbidden: manifest.forbidden.slice(),
        approvalRequired: manifest.approvalRequired.slice(),
        produces: manifest.produces
      };
    });
  }

  function unavailable(id, reason) {
    const manifest = AGENT_MANIFESTS[id];
    return {
      ok: false,
      code: "capability_unavailable",
      agent: id,
      reason,
      missingCapability: manifest?.requires || null,
      evidence: [],
      confidence: 0,
      limitations: ["No result was produced. This agent needs " + (manifest?.requires || "a configured dependency") + "."]
    };
  }

  async function runHandler(id, input) {
    const manifest = AGENT_MANIFESTS[id];
    if (!manifest) return { ok: false, code: "unknown_agent" };
    if (!available(id)) return unavailable(id, "dependency_not_configured");
    const timeoutMs = Math.min(config.maxWallClockMs, 15_000);

    if (id === "director") {
      const context = input.context && typeof input.context === "object" ? input.context : {};
      // Model-backed planning is injected, never assumed. It validates its own response and falls
      // back deterministically; this handler only decides which plan shape to return.
      if (dependencies.missionPlanner && typeof dependencies.missionPlanner.plan === "function") {
        try {
          const planned = await dependencies.missionPlanner.plan({
            objective: input.objective,
            criteria: Array.isArray(context.criteria) ? context.criteria : [],
            capabilities: context.capabilities && typeof context.capabilities === "object" ? context.capabilities : {}
          });
          if (planned?.ok === true && Array.isArray(planned.plan?.steps) && planned.plan.steps.length) {
            const plan = planned.plan;
            const fallback = planned.fallback === true;
            const missing = Array.isArray(plan.missingCapabilities) ? plan.missingCapabilities : [];
            return {
              ok: true,
              summary: (fallback
                ? "Deterministic fallback plan (" + (planned.fallbackReason || "model_unavailable") + "): "
                : "Model plan via " + (planned.provider || "model") + ": ") +
                plan.steps.map(step => step.agent).join(" -> ") + ". Missing capabilities: " + (missing.join(", ") || "none") + ".",
              confidence: fallback ? 0.6 : 0.85,
              evidence: [
                { summary: "plan: " + plan.steps.map((step, index) => (index + 1) + ":" + step.agent + ":" + step.objective).join(" | "), source: "agent:director" },
                { summary: "planner: mode=" + (fallback ? "deterministic-fallback" : "model") + ", provider=" + (planned.provider || "none") + ", model=" + (planned.model || "none") + ", costUsd=" + Number(planned.costUsd || 0).toFixed(6) + ", fallbackReason=" + (planned.fallbackReason || "none"), source: "agent:director" }
              ],
              plan,
              planner: { mode: fallback ? "deterministic-fallback" : "model", provider: planned.provider || null, model: planned.model || null, costUsd: Number(planned.costUsd || 0), fallbackReason: planned.fallbackReason || null },
              limitations: [fallback
                ? "The model was unavailable, refused or invalid; deterministic routing produced this plan."
                : "Model plan validated against the agent registry; security review and independent verification are appended."]
            };
          }
        } catch {
          // A planner failure is not a mission failure: the deterministic plan below still runs.
        }
      }
      const plan = planMissionSteps({
        objective: input.objective,
        criteria: Array.isArray(context.criteria) ? context.criteria : [],
        capabilities: context.capabilities && typeof context.capabilities === "object" ? context.capabilities : {}
      });
      const capabilityLine = MISSION_ROLE_IDS
        .map(role => role + "=" + (plan.capabilities[role] ? "available" : "unavailable"))
        .join(", ");
      return {
        ok: true,
        summary: "Planned " + plan.steps.length + " step(s): " + plan.steps.map(step => step.agent).join(" -> ") +
          ". Missing capabilities: " + (plan.missingCapabilities.join(", ") || "none") + ".",
        confidence: plan.missingCapabilities.length ? 0.5 : 0.85,
        evidence: [
          {
            summary: "plan: " + plan.steps.map((step, index) => (index + 1) + ":" + step.agent + ":" + step.objective).join(" | "),
            source: "agent:director"
          },
          { summary: "capabilities: " + capabilityLine, source: "agent:director" }
        ],
        plan,
        limitations: ["Deterministic routing from the objective text, criteria and mounted capabilities; no model was consulted."]
      };
    }

    if (id === "verification") {
      const context = input.context && typeof input.context === "object" ? input.context : {};
      const criteria = Array.isArray(context.criteria) ? context.criteria.slice(0, 12) : [];
      const evidence = Array.isArray(context.evidence) ? context.evidence.slice(0, 60) : [];
      if (criteria.length === 0) {
        return { ok: false, code: "criteria_required", agent: "verification", evidence: [], confidence: 0 };
      }
      const usable = evidence.filter(item => item && typeof item.id === "string" && typeof item.summary === "string" && item.summary.trim().length >= 8);
      const checks = criteria.map(criterion => {
        const criterionId = clean(criterion.id, 64);
        const wanted = missionTerms(criterion.statement, 8);
        const scored = usable
          .map(item => {
            const summary = item.summary.toLowerCase();
            const score = wanted.reduce((total, term) => total + (summary.includes(term) ? 1 : 0), 0);
            return { item, score };
          })
          // Two independent terms are required when the criterion has them; a single shared word is
          // too weak to call evidence coverage.
          .filter(entry => entry.score >= (wanted.length >= 2 ? 2 : 1))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        if (!scored.length) {
          return { criterionId, evidenceIds: [], passed: false, detail: "no stored evidence matched this criterion" };
        }
        return {
          criterionId,
          evidenceIds: scored.map(entry => entry.item.id),
          passed: true,
          detail: "matched " + scored.length + " evidence item(s) on " + wanted.filter(term => scored[0].item.summary.toLowerCase().includes(term)).slice(0, 4).join(", ")
        };
      });
      const failed = checks.filter(check => !check.passed);
      return {
        ok: true,
        passed: failed.length === 0,
        summary: "Checked " + checks.length + " acceptance criterion/criteria against " + usable.length +
          " stored evidence item(s); " + failed.length + " unmet.",
        confidence: 0.75,
        evidence: [
          {
            summary: "verification: " + checks.map(check => check.criterionId + "=" + (check.passed ? "met" : "unmet")).join(", "),
            source: "agent:verification"
          },
          {
            summary: "evidence reviewed: " + usable.length + " item(s) with ids and summaries",
            source: "agent:verification"
          }
        ],
        checks,
        limitations: ["Keyword relevance between a criterion and the recorded evidence; this is not a semantic proof."]
      };
    }

    if (id === "security") {
      const adapters = Array.isArray(dependencies.adapters) ? dependencies.adapters.slice(0, 40) : [];
      const allowed = Array.isArray(dependencies.allowedAdapters) ? dependencies.allowedAdapters : [];
      const findings = [];
      const unexpected = adapters.filter(name => allowed.length > 0 && !allowed.includes(name));
      if (unexpected.length) {
        findings.push({ severity: "high", finding: "adapters outside the allowlist are registered", detail: unexpected.slice(0, 8) });
      }
      if (allowed.some(name => /delete|drop|deploy|publish|purchase|shell/i.test(name))) {
        findings.push({ severity: "critical", finding: "the adapter allowlist contains a side-effecting name", detail: allowed.filter(name => /delete|drop|deploy|publish|purchase|shell/i.test(name)).slice(0, 8) });
      }
      if (dependencies.sideEffectsEnabled === true) {
        findings.push({ severity: "high", finding: "side-effecting adapters are enabled in a read-only runtime" });
      }
      const summary = findings.length
        ? findings.map(item => item.severity + ": " + item.finding).join("; ")
        : "No allowlist violation found across " + adapters.length + " registered adapter(s).";
      return {
        ok: true,
        summary,
        confidence: 0.9,
        evidence: [
          { summary: "adapter allowlist audit: " + adapters.length + " registered, " + allowed.length + " allowed", source: "agent:security" },
          { summary: "findings: " + (findings.length ? findings.map(item => item.severity).join(",") : "none"), source: "agent:security" }
        ],
        findings,
        limitations: ["Static audit of the supplied registry only; it cannot prove runtime isolation."]
      };
    }

    if (id === "operations") {
      let report = null;
      try {
        report = await dependencies.diagnostics();
      } catch (error) {
        return unavailable(id, "diagnostics_failed: " + clean(error?.message, 120));
      }
      const sections = ["database", "memory", "providers", "scheduler", "sandbox", "notifications", "deviceBridge"]
        .map(key => key + "=" + (report?.[key]?.status || report?.[key]?.state || "unknown"));
      const degraded = sections.filter(line => /unreachable|unavailable|error/.test(line));
      return {
        ok: true,
        summary: "Operational probe: " + sections.join(", "),
        confidence: 0.85,
        evidence: [
          { summary: "diagnostics generated at " + (report?.generatedAt || now()), source: "agent:operations" },
          { summary: "degraded sections: " + (degraded.length ? degraded.join("; ") : "none"), source: "agent:operations" }
        ],
        degraded,
        limitations: ["Provider health is configuration-only unless a live probe ran."]
      };
    }

    if (id === "memory") {
      if (typeof dependencies.memory?.recall !== "function") return unavailable(id, "memory_recall_not_configured");
      const recalled = await dependencies.memory.recall({ objective: input.objective });
      if (!recalled?.ok) return unavailable(id, recalled?.code || "memory_recall_failed");
      const citations = Array.isArray(recalled.citations) ? recalled.citations.slice(0, 10) : [];
      // An empty result is a real observation, not a missing capability. It carries one honest
      // evidence line so the mission continues and verification can still reject work that needed
      // a prior decision.
      const evidence = citations.length
        ? citations.map(citation => ({ summary: "memory " + citation.key + " v" + citation.version + " from " + citation.source, source: "agent:memory" }))
        : [{ summary: "no approved memory entry matched this objective", source: "agent:memory" }];
      return {
        ok: true,
        summary: citations.length
          ? "Recalled " + citations.length + " approved memory record(s) for the objective."
          : "No approved memory matched the objective.",
        confidence: citations.length ? 0.8 : 0.5,
        evidence,
        citations,
        limitations: ["Keyword + metadata ranking; this is not semantic retrieval."]
      };
    }

    if (id === "content") {
      const text = clean(input.objective, AGENT_LIMITS.maxSummary);
      const channel = /\bvice city\b/i.test(text) ? "vice-city-files" : /\bdroppilot\b/i.test(text) ? "droppilot" : "unspecified";
      return {
        ok: true,
        summary: "Draft-only content plan for " + channel + ": " + text,
        confidence: 0.5,
        evidence: [{ summary: "content draft prepared; nothing was published or purchased", source: "agent:content" }],
        draft: { channel, stage: "draft", publishRequiresApproval: true },
        requiresApproval: true,
        limitations: ["Draft only. Publishing, purchases and customer contact are approval-gated and were not performed."]
      };
    }

    if (id === "device") {
      if (typeof dependencies.device?.state !== "function") return unavailable(id, "device_state_not_configured");
      const state = await dependencies.device.state();
      return {
        ok: true,
        summary: "Device state: registered=" + Boolean(state?.registered) + ", authenticated=" + Boolean(state?.authenticated) + ", reachable=" + Boolean(state?.reachable),
        confidence: 0.8,
        evidence: [{ summary: "device report generated from the bridge's durable rows", source: "agent:device" }],
        state,
        requiresApproval: false,
        limitations: ["A paired row is not proof of a command execution; receipts are required."]
      };
    }

    if (input?.signal?.aborted) {
      return { ok: false, code: "aborted", agent: id, evidence: [], confidence: 0, limitations: ["The operator stopped this agent before it returned."] };
    }

    if (id === "research") {
      const run = dependencies.research;
      const result = await run({ objective: input.objective, query: input.query || input.objective, signal: input.signal || null });
      if (result?.ok === false) return unavailable(id, result.code || result.error || "research_transport_failed");
      const sources = Array.isArray(result?.sources) ? result.sources.slice(0, 8) : [];
      return {
        ok: true,
        summary: clean(result?.summary, AGENT_LIMITS.maxSummary) || "Research transport returned no summary.",
        confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : 0.5,
        evidence: sources.map(source => ({
          // Attribution survives into the durable objective: URL, retrieval time and confidence are
          // part of the summary, and the structured fields below are stored when available.
          summary: clean(
            (source.title || source.url || "source") + " | " + (source.excerpt || "") +
              " | " + (source.url || "no-url") + " | retrieved " + (source.retrievedAt || "unknown") +
              " | confidence " + Number(source.confidence ?? 0.5).toFixed(2),
            480
          ),
          source: "agent:research",
          digest: source.digest || digest(source.url || source.title),
          url: clean(source.url, 2_000) || null,
          retrievedAt: clean(source.retrievedAt, 40) || null,
          confidence: Number.isFinite(Number(source.confidence)) ? Number(source.confidence) : 0.5,
          uncertainty: clean(source.uncertainty, 300) || null
        })),
        sources,
        divergences: Array.isArray(result?.divergences) ? result.divergences.slice(0, 5) : [],
        limitations: ["Source verification is limited to what the transport returned."]
      };
    }

    // engineering
    const run = dependencies.engineering;
    const result = await run({ objective: input.objective, files: input.files || [], signal: input.signal || null });
    const commands = Array.isArray(result?.commands) ? result.commands.slice(0, 10) : [];
    const files = Array.isArray(result?.files) ? result.files.slice(0, 8) : [];
    const evidence = commands.map(command => ({
      summary: clean(command.command, 200) + " → exit " + Number(command.exitCode ?? -1) + (command.timedOut ? " (timed out)" : ""),
      source: "agent:engineering",
      digest: command.exitCode === 0 ? null : clean(command.stderrTail, 120) || null
    }));
    for (const file of files) {
      if (!file?.path || !file.digest) continue;
      evidence.push({
        summary: clean(file.path, 200) + " inspected: " + Number(file.lines || 0) + " lines, sha256 " + String(file.digest).slice(0, 16),
        source: "agent:engineering",
        digest: String(file.digest).slice(0, 64)
      });
    }
    const failedCommands = commands.filter(command => Number(command.exitCode ?? -1) !== 0);
    return {
      ok: result?.ok !== false && evidence.length > 0,
      code: result?.ok === false ? "engineering_check_failed" : null,
      summary: clean(result?.summary, AGENT_LIMITS.maxSummary) || "Engineering adapter returned no summary.",
      confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : 0.5,
      evidence,
      files,
      commands,
      // A defect is reported with the failing check and a proposed correction. Nothing is written:
      // the transport is read-only, so the proposal stays an owner-gated recommendation.
      proposedCorrection: failedCommands.length
        ? {
            applied: false,
            requiresApproval: true,
            failingChecks: failedCommands.map(command => ({
              command: clean(command.command, 200),
              exitCode: Number(command.exitCode ?? -1),
              stderrTail: clean(command.stderrTail, 500)
            })),
            proposal: "Repair the failing check(s) above, then rerun the same allowlisted command before claiming a fix."
          }
        : null,
      limitations: ["Only allowlisted read-only adapter commands can run; no write path exists."]
    };
  }

  /**
   * Delegate once. Depth, cycles, total delegations, wall clock and cost are checked before the
   * handler runs; the result is a signed envelope Ax must review before accepting.
   */
  async function delegate({ objective, role = null, depth = 0, chain = [], budgetUsd = AGENT_LIMITS.maxDelegationCostUsd, context = null, scope = "process", signal = null } = {}) {
    const text = clean(objective, 1000);
    if (text.length < 8) return { ok: false, code: "invalid_objective" };
    const selected = role || selectAgent(text).agent;
    if (!AGENT_MANIFESTS[selected]) return { ok: false, code: "unknown_agent", agent: selected, allowed: AGENT_IDS };
    const nextDepth = Number(depth) || 0;
    if (nextDepth > config.maxDepth) {
      return { ok: false, code: "delegation_depth_exceeded", agent: selected, depth: nextDepth, maxDepth: config.maxDepth };
    }
    const history = Array.isArray(chain) ? chain.map(item => String(item)) : [];
    if (history.includes(selected)) {
      return { ok: false, code: "circular_delegation", agent: selected, chain: history.concat(selected) };
    }
    // Budgets are per scope, not per process. A long-lived service that owns many missions must not
    // run out of delegations after twelve of them; one run still cannot exceed its own ceiling.
    const scopeState = scopeOf(scope);
    scopeState.delegations += 1;
    delegations += 1;
    if (scopeState.delegations > config.maxDelegations) {
      return { ok: false, code: "delegation_budget_exhausted", agent: selected, maxDelegations: config.maxDelegations };
    }
    if (Date.now() - scopeState.startedAt > config.maxWallClockMs) {
      return { ok: false, code: "delegation_time_exceeded", agent: selected };
    }
    const amount = Number(budgetUsd);
    if (!Number.isFinite(amount) || amount < 0 || amount > config.maxDelegationCostUsd) {
      return { ok: false, code: "delegation_cost_refused", agent: selected, maxUsd: config.maxDelegationCostUsd };
    }

    let outcome;
    try {
      outcome = await withTimeout(
        runHandler(selected, { objective: text, context: context && typeof context === "object" ? context : null, signal }),
        config.maxWallClockMs,
        "agent_timeout"
      );
    } catch (error) {
      log.error?.("AX_AGENT_FAILED", clean(error?.message, 200));
      return { ok: false, code: error?.message === "agent_timeout" ? "agent_timeout" : "agent_failed", agent: selected, evidence: [] };
    }

    const envelope = {
      delegationId: "dlg_" + digest(now() + "\u0000" + selected + "\u0000" + text + "\u0000" + delegations).slice(0, 20),
      agent: selected,
      depth: nextDepth,
      chain: history.concat(selected),
      objective: text,
      createdAt: now(),
      ok: outcome?.ok === true,
      code: outcome?.code || null,
      summary: clean(outcome?.summary, AGENT_LIMITS.maxSummary),
      confidence: Number(outcome?.confidence ?? 0),
      evidence: (Array.isArray(outcome?.evidence) ? outcome.evidence : []).slice(0, AGENT_LIMITS.maxEvidence).map((item, index) => ({
        id: clean(item?.id, 120) || "agev_" + digest(envelopeSeed(selected, text) + index).slice(0, 16),
        summary: clean(item?.summary, 500),
        source: clean(item?.source, 100) || "agent:" + selected,
        digest: clean(item?.digest, 128) || null,
        url: clean(item?.url, 2_000) || null,
        retrievedAt: clean(item?.retrievedAt, 40) || null,
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
        uncertainty: clean(item?.uncertainty, 300) || null
      })).filter(item => item.summary),
      sources: (Array.isArray(outcome?.sources) ? outcome.sources : []).slice(0, 8).map(source => ({
        title: clean(source?.title, 200) || null,
        url: clean(source?.url, 2_000) || null,
        excerpt: clean(source?.excerpt, 480) || null,
        digest: clean(source?.digest, 128) || null,
        retrievedAt: clean(source?.retrievedAt, 40) || null,
        confidence: Number.isFinite(Number(source?.confidence)) ? Number(source.confidence) : null,
        uncertainty: clean(source?.uncertainty, 300) || null
      })).filter(source => source.url),
      divergences: Array.isArray(outcome?.divergences) ? outcome.divergences.slice(0, 5) : [],
      planner: outcome?.planner || null,
      limitations: (Array.isArray(outcome?.limitations) ? outcome.limitations : []).slice(0, 6).map(item => clean(item, 240)),
      requiresApproval: outcome?.requiresApproval === true,
      findings: Array.isArray(outcome?.findings) ? outcome.findings.slice(0, 10) : [],
      citations: Array.isArray(outcome?.citations) ? outcome.citations.slice(0, 10) : [],
      missingCapability: outcome?.missingCapability || null,
      degraded: Array.isArray(outcome?.degraded) ? outcome.degraded.slice(0, 10) : [],
      draft: outcome?.draft || null,
      state: outcome?.state || null,
      plan: outcome?.plan || null,
      checks: Array.isArray(outcome?.checks) ? outcome.checks.slice(0, 12) : null,
      passed: typeof outcome?.passed === "boolean" ? outcome.passed : null,
      proposedCorrection: outcome?.proposedCorrection || null,
      costUsd: Math.min(amount, Number(outcome?.costUsd || 0)),
      provider: clean(outcome?.provider, 64) || null
    };
    if (!envelope.ok) {
      envelope.evidence = [];
      envelope.confidence = 0;
    }
    envelope.digest = digest(JSON.stringify({ agent: envelope.agent, objective: envelope.objective, evidence: envelope.evidence, confidence: envelope.confidence }));
    return envelope;
  }

  function envelopeSeed(agent, text) {
    return agent + "\u0000" + text;
  }

  /**
   * Ax's acceptance check. A delegated result is not trusted because an agent said it succeeded:
   * the envelope must be internally consistent, carry evidence, not claim a forbidden action and not
   * exceed the manifest's permissions.
   */
  function review(envelope) {
    if (!envelope || typeof envelope !== "object") return { accepted: false, code: "invalid_envelope" };
    const manifest = AGENT_MANIFESTS[envelope.agent];
    if (!manifest) return { accepted: false, code: "unknown_agent" };
    if (envelope.ok !== true) {
      return { accepted: false, code: envelope.code || "agent_reported_failure", agent: envelope.agent };
    }
    const expected = digest(JSON.stringify({
      agent: envelope.agent,
      objective: envelope.objective,
      evidence: envelope.evidence,
      confidence: envelope.confidence
    }));
    if (expected !== envelope.digest) return { accepted: false, code: "envelope_digest_mismatch" };
    if (!Array.isArray(envelope.evidence) || envelope.evidence.length === 0) {
      return { accepted: false, code: "evidence_required", agent: envelope.agent };
    }
    if (!(Number(envelope.confidence) >= config.minConfidence && Number(envelope.confidence) <= 1)) {
      return { accepted: false, code: "confidence_out_of_range", agent: envelope.agent, confidence: envelope.confidence };
    }
    const text = (envelope.summary || "") + " " + envelope.evidence.map(item => item.summary).join(" ");
    const forbidden = (manifest.forbidden || []).find(action => new RegExp("\\b" + action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, "\\.") + "\\b", "i").test(text));
    if (forbidden && SENSITIVE_ACTION.test(forbidden)) {
      try {
        onSecurityEvent?.({
          agent: envelope.agent,
          summary: "Agent output claimed a forbidden action: " + forbidden,
          evidence: envelope.delegationId || null
        });
      } catch {
        // An audit hook must never decide the verdict.
      }
      return { accepted: false, code: "forbidden_action_claim", agent: envelope.agent, action: forbidden };
    }
    return {
      accepted: true,
      agent: envelope.agent,
      confidence: Number(envelope.confidence),
      requiresApproval: envelope.requiresApproval === true,
      evidenceCount: envelope.evidence.length,
      note: envelope.requiresApproval ? "Result is usable, but the declared action remains owner-gated." : null
    };
  }

  /**
   * Route and review in one call. A rejected result is returned with its reasons; it never becomes
   * an accepted fact just because a handler answered.
   */
  async function delegateAndReview(input = {}) {
    const envelope = await delegate(input);
    if (envelope.ok !== true) return { ok: false, envelope, review: { accepted: false, code: envelope.code || "delegation_failed" } };
    const verdict = review(envelope);
    return { ok: verdict.accepted, envelope, review: verdict };
  }

  return Object.freeze({
    agents: AGENT_IDS.slice(),
    capabilityMatrix,
    selectAgent,
    delegate,
    delegateAndReview,
    review,
    available,
    // A resumable mission can clear its own budget without touching any other mission's counters.
    resetScope: name => {
      const key = clean(name, 160) || "process";
      scopes.delete(key);
      return { ok: true, scope: key };
    },
    limits: Object.freeze({ ...config }),
    delegations: () => delegations
  });
}
