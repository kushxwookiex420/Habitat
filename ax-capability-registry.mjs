/**
 * AX capability registry.
 *
 * One catalog answers "what can this deployment actually do, and what may it never do without the
 * owner". Availability is derived from configuration that exists in this process: a capability whose
 * credential is missing reports `unconfigured` and names the variable, never a secret value.
 *
 * Construction refuses an unsafe catalog. A capability that can spend money, move money, publish
 * outside the system, mint a credential or install software MUST declare `requiresApproval`, and a
 * paid capability MUST declare `requiresApproval`. That invariant is enforced here once, so a new
 * entry cannot be added that quietly bypasses the approval system.
 */

export const CAPABILITY_KINDS = Object.freeze([
  "model",
  "builder",
  "creative",
  "website",
  "api",
  "android",
  "fulfillment",
  "treasury",
  "governance"
]);

export const CAPABILITY_STATES = Object.freeze([
  "available",
  "configured_unverified",
  "unconfigured",
  "policy_only",
  "adapter_missing",
  "disabled"
]);

/** Side effects that may only ever be described, never executed autonomously. */
export const GATED_SIDE_EFFECTS = Object.freeze([
  "payment",
  "transfer",
  "payout",
  "external_publish",
  "publication",
  "oauth",
  "credentials",
  "install",
  "destructive"
]);

const POLICY_ONLY_DETAIL = "Policy entry only. No adapter exists in this deployment, and the action requires the owner.";

function requireString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("A capability needs a " + name + ".");
  return text;
}

function normalize(capability) {
  const entry = {
    id: requireString(capability.id, "id"),
    kind: requireString(capability.kind, "kind"),
    name: requireString(capability.name, "name"),
    purpose: requireString(capability.purpose, "purpose"),
    sideEffects: requireString(capability.sideEffects, "sideEffects"),
    state: requireString(capability.state, "state"),
    detail: String(capability.detail ?? "").trim() || null,
    envKeys: [...new Set((capability.envKeys || []).map(key => String(key).trim()).filter(Boolean))],
    cost: {
      model: String(capability.cost?.model || "none"),
      note: String(capability.cost?.note || "No billable provider is called by this capability.")
    },
    requiresApproval: capability.requiresApproval === true,
    approvalActions: [...new Set((capability.approvalActions || []).map(action => String(action)))],
    freeFirst: capability.freeFirst !== false
  };
  if (!CAPABILITY_KINDS.includes(entry.kind)) throw new Error("Unknown capability kind: " + entry.kind);
  if (!CAPABILITY_STATES.includes(entry.state)) throw new Error("Unknown capability state: " + entry.state);
  if (GATED_SIDE_EFFECTS.includes(entry.sideEffects) && !entry.requiresApproval) {
    throw new Error("Capability " + entry.id + " has side effect \"" + entry.sideEffects + "\" and must require owner approval.");
  }
  if (entry.cost.model === "paid" && !entry.requiresApproval) {
    throw new Error("Paid capability " + entry.id + " must require owner approval before any spend.");
  }
  if (entry.state === "policy_only" && !entry.requiresApproval) {
    throw new Error("Policy-only capability " + entry.id + " must require owner approval.");
  }
  return Object.freeze(entry);
}

