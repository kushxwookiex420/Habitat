import { getRole } from "./agent-roles.mjs";

/**
 * The tool registry.
 *
 * Every entry says what the tool is for, what it takes and returns, which roles may use it, whether
 * it is actually available in this process, what it costs, whether it has side effects, and whether
 * it needs owner approval. Availability is derived from configuration that actually exists: a tool
 * whose credential is missing is reported as `unconfigured` with the variable name, never as ready.
 *
 * `adapter_missing` is the honest state for the planned integrations in the mission brief (web
 * search, browser, sandboxed execution, image/video generation). The entry exists so plans can
 * reference it, and the API admits the adapter is not wired, rather than pretending it works.
 */

const SIDE_EFFECTS = Object.freeze([
  "none",
  "read",
  "device_control",
  "write",
  "external_publish",
  "payment",
  "destructive",
  "credentials"
]);

function configured(env, keys) {
  return keys.every(key => String(env[key] || "").trim().length > 0);
}

function missing(env, keys) {
  return keys.filter(key => !String(env[key] || "").trim());
}

function tool({ name, purpose, inputSchema, outputSchema, roles, availability, cost = { model: "none", note: "No billable provider is called by this tool." }, sideEffects, requiresApproval = false, approvalActions = [], timeoutMs = 30000, retries = { attempts: 1, backoffMs: 0 }, destructive = false }) {
  if (!SIDE_EFFECTS.includes(sideEffects)) throw new Error(`Unknown side-effect class: ${sideEffects}`);
  return Object.freeze({
    name,
    purpose,
    inputSchema,
    outputSchema,
    roles: Object.freeze(roles),
    availability: Object.freeze(availability),
    cost: Object.freeze(cost),
    sideEffects,
    requiresApproval: Boolean(requiresApproval || destructive),
    approvalActions: Object.freeze(approvalActions),
    destructive: Boolean(destructive),
    timeoutMs,
    retries: Object.freeze(retries),
    audit: true
  });
}

