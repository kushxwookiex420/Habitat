import { createCapabilityRegistry } from "./ax-capability-registry.mjs";
import { createApprovalGate } from "./ax-approval-gate.mjs";
import { catalogSummary, evaluateSupplierFit, getSupplier, listSuppliers, SUPPLIER_CATALOG } from "./ax-fulfillment-catalog.mjs";
import { CHANNELS, DECISIONS, ELIGIBILITY_RULES, evaluateChannelEligibility, rulesForChannel } from "./ax-channel-eligibility.mjs";
import { summarizeTreasury, validatePayout, validateRevenueEvent } from "./ax-treasury.mjs";
import { createNetworkRepositoryFromEnv } from "./ax-network-repository.mjs";

/**
 * The AX network surface: capabilities, fulfillment catalog, channel eligibility, approval ledger
 * and treasury reporting, over one repository.
 *
 * It is deliberately not an executor. There is no purchase, order, transfer or OAuth call anywhere
 * in this module. The furthest a caller can get is: read a catalog, evaluate eligibility, request an
 * approval, record observed bookkeeping, and read a treasury summary.
 */

const CASH_STATE_NAMES = Object.freeze(["settled", "available"]);

export function createAxNetworkService({
  env = process.env,
  repository = null,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  fetchImpl = fetch
} = {}) {
  const repo = repository || createNetworkRepositoryFromEnv(env, { fetchImpl });
  const registry = createCapabilityRegistry({ env, now });
  const gate = createApprovalGate({
    repository: repo.approvals,
    now,
    nowMs
  });

  let seeding = null;

  async function seed() {
    await repo.initialize();
    const stamp = now();
    for (const capability of registry.capabilities) {
      await repo.capabilities.put({ ...capability, updatedAt: stamp });
    }
    for (const supplier of SUPPLIER_CATALOG) {
      await repo.suppliers.put({
        id: supplier.id,
        layer: supplier.layer,
        orderModel: supplier.orderModel,
        status: supplier.verification,
        ...supplier,
        updatedAt: stamp
      });
    }
    for (const rule of ELIGIBILITY_RULES) {
      await repo.channels.put({
        id: rule.id,
        channel: rule.channel,
        decision: rule.decision,
        statement: rule.statement,
        updatedAt: stamp
      });
    }
    return { ok: true, capabilities: registry.capabilities.length, suppliers: SUPPLIER_CATALOG.length, rules: ELIGIBILITY_RULES.length };
  }

  function initialize() {
    if (!seeding) {
      seeding = seed().catch(error => {
        seeding = null;
        throw error;
      });
    }
    return seeding;
  }

  async function capabilities() {
    return {
      ok: true,
      ...registry.summary(),
      capabilities: registry.capabilities.map(capability => ({ ...capability }))
    };
  }

  async function suppliers({ layer = null, orderModel = null, country = null } = {}) {
    return {
      ok: true,
      catalog: catalogSummary(),
      count: listSuppliers({ layer, orderModel, country }).length,
      suppliers: listSuppliers({ layer, orderModel, country }),
      layer: layer || null,
      orderModel: orderModel || null
    };
  }

  async function supplier(id) {
    const found = getSupplier(id);
    return found ? { ok: true, supplier: found } : { ok: false, code: "not_found", error: "No supplier with that id." };
  }

  async function evaluateSupplier(input = {}) {
    return { ok: true, evaluation: evaluateSupplierFit(input) };
  }

  async function channels() {
    return {
      ok: true,
      channels: [...CHANNELS],
      decisions: [...DECISIONS],
      rules: ELIGIBILITY_RULES.map(rule => ({ ...rule })),
      automatedApproval: false,
      note: "Eligibility is evaluated per order. Nothing here publishes, orders or pays."
    };
  }

  async function evaluateChannel(input = {}) {
    return { ok: true, evaluation: evaluateChannelEligibility(input), rules: rulesForChannel(input.channel) };
  }

  async function treasury() {
    const [revenueEvents, payouts, approvals] = await Promise.all([
      repo.revenueEvents.list({ limit: 5000 }),
      repo.payouts.list({ limit: 5000 }),
      repo.approvals.list({ limit: 5000 })
    ]);
    const accounts = await repo.accounts.list({ limit: 200 });
    return {
      ok: true,
      ...summarizeTreasury({ revenueEvents, payouts, approvals, now: nowMs() }),
      accounts: accounts.map(account => ({
        id: account.id,
        kind: account.kind,
        status: account.status,
        label: account.label || null
      }))
    };
  }

  async function revenueEvents({ limit = 100 } = {}) {
    const events = await repo.revenueEvents.list({ limit });
    return { ok: true, count: events.length, events };
  }

  async function payouts({ limit = 100 } = {}) {
    const events = await repo.payouts.list({ limit });
    return { ok: true, count: events.length, payouts: events };
  }

  /**
   * Record an observed revenue state. This is bookkeeping, not a transaction: no channel is
   * contacted. The route decides which actor may record which state; this function only validates.
   */
  async function recordRevenue(input = {}) {
    const checked = validateRevenueEvent(input);
    if (!checked.ok) return { ok: false, code: checked.code, error: checked.error };
    const existing = await repo.revenueEvents.get(checked.event.id);
    if (existing) {
      return { ok: false, code: "duplicate_event", error: "A revenue event with that id is already recorded." };
    }
    const record = {
      ...checked.event,
      actor: String(input.actor || "unknown").slice(0, 160),
      createdAt: now()
    };
    await repo.revenueEvents.put(record);
    return { ok: true, created: true, event: record, externalActionPerformed: false };
  }

  /** Record an observed payout state. It cannot initiate, change or cancel a payout. */
  async function recordPayout(input = {}) {
    const checked = validatePayout(input);
    if (!checked.ok) return { ok: false, code: checked.code, error: checked.error };
    const record = {
      ...checked.payout,
      actor: String(input.actor || "unknown").slice(0, 160),
      observed: true,
      updatedAt: now()
    };
    await repo.payouts.put(record);
    return { ok: true, created: true, payout: record, externalActionPerformed: false };
  }

  async function requestApproval(input = {}) {
    const outcome = await gate.request({ ...input, requestedBy: input.requestedBy || "ax" });
    return outcome;
  }

  async function approvals({ status = null, kind = null, limit = 50 } = {}) {
    return gate.list({ status, kind, limit });
  }

  async function approval(id) {
    return gate.get(id);
  }

  async function approve({ id, by, reason = null } = {}) {
    return gate.approve({ id, by, reason });
  }

  async function deny({ id, by, reason = null } = {}) {
    return gate.deny({ id, by, reason });
  }

  async function status() {
    const capabilitiesSummary = registry.summary();
    const [approvalsList, revenueList, payoutList] = await Promise.all([
      repo.approvals.list({ limit: 5000 }),
      repo.revenueEvents.list({ limit: 5000 }),
      repo.payouts.list({ limit: 5000 })
    ]);
    return {
      ok: true,
      storage: { adapter: repo.adapter, durable: repo.durable, tables: repo.tables },
      capabilities: capabilitiesSummary.byState,
      capabilityCount: capabilitiesSummary.count,
      approvals: approvalsList.reduce((counts, item) => {
        counts[item.status] = (counts[item.status] || 0) + 1;
        return counts;
      }, {}),
      revenueEvents: revenueList.length,
      payouts: payoutList.length,
      cashStates: [...CASH_STATE_NAMES],
      externalCalls: false,
      purchasedAnything: false,
      note: "P1 is read-only against every external provider. No purchase, order, transfer or OAuth connection exists in this service."
    };
  }

  return Object.freeze({
    adapter: repo.adapter,
    durable: repo.durable,
    initialize,
    capabilities,
    suppliers,
    supplier,
    evaluateSupplier,
    channels,
    evaluateChannel,
    treasury,
    revenueEvents,
    payouts,
    recordRevenue,
    recordPayout,
    requestApproval,
    approvals,
    approval,
    approve,
    deny,
    status,
    gate
  });
}