/** The catalog this deployment ships with. Everything unproven says so. */
export function defaultCapabilities() {
  return [
    {
      id: "model.planning",
      kind: "model",
      name: "Planning model",
      purpose: "Turn an objective into an ordered plan and review specialist output.",
      sideEffects: "read",
      state: "available",
      detail: "Uses the configured Ax provider. Model calls are budgeted by the existing cost governor.",
      envKeys: ["OPENAI_API_KEY"],
      cost: { model: "paid", note: "Token billing applies at the provider's rate; the cost governor enforces the daily ceiling." },
      requiresApproval: true,
      approvalActions: ["raise_budget"]
    },
    {
      id: "model.embedding",
      kind: "model",
      name: "Embedding model",
      purpose: "Index memory entries for retrieval.",
      sideEffects: "read",
      state: "adapter_missing",
      detail: "Memory retrieval is lexical in this deployment; no embedding provider is wired.",
      cost: { model: "none" }
    },
    {
      id: "builder.code",
      kind: "builder",
      name: "Sandboxed code builder",
      purpose: "Write and run code in an isolated sandbox before proposing a change.",
      sideEffects: "write",
      state: "adapter_missing",
      detail: "No sandbox execution provider is mounted in this process.",
      cost: { model: "compute", note: "Compute time only; no provider is called." }
    },
    {
      id: "builder.content",
      kind: "builder",
      name: "Content builder",
      purpose: "Draft product pages, captions and scripts from approved sources.",
      sideEffects: "write",
      state: "available",
      detail: "Runs in-process using the content engine; nothing is published by this capability.",
      cost: { model: "none" }
    },
    {
      id: "creative.image",
      kind: "creative",
      name: "Image generation",
      purpose: "Generate product or marketing imagery.",
      sideEffects: "write",
      state: "configured_unverified",
      detail: "A provider key may be present, but no image call has been verified from this deployment.",
      envKeys: ["OPENROUTER_API_KEY"],
      cost: { model: "paid", note: "Per-image provider pricing applies." },
      requiresApproval: true,
      approvalActions: ["generate_image"]
    },
    {
      id: "creative.video",
      kind: "creative",
      name: "Video rendering",
      purpose: "Render short product or content videos.",
      sideEffects: "write",
      state: "adapter_missing",
      detail: "Rendering code exists in the repository but is not exposed through the capability network.",
      cost: { model: "compute", note: "Local compute only." }
    },
    {
      id: "website.static",
      kind: "website",
      name: "Static site generation",
      purpose: "Generate public legal, product and informational pages.",
      sideEffects: "write",
      state: "available",
      detail: "Pages are rendered in-process. Deployment is a separate, approval-gated action.",
      cost: { model: "none" }
    },
    {
      id: "website.deploy",
      kind: "website",
      name: "Website deployment",
      purpose: "Publish generated pages to production hosting.",
      sideEffects: "publication",
      state: "policy_only",
      detail: POLICY_ONLY_DETAIL + " Deploying to production is a separate owner decision.",
      cost: { model: "none" },
      requiresApproval: true,
      approvalActions: ["deploy"]
    },
    {
      id: "api.service",
      kind: "api",
      name: "Habitat HTTP API",
      purpose: "Serve the Ax command, device and control-center surfaces.",
      sideEffects: "read",
      state: "available",
      detail: "This process. Every route keeps its existing credential and owner-device requirements.",
      cost: { model: "none" }
    },
    {
      id: "api.external",
      kind: "api",
      name: "External API call",
      purpose: "Call a third-party HTTP API.",
      sideEffects: "read",
      state: "adapter_missing",
      detail: "No general external HTTP adapter is exposed from the capability network.",
      cost: { model: "none" }
    },
    {
      id: "android.bridge",
      kind: "android",
      name: "Android Bridge relay",
      purpose: "Reach the paired phone for presence and allowlisted device actions.",
      sideEffects: "device_control",
      state: "available",
      detail: "Queues through the existing relay. The phone executes when it next polls.",
      envKeys: ["HOME_BRIDGE_URL", "HOME_BRIDGE_AX_TOKEN"],
      cost: { model: "none" }
    },
    {
      id: "android.control",
      kind: "android",
      name: "Device control",
      purpose: "Change device state, data or installed software.",
      sideEffects: "destructive",
      state: "policy_only",
      detail: POLICY_ONLY_DETAIL + " No destructive device adapter exists and none is planned for autonomous use.",
      cost: { model: "none" },
      requiresApproval: true,
      approvalActions: ["clear", "remote", "install", "uninstall"]
    },
    {
      id: "fulfillment.catalog",
      kind: "fulfillment",
      name: "Supplier catalog",
      purpose: "Describe suppliers, order models and what each one actually is.",
      sideEffects: "read",
      state: "available",
      detail: "Static, versioned catalog in this repository. It performs no supplier call.",
      cost: { model: "none" }
    },
    {
      id: "fulfillment.quotes",
      kind: "fulfillment",
      name: "Live supplier quote",
      purpose: "Fetch a live price, shipping cost and dispatch estimate from a supplier.",
      sideEffects: "read",
      state: "adapter_missing",
      detail: "No supplier OAuth connection or API credential exists in this deployment.",
      cost: { model: "none" }
    },
    {
      id: "fulfillment.purchase",
      kind: "fulfillment",
      name: "Supplier purchase",
      purpose: "Place a supplier order.",
      sideEffects: "payment",
      state: "policy_only",
      detail: POLICY_ONLY_DETAIL + " Routing stops at a live quote and an owner approval bound to that exact quote.",
      cost: { model: "none" },
      requiresApproval: true,
      approvalActions: ["purchase"]
    },
    {
      id: "fulfillment.publish",
      kind: "fulfillment",
      name: "Channel listing",
      purpose: "Publish or change a marketplace listing.",
      sideEffects: "external_publish",
      state: "policy_only",
      detail: POLICY_ONLY_DETAIL + " Channel eligibility must be proven before a listing is changed.",
      cost: { model: "none" },
      requiresApproval: true,
      approvalActions: ["publish_listing"]
    },
    {
      id: "treasury.ledger",
      kind: "treasury",
      name: "Treasury ledger",
      purpose: "Report cash, pipeline and commitments from recorded events.",
      sideEffects: "read",
      state: "available",
      detail: "Only settled and available amounts count as cash. Estimated and invoiced amounts never do.",
      cost: { model: "none" }
    },
    {
      id: "treasury.transfer",
      kind: "treasury",
      name: "Money transfer",
      purpose: "Move money between accounts.",
      sideEffects: "transfer",
      state: "policy_only",
      detail: POLICY_ONLY_DETAIL + " No wallet or payout adapter is connected.",
      cost: { model: "none" },
      requiresApproval: true,
      approvalActions: ["transfer"]
    },
    {
      id: "treasury.payout_account",
      kind: "treasury",
      name: "Payout account change",
      purpose: "Add or change where a channel pays out.",
      sideEffects: "payout",
      state: "policy_only",
      detail: POLICY_ONLY_DETAIL + " Payout-account changes always require the owner.",
      cost: { model: "none" },
      requiresApproval: true,
      approvalActions: ["change_payout_account"]
    },
    {
      id: "integration.oauth",
      kind: "governance",
      name: "Third-party authorization",
      purpose: "Connect a supplier, marketplace or ad account.",
      sideEffects: "oauth",
      state: "policy_only",
      detail: POLICY_ONLY_DETAIL + " No OAuth connection is initiated by this deployment.",
      cost: { model: "none" },
      requiresApproval: true,
      approvalActions: ["connect"]
    },
    {
      id: "governance.approvals",
      kind: "governance",
      name: "Owner approval ledger",
      purpose: "Record, decide and consume approvals for gated actions.",
      sideEffects: "read",
      state: "available",
      detail: "Decisions require a paired owner device. Ax may request an approval; it may never satisfy one.",
      cost: { model: "none" }
    }
  ];
}

