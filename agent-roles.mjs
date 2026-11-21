/**
 * The Habitat team, as logical roles.
 *
 * These are routing labels and prompt contracts used to plan and review work inside this backend.
 * None of them is a separately deployed agent runtime: `deployed` is false everywhere and the API
 * says so, so nothing in the product can claim five independent agents exist when they do not.
 * A role becomes `deployed: true` only when a real runtime with its own credentials, queue and
 * failure handling is registered here.
 */
export const AGENT_ROLES = Object.freeze({
  ax: Object.freeze({
    id: "ax",
    name: "AX",
    title: "Orchestrator",
    deployed: false,
    purpose: "Understand the objective, plan it, choose tools, track progress and verify the result.",
    responsibilities: [
      "restate the objective and refuse vague success",
      "produce a plan whose steps name a role and, when needed, a registered tool",
      "route work to NEXUS, ORION, SENTINEL and ATLAS",
      "verify each claimed result against real evidence before marking a task done",
      "return the completed work or an honest blocker"
    ],
    allowedTools: ["files.shared.list", "files.shared.read", "github.read", "web.search", "system.health"],
    approvalRequired: ["deploy.render", "account.credentials", "publish.external", "payment.spend"]
  }),
  nexus: Object.freeze({
    id: "nexus",
    name: "NEXUS",
    title: "Builder",
    deployed: false,
    purpose: "Create and edit applications, write code, build APKs and websites, test and repair.",
    responsibilities: [
      "change code in a repository rather than describing a change",
      "build and test what it changed",
      "report build failures and unrun tests as failures",
      "attach the artifact link only after the artifact exists"
    ],
    allowedTools: ["files.shared.list", "files.shared.read", "github.read", "github.write", "sandbox.exec"],
    approvalRequired: ["deploy.render", "publish.external"]
  }),
  orion: Object.freeze({
    id: "orion",
    name: "ORION",
    title: "Research",
    deployed: false,
    purpose: "Internet research, comparisons, documentation and source verification, opportunity research.",
    responsibilities: [
      "cite the source for every factual claim",
      "distinguish what a source says from what was actually verified",
      "say when a source could not be read"
    ],
    allowedTools: ["web.search", "web.browser", "files.shared.list", "files.shared.read"],
    approvalRequired: []
  }),
  sentinel: Object.freeze({
    id: "sentinel",
    name: "SENTINEL",
    title: "Security and quality",
    deployed: false,
    purpose: "Permission checks, security review, test verification and failure monitoring.",
    responsibilities: [
      "check that a role only used tools it is allowed to use",
      "refuse a completion whose evidence does not match the claim",
      "flag credential exposure and forbidden operations"
    ],
    allowedTools: ["system.health", "github.read", "files.shared.list", "files.shared.read", "sandbox.exec"],
    approvalRequired: ["account.credentials"]
  }),
  atlas: Object.freeze({
    id: "atlas",
    name: "ATLAS",
    title: "Operations",
    deployed: false,
    purpose: "Task coordination, scheduling, background workflow tracking, notifications and recovery.",
    responsibilities: [
      "keep task state durable across restarts",
      "surface interrupted work as interrupted, never as done",
      "deliver notifications for completion, failure and approval requests"
    ],
    allowedTools: ["system.health", "android.command", "files.shared.list"],
    approvalRequired: ["android.destructive", "deploy.render"]
  })
});

export const ROLE_IDS = Object.freeze(Object.keys(AGENT_ROLES));

export function getRole(id) {
  const role = AGENT_ROLES[String(id || "").trim().toLowerCase()];
  return role || null;
}

/**
 * A listing that cannot be mistaken for a deployment report.
 */
export function describeRoles() {
  return {
    ok: true,
    roles: ROLE_IDS.map(id => {
      const role = AGENT_ROLES[id];
      return {
        id: role.id,
        name: role.name,
        title: role.title,
        purpose: role.purpose,
        responsibilities: role.responsibilities,
        allowedTools: role.allowedTools,
        approvalRequired: role.approvalRequired,
        deployed: role.deployed
      };
    }),
    deployedAgents: ROLE_IDS.filter(id => AGENT_ROLES[id].deployed),
    note: "These are logical roles used for planning and review in this backend. No separate agent runtime is deployed for them yet."
  };
}
