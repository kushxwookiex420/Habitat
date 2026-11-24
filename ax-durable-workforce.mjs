import { createWorkforce } from "./ax-workforce.mjs";

/**
 * Durable workforce: the in-memory engine plus a write-through store.
 *
 * The engine stays the single place where the rules live (capacity, conflicts, independence of
 * verification). This wrapper adds persistence around it: every mutation is written after the engine
 * accepts it, and `hydrate()` rebuilds the engine from the store, so a new process continues an
 * in-flight assignment instead of starting over.
 *
 * Adapters are code, not data: the caller supplies them again on startup. What the store keeps is the
 * adapter *record* (id, kind, replaceable), so a removed provider is visible in history even when its
 * code is gone.
 */

function auditPayload(entry) {
  return { at: entry.at, action: entry.action, ...entry };
}

export function createDurableWorkforce({ repository, adapters = [], now = () => new Date().toISOString(), log = console } = {}) {
  if (!repository || typeof repository.initialize !== "function") {
    throw new Error("The durable workforce needs a repository.");
  }
  const engine = createWorkforce({ now, log });
  let hydrated = false;
  let auditCursor = 0;

  async function flushAudit() {
    const history = engine.history();
    const fresh = history.slice(auditCursor);
    auditCursor = history.length;
    if (fresh.length > 0) await repository.appendAudit(fresh.map(auditPayload));
  }

  async function saveAgents() {
    for (const agent of engine.agents()) await repository.saveAgent(agent);
  }

  async function saveAssignments() {
    for (const assignment of engine.assignments()) await repository.saveAssignment(assignment);
  }

  async function saveResults() {
    for (const result of engine.results()) {
      await repository.saveResult({
        ...result,
        approvalState: result.approvalState || (result.approved === true ? "approved" : result.approvalRequired === true ? "required" : "not_required")
      });
    }
  }

  async function hydrate({ force = false } = {}) {
    if (hydrated && !force) return { ok: true, cached: true };
    await repository.initialize();
    for (const adapter of adapters) engine.registerAdapter(adapter);
    const storedAgents = await repository.listAgents();
    const storedAssignments = await repository.listAssignments();
    const storedResults = await repository.listResults();
    const storedAudit = await repository.listAudit();
    engine.restore({ agents: storedAgents, assignments: storedAssignments, results: storedResults, audit: storedAudit });
    auditCursor = engine.history().length;
    hydrated = true;
    for (const adapter of engine.adapters()) await repository.saveAdapter(adapter);
    const counts = await repository.counts();
    return { ok: true, hydrated: true, agents: storedAgents.length, assignments: storedAssignments.length, results: storedResults.length, audit: storedAudit.length, counts };
  }

  async function registerAdapter(adapter) {
    await hydrate();
    const outcome = engine.registerAdapter(adapter);
    if (outcome.ok) {
      const record = engine.adapters().find(item => item.id === outcome.adapterId);
      if (record) await repository.saveAdapter(record);
    }
    await flushAudit();
    return outcome;
  }

  async function registerAgent(input) {
    await hydrate();
    const outcome = engine.registerAgent(input);
    if (outcome.ok) await saveAgents();
    await flushAudit();
    return outcome;
  }

  async function replaceAgent(id, patch) {
    await hydrate();
    const outcome = engine.replaceAgent(id, patch);
    if (outcome.ok) await saveAgents();
    await flushAudit();
    return outcome;
  }

  async function removeAgent(id) {
    await hydrate();
    const outcome = engine.removeAgent(id);
    if (outcome.ok) await repository.deleteAgent(id);
    await flushAudit();
    return outcome;
  }

  async function healthCheck(id) {
    await hydrate();
    const outcome = await engine.healthCheck(id);
    await saveAgents();
    await flushAudit();
    return outcome;
  }

  async function assign(input) {
    await hydrate();
    const outcome = engine.assign(input);
    if (outcome.ok) await saveAssignments();
    await flushAudit();
    return outcome;
  }

  async function release(input) {
    await hydrate();
    const outcome = engine.release(input);
    if (outcome.ok) await saveAssignments();
    await flushAudit();
    return outcome;
  }

  async function retry(input) {
    await hydrate();
    const outcome = engine.retry(input);
    if (outcome.assignment) await saveAssignments();
    await flushAudit();
    return outcome;
  }

  async function handoff(input) {
    await hydrate();
    const outcome = engine.handoff(input);
    if (outcome.ok || outcome.assignment) await saveAssignments();
    await flushAudit();
    return outcome;
  }

  async function finalize(input) {
    await hydrate();
    const outcome = engine.finalize(input);
    if (outcome.result) await saveResults();
    await saveAssignments();
    await flushAudit();
    return outcome;
  }

  /** Owner approval is a separate act from verification and is stored separately. */
  async function approve({ resultId, state = "approved", by = "owner" } = {}) {
    await hydrate();
    return repository.setApproval({ resultId, state, by });
  }

  return Object.freeze({
    hydrate,
    registerAdapter,
    registerAgent,
    replaceAgent,
    removeAgent,
    healthCheck,
    assign,
    release,
    retry,
    handoff,
    finalize,
    approve,
    agents: options => engine.agents(options),
    agent: id => engine.agent(id),
    assignments: () => engine.assignments(),
    results: () => engine.results(),
    history: () => engine.history(),
    summarize: () => engine.summarize(),
    recommendConcurrency: options => engine.recommendConcurrency(options),
    repository: () => ({ adapter: repository.adapter, durable: repository.durable === true })
  });
}