export function createToolRegistry({ env = process.env } = {}) {
  const relayKeys = ["HOME_BRIDGE_URL", "HOME_BRIDGE_AX_TOKEN"];
  const relayReady = configured(env, relayKeys);
  const relayGap = relayReady ? null : `Not configured: set ${missing(env, relayKeys).join(", ")}.`;

  const entries = [
    tool({
      name: "system.health",
      purpose: "Report this Habitat process's own status. It proves the HTTP server answered, nothing more.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" }, uptimeSeconds: { type: "integer" } } },
      roles: ["ax", "sentinel", "atlas", "nexus", "orion"],
      availability: { state: "available", detail: "Always answers from this process." },
      sideEffects: "read"
    }),
    tool({
      name: "files.shared.list",
      purpose: "List the Home Bridge shared folder: build reports, artifacts, notes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: { files: { type: "array", items: { type: "object" } } } },
      roles: ["ax", "nexus", "orion", "sentinel", "atlas"],
      availability: relayReady
        ? { state: "available", detail: "Relay credentials are configured." }
        : { state: "unconfigured", detail: relayGap },
      sideEffects: "read"
    }),
    tool({
      name: "files.shared.read",
      purpose: "Read one shared file by name, using the server-held ax credential.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      outputSchema: { type: "object", properties: { name: { type: "string" }, encoding: { type: "string" }, data: { type: "string" } } },
      roles: ["ax", "nexus", "orion", "sentinel"],
      availability: relayReady
        ? { state: "available", detail: "Relay credentials are configured." }
        : { state: "unconfigured", detail: relayGap },
      sideEffects: "read"
    }),
    tool({
      name: "android.command",
      purpose: "Queue an allowlisted action on the paired Android device through the relay.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "page", "app", "torch", "clear", "remote", "url"] },
          arg: { type: "string" }
        },
        required: ["action"]
      },
      outputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } },
      roles: ["atlas", "ax"],
      availability: relayReady
        ? { state: "available", detail: "Queues through the relay; the phone executes it when it next polls." }
        : { state: "unconfigured", detail: relayGap },
      sideEffects: "device_control",
      approvalActions: ["clear", "remote"],
      timeoutMs: 15000,
      retries: { attempts: 2, backoffMs: 500 }
    }),
    tool({
      name: "android.destructive",
      purpose: "Policy entry for device actions that change or remove user data. Never automated.",
      inputSchema: { type: "object", properties: { intent: { type: "string" } }, required: ["intent"] },
      outputSchema: { type: "object", properties: { executed: { type: "boolean" } } },
      roles: ["atlas"],
      availability: { state: "policy_only", detail: "No destructive device adapter exists; this entry exists so approvals can be required." },
      sideEffects: "destructive",
      requiresApproval: true
    }),
    tool({
      name: "github.read",
      purpose: "Read commits and repository metadata from GitHub.",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" }, commits: { type: "array" } } },
      roles: ["ax", "nexus", "orion", "sentinel"],
      availability: {
        state: "available",
        detail: configured(env, ["GITHUB_TOKEN"])
          ? "Authenticated read."
          : "Public read without a token, which is rate limited."
      },
      sideEffects: "read"
    }),
    tool({
      name: "github.write",
      purpose: "Commit files and push branches to a repository.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, branch: { type: "string" }, files: { type: "array" } }, required: ["repo", "files"] },
      outputSchema: { type: "object", properties: { commit: { type: "string" } } },
      roles: ["nexus"],
      availability: configured(env, ["GITHUB_TOKEN"])
        ? { state: "available", detail: "GITHUB_TOKEN is configured." }
        : { state: "unconfigured", detail: "Not configured: set GITHUB_TOKEN." },
      sideEffects: "write",
      timeoutMs: 60000,
      retries: { attempts: 2, backoffMs: 1000 }
    }),
    tool({
      name: "web.search",
      purpose: "Internet search for research and source verification.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { type: "object", properties: { results: { type: "array" } } },
      roles: ["orion", "ax"],
      availability: { state: "adapter_missing", detail: "No search provider adapter is registered in this backend yet." },
      sideEffects: "read"
    }),
    tool({
      name: "web.browser",
      purpose: "Fetch and read a specific page.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      outputSchema: { type: "object", properties: { text: { type: "string" } } },
      roles: ["orion", "ax"],
      availability: { state: "adapter_missing", detail: "No browser adapter is registered in this backend yet." },
      sideEffects: "read"
    }),
    tool({
      name: "sandbox.exec",
      purpose: "Run code in an isolated sandbox and capture its output.",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      outputSchema: { type: "object", properties: { exitCode: { type: "integer" }, stdout: { type: "string" } } },
      roles: ["nexus", "sentinel"],
      availability: { state: "adapter_missing", detail: "No sandbox provider is registered in this backend yet." },
      sideEffects: "write",
      timeoutMs: 120000
    }),
    tool({
      name: "image.generate",
      purpose: "Generate a product or marketing image.",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      outputSchema: { type: "object", properties: { url: { type: "string" } } },
      roles: ["nexus"],
      availability: configured(env, ["OPENROUTER_API_KEY"])
        ? { state: "configured_unverified", detail: "A provider key exists, but no image call has been verified from this registry." }
        : { state: "unconfigured", detail: "Not configured: set OPENROUTER_API_KEY." },
      cost: { model: "per_image", note: "Provider pricing applies; no cost is estimated here." },
      sideEffects: "write",
      timeoutMs: 120000
    }),
    tool({
      name: "video.create",
      purpose: "Render a short product or content video.",
      inputSchema: { type: "object", properties: { brief: { type: "string" } }, required: ["brief"] },
      outputSchema: { type: "object", properties: { url: { type: "string" } } },
      roles: ["nexus"],
      availability: { state: "adapter_missing", detail: "Content rendering exists in this repo but is not exposed through this registry yet." },
      cost: { model: "compute", note: "Rendering costs compute time; no figure is estimated here." },
      sideEffects: "write",
      timeoutMs: 300000
    }),
    tool({
      name: "shopify.read",
      purpose: "Read products, orders and revenue for a connected store.",
      inputSchema: { type: "object", properties: { store: { type: "string" } }, required: ["store"] },
      outputSchema: { type: "object", properties: { products: { type: "array" } } },
      roles: ["ax", "orion", "atlas"],
      availability: { state: "unconfigured", detail: "No store is connected to this process, so sales and profit are not shown rather than estimated." },
      sideEffects: "read"
    }),
    tool({
      name: "tiktok.publish",
      purpose: "Publish content to TikTok.",
      inputSchema: { type: "object", properties: { asset: { type: "string" }, caption: { type: "string" } }, required: ["asset"] },
      outputSchema: { type: "object", properties: { published: { type: "boolean" }, url: { type: "string" } } },
      roles: ["atlas"],
      availability: { state: "unconfigured", detail: "No TikTok authorization is connected; publishing stays approval gated and unverified." },
      sideEffects: "external_publish",
      requiresApproval: true
    }),
    tool({
      name: "publish.external",
      purpose: "Policy entry for publishing anything outside this system.",
      inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      outputSchema: { type: "object", properties: { published: { type: "boolean" } } },
      roles: ["ax", "atlas"],
      availability: { state: "policy_only", detail: "Approval policy entry; no generic publish adapter exists." },
      sideEffects: "external_publish",
      requiresApproval: true
    }),
    tool({
      name: "deploy.render",
      purpose: "Deploy or restart a Render service.",
      inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
      outputSchema: { type: "object", properties: { deployed: { type: "boolean" } } },
      roles: ["nexus", "atlas"],
      availability: { state: "unconfigured", detail: "No Render API credential is configured in this process, and production deploys need owner approval." },
      sideEffects: "write",
      requiresApproval: true
    }),
    tool({
      name: "payment.spend",
      purpose: "Policy entry for spending money or purchasing anything.",
      inputSchema: { type: "object", properties: { amount: { type: "number" }, currency: { type: "string" } }, required: ["amount"] },
      outputSchema: { type: "object", properties: { charged: { type: "boolean" } } },
      roles: ["ax"],
      availability: { state: "policy_only", detail: "No payment adapter exists; approval is mandatory before any spend." },
      sideEffects: "payment",
      requiresApproval: true
    }),
    tool({
      name: "account.credentials",
      purpose: "Policy entry for changing account security or credentials.",
      inputSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
      outputSchema: { type: "object", properties: { changed: { type: "boolean" } } },
      roles: ["sentinel", "ax"],
      availability: { state: "policy_only", detail: "Credentials are set by the owner in the provider console; no agent changes them." },
      sideEffects: "credentials",
      requiresApproval: true
    })
  ];

  const byName = new Map(entries.map(entry => [entry.name, entry]));

  const registry = {
    adapter: "in-process",
    list({ role } = {}) {
      const wanted = role ? getRole(role) : null;
      return entries.filter(entry => !wanted || wanted.allowedTools.includes(entry.name));
    },
    get(name) {
      return byName.get(String(name || "")) || null;
    },
    isRoleAllowed(roleId, toolName) {
      const role = getRole(roleId);
      if (!role) return false;
      return role.allowedTools.includes(toolName);
    },
    /** Approval is required by the tool itself or by the action being requested. */
    approvalRequiredFor(toolName, action) {
      const entry = byName.get(String(toolName || ""));
      if (!entry) return { required: false, known: false };
      if (entry.requiresApproval) return { required: true, reason: `${entry.name} is approval gated.` };
      if (action && entry.approvalActions.includes(String(action))) {
        return { required: true, reason: `${entry.name} action "${action}" is approval gated.` };
      }
      return { required: false, known: true };
    },
    summary() {
      const states = {};
      for (const entry of entries) states[entry.availability.state] = (states[entry.availability.state] || 0) + 1;
      return {
        ok: true,
        count: entries.length,
        states,
        tools: entries.map(entry => ({
          name: entry.name,
          purpose: entry.purpose,
          roles: entry.roles,
          availability: entry.availability,
          cost: entry.cost,
          sideEffects: entry.sideEffects,
          requiresApproval: entry.requiresApproval,
          approvalActions: entry.approvalActions,
          timeoutMs: entry.timeoutMs,
          retries: entry.retries
        }))
      };
    }
  };
  return Object.freeze(registry);
}