/** Derive the reported state from what is actually configured in this process. */
export function resolveCapabilityState(capability, env = process.env) {
  const declared = capability.state;
  if (declared === "policy_only" || declared === "adapter_missing" || declared === "disabled") {
    return { state: declared, detail: capability.detail };
  }
  const keys = capability.envKeys || [];
  if (!keys.length) return { state: declared, detail: capability.detail };
  const missing = keys.filter(key => !String(env?.[key] ?? "").trim());
  if (missing.length) {
    return { state: "unconfigured", detail: "Not configured: set " + missing.join(", ") + "." };
  }
  return { state: declared, detail: capability.detail };
}

/**
 * @param {object} options
 * @param {object} [options.env]       configuration only; values are never returned
 * @param {Array}  [options.capabilities] override catalog (validated with the same invariants)
 */
export function createCapabilityRegistry({ env = process.env, capabilities = null, now = () => new Date().toISOString() } = {}) {
  const raw = Array.isArray(capabilities) ? capabilities : defaultCapabilities();
  const entries = raw.map(capability => {
    const normalized = normalize(capability);
    const resolved = resolveCapabilityState(normalized, env);
    return Object.freeze({ ...normalized, state: resolved.state, detail: resolved.detail });
  });
  const byId = new Map(entries.map(entry => [entry.id, entry]));

  return Object.freeze({
    list({ kind = null, state = null } = {}) {
      return entries
        .filter(entry => (kind ? entry.kind === kind : true))
        .filter(entry => (state ? entry.state === state : true))
        .map(entry => ({ ...entry }));
    },
    get(id) {
      const entry = byId.get(String(id || ""));
      return entry ? { ...entry } : null;
    },
    /** Approval is required by the capability or by the named action. Unknown capabilities fail closed. */
    approvalRequiredFor(id, action = null) {
      const entry = byId.get(String(id || ""));
      if (!entry) return { required: true, known: false, reason: "Unknown capability: treat as approval gated." };
      if (entry.requiresApproval) return { required: true, known: true, reason: entry.id + " is approval gated." };
      if (action && entry.approvalActions.includes(String(action))) {
        return { required: true, known: true, reason: entry.id + " action \"" + action + "\" is approval gated." };
      }
      return { required: false, known: true, reason: null };
    },
    summary() {
      const byKind = {};
      const byState = {};
      for (const entry of entries) {
        byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
        byState[entry.state] = (byState[entry.state] || 0) + 1;
      }
      return {
        ok: true,
        count: entries.length,
        byKind,
        byState,
        approvalGated: entries.filter(entry => entry.requiresApproval).map(entry => entry.id),
        generatedAt: now(),
        note: "State is derived from this process's configuration. A configured credential is not proof that a provider call succeeds."
      };
    },
    capabilities: entries.map(entry => ({ ...entry }))
  });
}
