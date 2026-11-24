/**
 * Identity section of `/system/status`.
 *
 * The only facts published are the ones that make a continuity claim checkable: the identity digest,
 * whether the durable record matches it, whether a memory repository is attached, and how many
 * owner-approved directives exist. No provider, model, credential or memory statement is included.
 */

export function summarizeIdentity(input) {
  if (!input || typeof input !== "object") {
    return {
      state: "not_configured",
      name: null,
      digest: null,
      providerIndependent: false,
      persisted: false,
      directives: { total: 0, preferences: 0, goals: 0, decisions: 0 },
      detail: "No identity runtime is attached to this process."
    };
  }
  const directives = input.directives || {};
  return {
    state: input.state || "not_configured",
    name: input.name || null,
    version: input.version || null,
    digest: input.digest || null,
    providerIndependent: input.providerIndependent === true,
    repository: input.repository === true,
    persisted: input.stored === true,
    directives: {
      total: Number(directives.total || 0),
      preferences: Number(directives.preferences || 0),
      goals: Number(directives.goals || 0),
      decisions: Number(directives.decisions || 0)
    },
    detail: input.detail || "No detail reported."
  };
}
