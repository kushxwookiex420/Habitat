import { createHash, randomBytes } from "node:crypto";

/**
 * The one approval gate for gated actions.
 *
 * Request -> owner decision -> single-use consumption. Three properties matter and each has a test:
 *
 *   1. Only an owner actor may decide. `ax`, `nexus`, `scheduler`, `system` and the command token
 *      can raise a request; none of them can approve it. Identity comes from the verified caller,
 *      never from a body field.
 *   2. A purchase approval is bound to the exact quote: supplier, items, item cost, shipping, tax,
 *      currency, destination and quote expiry. Consuming it with a different amount, vendor or
 *      destination is refused, so an approval for one order cannot be replayed against another.
 *   3. Consumption is single-use and idempotent per execution key. Two callers cannot both spend
 *      the same approval.
 *
 * This module performs no purchase and no transfer. `externalActionPerformed` is always false.
 */

export const APPROVAL_KINDS = Object.freeze([
  "purchase",
  "subscription",
  "api_credit",
  "publish",
  "transfer",
  "payout_account_change",
  "oauth_connection",
  "install"
]);

export const APPROVAL_STATES = Object.freeze(["requested", "approved", "denied", "expired", "cancelled", "consumed"]);

/** Kinds that must carry a full financial binding. */
export const FINANCIAL_KINDS = Object.freeze(["purchase", "subscription", "api_credit", "transfer"]);

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUOTE_AGE_MS = 60 * 60 * 1000;
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isCents(value) {
  return Number.isInteger(value) && value >= 0;
}

function actorKind(by) {
  const text = clean(by, 160).toLowerCase();
  if (!text) return "none";
  if (text.startsWith("owner:")) return "owner";
  if (text === "ax" || text.startsWith("ax:") || text.includes("command-token")) return "ax";
  if (text === "nexus" || text.startsWith("nexus:")) return "nexus";
  if (text === "scheduler" || text.startsWith("scheduler:")) return "scheduler";
  if (text === "system") return "system";
  return "unknown";
}

function containsSecret(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === "string") return SECRET_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, depth + 1));
  if (typeof value === "object") return Object.values(value).some(item => containsSecret(item, depth + 1));
  return false;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const normalized = [];
  for (const item of items.slice(0, 50)) {
    const sku = clean(item?.sku ?? item?.id ?? "", 120);
    const quantity = Number(item?.quantity);
    const unitCents = item?.unitCents === undefined ? null : item.unitCents;
    if (!sku) return null;
    if (!Number.isInteger(quantity) || quantity < 1) return null;
    if (unitCents !== null && !isCents(unitCents)) return null;
    normalized.push({ sku, quantity, unitCents });
  }
  return normalized;
}

function bindingOf(request) {
  return {
    kind: request.kind,
    vendor: request.vendor ?? null,
    amountCents: request.amountCents ?? null,
    currency: request.currency ?? null,
    items: request.items ?? null,
    shippingCents: request.shippingCents ?? null,
    taxCents: request.taxCents ?? null,
    destination: request.destination ?? null,
    quoteId: request.quoteId ?? null,
    quoteExpiresAt: request.quoteExpiresAt ?? null,
    accountId: request.accountId ?? null,
    destinationAccountId: request.destinationAccountId ?? null,
    capabilityId: request.capabilityId ?? null
  };
}

function fingerprintOf(binding) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex");
}

