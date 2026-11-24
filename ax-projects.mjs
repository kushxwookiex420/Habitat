/**
 * Project intelligence.
 *
 * Habitat, DropPilot and Vice City Files share one runtime but never share authority. This registry
 * answers "what is the verified state of this project, what work is open, what did we decide, what
 * evidence exists" from durable objectives and approved memory. It deliberately does not merge
 * histories: every lookup is scoped to one project id, and an objective may not be re-scoped after
 * creation.
 */

export const PROJECT_IDS = Object.freeze(["habitat", "droppilot", "vice-city-files"]);

export const PROJECT_DEFINITIONS = Object.freeze({
  habitat: Object.freeze({
    id: "habitat",
    name: "Habitat",
    description: "The Ax operating environment, NEXUS execution layer and phone bridge.",
    agents: ["engineering", "security", "operations", "memory"],
    integrations: [
      { name: "Cloudflare D1", purpose: "durable tasks, objectives, memory, audit", state: "not_checked" },
      { name: "Render", purpose: "API and worker host", state: "not_checked" },
      { name: "GitHub", purpose: "source, CI and releases", state: "not_checked" }
    ],
    requiredApprovals: ["production deploy", "database migration", "secret change"],
    boundaries: ["no production writes without owner authorization", "no paid model call by default"]
  }),
  droppilot: Object.freeze({
    id: "droppilot",
    name: "DropPilot",
    description: "Product research, economics, listings and order monitoring.",
    agents: ["research", "content", "operations"],
    integrations: [
      { name: "Shopify", purpose: "catalogue and orders", state: "not_checked" },
      { name: "Supplier sources", purpose: "product and cost data", state: "not_checked" }
    ],
    requiredApprovals: ["publish listing", "purchase", "refund", "customer contact", "price change"],
    boundaries: ["draft-only until the owner approves", "never spends money on the owner's behalf"]
  }),
  "vice-city-files": Object.freeze({
    id: "vice-city-files",
    name: "Vice City Files",
    description: "Research, scripting, production planning and publishing preparation.",
    agents: ["research", "content", "security"],
    integrations: [
      { name: "Publishing platforms", purpose: "scheduled release", state: "not_checked" },
      { name: "Asset storage", purpose: "video and source material", state: "not_checked" }
    ],
    requiredApprovals: ["publish", "schedule release", "use third-party footage"],
    boundaries: ["draft-only until the owner approves", "source verification is recorded, not assumed"]
  })
});

export function normalizeProject(value) {
  const id = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return PROJECT_IDS.includes(id) ? id : null;
}

/** True only when the action's project is the same project the work belongs to. */
export function projectScopeAllows(ownerProject, actionProject) {
  const owner = normalizeProject(ownerProject);
  const action = normalizeProject(actionProject);
  return Boolean(owner && action && owner === action);
}

export function createProjectRegistry({
  objectives = null,
  memory = null,
  now = () => new Date().toISOString()
} = {}) {
  function definition(id) {
    const normalized = normalizeProject(id);
    return normalized ? PROJECT_DEFINITIONS[normalized] : null;
  }

  async function objectivesFor(id) {
    if (!objectives) return { available: false, rows: [] };
    try {
      const rows = await objectives.list({ limit: 200 });
      return { available: true, rows: rows.filter(item => normalizeProject(item.project) === id) };
    } catch {
      return { available: false, rows: [] };
    }
  }

  async function memoryFor(id, text) {
    if (!memory || typeof memory.recall !== "function") return { available: false, entries: [] };
    try {
      const recalled = await memory.recall({ objective: String(text || PROJECT_DEFINITIONS[id].description).slice(0, 400), project: id });
      return { available: recalled?.ok === true, entries: Array.isArray(recalled?.entries) ? recalled.entries.slice(0, 10) : [], citations: recalled?.citations || [] };
    } catch {
      return { available: false, entries: [] };
    }
  }

  async function detail(id) {
    const project = definition(id);
    if (!project) return null;
    const owned = await objectivesFor(project.id);
    const memoryRows = await memoryFor(project.id);
    const active = owned.rows.filter(item => !["completed", "failed", "cancelled"].includes(item.status));
    const open = owned.rows.filter(item => ["blocked", "failed", "interrupted", "recovery_required"].includes(item.status));
    const awaiting = owned.rows.filter(item => item.status === "awaiting_approval");
    const evidence = owned.rows.flatMap(item => (item.evidence || []).map(entry => ({
      objectiveId: item.id,
      evidenceId: entry.id,
      summary: entry.summary,
      source: entry.source,
      recordedAt: entry.recordedAt
    }))).slice(0, 20);
    return {
      ok: true,
      project: {
        ...project,
        verifiedState: {
          // "active" here means durable records exist for this project; it is not a claim that every
          // integration is healthy.
          status: owned.available ? (owned.rows.length ? "active" : "no_recorded_work") : "unknown",
          basis: owned.available ? "durable objectives scoped to this project" : "objective store unavailable",
          observedAt: now()
        },
        objectives: {
          available: owned.available,
          total: owned.rows.length,
          active: active.length,
          awaitingApproval: awaiting.length,
          byStatus: owned.rows.reduce((counts, item) => {
            counts[item.status] = (counts[item.status] || 0) + 1;
            return counts;
          }, {}),
          recent: owned.rows.slice(0, 8).map(item => ({
            id: item.id,
            objective: item.objective,
            status: item.status,
            criteriaMet: (item.criteria || []).filter(entry => entry.met).length,
            costUsd: Number(item.costUsd || 0),
            updatedAt: item.updatedAt
          }))
        },
        openIssues: open.slice(0, 10).map(item => ({
          objectiveId: item.id,
          status: item.status,
          error: item.error || item.note || null,
          updatedAt: item.updatedAt
        })),
        approvals: awaiting.slice(0, 10).map(item => ({ objectiveId: item.id, requestedAt: item.approval?.requestedAt || null, reason: item.error || null })),
        memory: {
          available: memoryRows.available,
          entries: memoryRows.entries.map(entry => ({
            key: entry.key,
            kind: entry.kind,
            statement: entry.statement,
            version: entry.version,
            confidence: entry.confidence,
            source: entry.provenance?.source || "unknown"
          })),
          note: "Only approved memory is returned. Imported claims remain labelled claims."
        },
        evidence,
        agents: project.agents.slice(),
        integrations: project.integrations.map(integration => ({ ...integration })),
        requiredApprovals: project.requiredApprovals.slice(),
        boundaries: project.boundaries.slice(),
        // Explicit rather than implied: a project's work never authorizes another project's action.
        scope: { project: project.id, crossProjectActions: "denied", enforcedBy: "projectScopeAllows" }
      }
    };
  }

  async function list() {
    const projects = [];
    for (const id of PROJECT_IDS) {
      const found = await detail(id);
      if (found) projects.push(found.project);
    }
    return { ok: true, count: projects.length, projects, projectsAvailable: PROJECT_IDS.slice() };
  }

  return Object.freeze({ list, detail, definition, scopeAllows: projectScopeAllows });
}