export function createApprovalGate({
  repository,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
  maxListLimit = 200
} = {}) {
  if (!repository || typeof repository.get !== "function" || typeof repository.put !== "function") {
    throw new Error("The approval gate needs an approval repository.");
  }

  function unavailable() {
    return { ok: false, code: "approval_store_unavailable", error: "The approval store is not available." };
  }

  function expired(record) {
    const at = Date.parse(String(record?.expiresAt || ""));
    return Number.isFinite(at) && at <= nowMs();
  }

  /**
   * Persist a transition only while the row is still in the state the decision was based on. Both
   * stores expose `transition`; a repository without it still works, but then two concurrent
   * decisions can both write and the result is last-writer-wins. That is why the stores implement it.
   */
  async function commit(record, expectStatus) {
    if (typeof repository.transition === "function") {
      const stored = await repository.transition(record.id, { expectStatus, next: record });
      if (!stored) {
        return {
          ok: false,
          code: "approval_conflict",
          error: "This approval changed while the update was being recorded; re-read it before retrying."
        };
      }
      return { ok: true, record: stored };
    }
    await repository.put(record);
    return { ok: true, record };
  }

  /** Persist an expiry transition once, so a stale approval cannot be revived by a later write. */
  async function settleExpiry(record) {
    if (!record || record.status !== "requested" || !expired(record)) return record;
    const next = { ...record, status: "expired", expiredAt: now(), updatedAt: now() };
    const written = await commit(next, "requested");
    // Losing this race means another writer already changed the row; report what is actually stored.
    if (!written.ok) return (await repository.get(record.id)) || record;
    return written.record;
  }

  /**
   * The status a caller should act on, without writing anything. A read must not mutate: previously a
   * GET settled expiry, which made an idempotent read a write and put the expiry clock in the read
   * path. Expiry is now persisted only by the decision paths and by the scheduler's sweep.
   */
  function effective(record) {
    if (!record || record.status !== "requested" || !expired(record)) return record;
    return { ...record, status: "expired", expired: true, expiredAt: record.expiredAt || record.expiresAt };
  }

  /**
   * Persist the expiries that are due. Called by the existing scheduler tick so the ledger is swept
   * once per tick under the same lease, instead of being mutated by every read. Returns what was
   * swept, what is about to expire, and which rows changed underneath the sweep.
   */
  async function expiryReport({ withinMs = 60 * 60_000, limit = maxListLimit } = {}) {
    if (!repository) return unavailable();
    const rows = await repository.list({ limit: Math.max(1, Math.min(maxListLimit, Math.floor(Number(limit) || maxListLimit))) });
    const at = nowMs();
    const expiredNow = [];
    const expiringSoon = [];
    const failed = [];
    for (const row of rows) {
      if (row.status !== "requested") continue;
      const expiresAt = Date.parse(String(row.expiresAt || ""));
      if (!Number.isFinite(expiresAt)) continue;
      if (expiresAt <= at) {
        const written = await commit({ ...row, status: "expired", expiredAt: now(), updatedAt: now() }, "requested");
        if (written.ok) {
          expiredNow.push(written.record);
        } else {
          // Another writer may already have expired it; only a genuine mismatch is a failure.
          const reread = await repository.get(row.id);
          if (reread && reread.status === "expired") expiredNow.push(reread);
          else failed.push(row.id);
        }
      } else if (expiresAt - at <= withinMs) {
        expiringSoon.push(row);
      }
    }
    return { ok: true, expired: expiredNow, expiringSoon, failed, withinMs, checkedAt: now() };
  }

  async function request(input = {}) {
    if (!repository) return unavailable();
    const kind = clean(input.kind, 40).toLowerCase();
    if (!APPROVAL_KINDS.includes(kind)) {
      return { ok: false, code: "invalid_approval_kind", error: "kind must be one of " + APPROVAL_KINDS.join(", ") + ".", allowed: APPROVAL_KINDS };
    }
    if (containsSecret(input)) {
      return { ok: false, code: "secret_material_refused", error: "An approval request may not contain credentials or tokens." };
    }

    const missing = [];
    const financial = FINANCIAL_KINDS.includes(kind);
    // A malformed quote timestamp becomes null and is reported as a missing binding field, rather
    // than throwing a RangeError out of Date.toISOString().
    const quoteAt = input.quoteExpiresAt ? Date.parse(String(input.quoteExpiresAt)) : NaN;
    const quoteExpiresAt = Number.isFinite(quoteAt) ? new Date(quoteAt).toISOString() : null;
    const body = {
      kind,
      capabilityId: clean(input.capabilityId, 120) || null,
      vendor: clean(input.vendor ?? input.supplierId, 160) || null,
      amountCents: input.amountCents,
      currency: clean(input.currency, 3).toUpperCase() || null,
      shippingCents: input.shippingCents,
      taxCents: input.taxCents,
      items: normalizeItems(input.items),
      destination: clean(input.destination, 200) || null,
      quoteId: clean(input.quoteId, 160) || null,
      quoteExpiresAt,
      accountId: clean(input.accountId, 160) || null,
      destinationAccountId: clean(input.destinationAccountId, 160) || null,
      metadata: input.metadata && typeof input.metadata === "object" ? JSON.parse(JSON.stringify(input.metadata)) : null
    };

    if (financial) {
      if (!body.vendor) missing.push("vendor");
      if (!isCents(body.amountCents) || body.amountCents <= 0) missing.push("amountCents");
      if (!/^[A-Z]{3}$/.test(String(body.currency || ""))) missing.push("currency");
    }
    if (kind === "purchase") {
      if (!body.items) missing.push("items");
      if (!isCents(body.shippingCents)) missing.push("shippingCents");
      if (!isCents(body.taxCents)) missing.push("taxCents");
      if (!body.destination) missing.push("destination");
      if (!body.quoteId) missing.push("quoteId");
      if (!body.quoteExpiresAt || !Number.isFinite(Date.parse(body.quoteExpiresAt))) missing.push("quoteExpiresAt");
    }
    if (kind === "transfer") {
      if (!body.accountId) missing.push("accountId");
      if (!body.destinationAccountId) missing.push("destinationAccountId");
    }
    if (kind === "payout_account_change" && !body.destinationAccountId) missing.push("destinationAccountId");
    if (kind === "publish" && !body.vendor) missing.push("target");
    if (kind === "oauth_connection" && !body.vendor) missing.push("provider");

    if (missing.length) {
      return {
        ok: false,
        code: "invalid_approval_request",
        error: "The request is missing or malformed: " + missing.join(", ") + ".",
        missing
      };
    }
    if (body.quoteExpiresAt) {
      const at = Date.parse(body.quoteExpiresAt);
      if (at <= nowMs()) return { ok: false, code: "quote_expired", error: "The quote has already expired; fetch a fresh quote first." };
      if (at - nowMs() > MAX_QUOTE_AGE_MS * 24) {
        return { ok: false, code: "quote_window_too_long", error: "A quote may not be valid for more than 24 hours." };
      }
    }

    const binding = bindingOf(body);
    const fingerprint = fingerprintOf(binding);
    const idempotencyKey = clean(input.idempotencyKey, 160);
    const id = idempotencyKey
      ? "apr_" + createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 24)
      : "apr_" + randomBytes(10).toString("hex");

    const existing = await repository.get(id);
    if (existing) return { ok: true, created: false, replayed: true, approval: existing };

    // A second open request for the identical bound action is a duplicate, not a new approval.
    const open = await repository.list({ limit: maxListLimit });
    const duplicate = open.find(item =>
      item.fingerprint === fingerprint &&
      ["requested", "approved"].includes(String(item.status)) &&
      !item.consumedAt
    );
    if (duplicate) {
      return {
        ok: false,
        code: "duplicate_request",
        error: "An open approval already exists for this exact action.",
        existingId: duplicate.id
      };
    }

    const createdAt = now();
    const record = {
      id,
      kind,
      capabilityId: body.capabilityId,
      status: "requested",
      fingerprint,
      ...binding,
      metadata: body.metadata,
      requestedBy: clean(input.requestedBy, 160) || "ax",
      requestedAt: createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(nowMs() + ttlMs).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      consumedAt: null,
      consumedBy: null,
      executionKey: null,
      externalActionPerformed: false
    };
    await repository.put(record);
    return { ok: true, created: true, replayed: false, approval: record };
  }

  async function decide({ id, approved, by, reason = null } = {}) {
    if (!repository) return unavailable();
    const record = await settleExpiry(await repository.get(String(id || "")));
    if (!record) return { ok: false, code: "not_found", error: "No approval request with that id." };

    const kind = actorKind(by);
    if (kind !== "owner") {
      // The refusal deliberately names the rule, not the caller's credential value.
      return {
        ok: false,
        code: "owner_required",
        error: "An approval decision requires the paired owner device. Actor class \"" + kind + "\" cannot decide an approval.",
        actorClass: kind
      };
    }
    if (record.status === "denied" || record.status === "consumed") {
      return { ok: false, code: "already_decided", error: "This approval is already " + record.status + ".", status: record.status };
    }
    if (record.status === "expired") {
      return { ok: false, code: "approval_expired", error: "This approval expired before a decision was recorded." };
    }
    if (record.status !== "requested") {
      // A repeat of the same decision is a replay and changes nothing.
      if ((record.status === "approved" && approved === true) || (record.status === "denied" && approved === false)) {
        return { ok: true, replayed: true, approval: record };
      }
      return { ok: false, code: "already_decided", error: "This approval already has a decision.", status: record.status };
    }

    const at = now();
    const next = {
      ...record,
      status: approved ? "approved" : "denied",
      decidedAt: at,
      decidedBy: clean(by, 160),
      decisionReason: reason ? clean(reason, 300) : null,
      updatedAt: at
    };
    const written = await commit(next, "requested");
    if (!written.ok) return written;
    return { ok: true, replayed: false, approved: approved === true, approval: written.record, externalActionPerformed: false };
  }

  async function cancel({ id, by, reason = null } = {}) {
    const record = await settleExpiry(await repository.get(String(id || "")));
    if (!record) return { ok: false, code: "not_found", error: "No approval request with that id." };
    if (actorKind(by) !== "owner") return { ok: false, code: "owner_required", error: "Only the owner may cancel an approval request." };
    if (record.status === "consumed") return { ok: false, code: "already_decided", error: "A consumed approval cannot be cancelled." };
    // Cancelling an expired request would otherwise rewrite it back to a live-looking status.
    if (record.status === "expired" || expired(record)) {
      return { ok: false, code: "approval_expired", error: "This approval expired; it cannot be cancelled." };
    }
    const next = { ...record, status: "cancelled", cancelledAt: now(), cancelledBy: clean(by, 160), decisionReason: reason ? clean(reason, 300) : null, updatedAt: now() };
    const written = await commit(next, record.status);
    if (!written.ok) return written;
    return { ok: true, approval: written.record };
  }

  /**
   * Consume an approved action exactly once. No HTTP route exposes this in P1: there is nothing to
   * execute yet, and burning an approval with no purchase would be worse than leaving it unused.
   */
  async function consume({ id, by, executionKey, amountCents, currency, vendor, destination } = {}) {
    const record = await settleExpiry(await repository.get(String(id || "")));
    if (!record) return { ok: false, code: "not_found", error: "No approval request with that id." };
    if (actorKind(by) !== "owner") return { ok: false, code: "owner_required", error: "Only the owner may consume an approval." };
    if (!clean(executionKey, 160)) return { ok: false, code: "execution_key_required", error: "Consumption needs an execution key for idempotency." };
    if (record.consumedAt) {
      if (record.executionKey === clean(executionKey, 160)) return { ok: true, replayed: true, approval: record, externalActionPerformed: false };
      return { ok: false, code: "already_consumed", error: "This approval was already consumed by a different execution." };
    }
    // Expiry is checked before the status, because settling an expired record already rewrote its
    // status to "expired". Reporting "not_approved" there would hide the real reason.
    if (record.status === "expired" || expired(record)) {
      return { ok: false, code: "approval_expired", error: "This approval expired before it was consumed." };
    }
    if (record.status !== "approved") return { ok: false, code: "not_approved", error: "Only an approved request may be consumed; this one is " + record.status + "." };

    const mismatches = [];
    if (amountCents !== undefined && amountCents !== record.amountCents) mismatches.push("amountCents");
    if (currency !== undefined && String(currency).toUpperCase() !== record.currency) mismatches.push("currency");
    if (vendor !== undefined && clean(vendor, 160) !== record.vendor) mismatches.push("vendor");
    if (destination !== undefined && clean(destination, 200) !== record.destination) mismatches.push("destination");
    if (mismatches.length) {
      return {
        ok: false,
        code: "approval_binding_mismatch",
        error: "The requested action does not match the approval: " + mismatches.join(", ") + ".",
        mismatches
      };
    }

    const at = now();
    const next = {
      ...record,
      status: "consumed",
      consumedAt: at,
      consumedBy: clean(by, 160),
      executionKey: clean(executionKey, 160),
      updatedAt: at
    };
    const written = await commit(next, "approved");
    if (!written.ok) return written;
    return { ok: true, replayed: false, approval: written.record, externalActionPerformed: false };
  }

  async function get(id) {
    if (!repository) return unavailable();
    const record = await repository.get(String(id || ""));
    return record
      ? { ok: true, approval: effective(record) }
      : { ok: false, code: "not_found", error: "No approval request with that id." };
  }

  async function list({ status = null, kind = null, limit = 50 } = {}) {
    if (!repository) return unavailable();
    const rows = await repository.list({ limit: Math.max(1, Math.min(maxListLimit, Math.floor(Number(limit) || 50))) });
    const filtered = rows
      .map(effective)
      .filter(item => (status ? item.status === String(status) : true))
      .filter(item => (kind ? item.kind === String(kind) : true));
    return { ok: true, count: filtered.length, approvals: filtered };
  }

  /** Approved, unconsumed, unexpired commitments, for the treasury summary. */
  async function pendingCommitments() {
    if (!repository) return [];
    const rows = await repository.list({ limit: maxListLimit });
    return rows
      .map(effective)
      .filter(item => item.status === "approved" && !item.consumedAt && !expired(item))
      .filter(item => FINANCIAL_KINDS.includes(item.kind));
  }

  return Object.freeze({
    kinds: APPROVAL_KINDS,
    states: APPROVAL_STATES,
    request,
    approve: options => decide({ ...options, approved: true }),
    deny: options => decide({ ...options, approved: false }),
    cancel,
    consume,
    get,
    list,
    expiryReport,
    pendingCommitments,
    actorKind
  });
}
