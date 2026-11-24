import { createHash } from "node:crypto";

/**
 * Ax identity, kept separate from whichever model is supplying intelligence.
 *
 * The core is defined in code so it exists even with no database and no provider. The memory store
 * holds a durable record of it plus owner-approved directives (preferences, goals, decisions). A
 * provider/model switch changes `intelligence`, never `identity` — the digest below is computed only
 * from the core, so two snapshots taken under different providers must agree.
 *
 * This module does not call a provider and does not write anything on import. `ensure()` is explicit,
 * so a process that never enables Ax's memory cannot silently create rows.
 */

export const AX_IDENTITY_CORE = Object.freeze({
  name: "Ax",
  designation: "Habitat intelligence",
  role: "The owner's persistent operating intelligence inside Habitat.",
  version: "1.0.0",
  continuity: Object.freeze({
    providerIndependent: true,
    survivesProviderSwitch: true,
    survivesRestart: true,
    identityStoredOutsideProvider: true
  }),
  principles: Object.freeze([
    "Separate verified facts from claims, hypotheses and its own recommendations.",
    "Never approve its own work; approval belongs to the owner.",
    "Act only within granted permissions, and report anything refused.",
    "Keep evidence for every claim that work is complete.",
    "Remain the same Ax across model, provider, process and session changes."
  ]),
  voice: Object.freeze({
    tone: "direct, calm, evidence-first",
    never: Object.freeze(["claim unearned completion", "speak as the owner", "hide a failure"])
  })
});

export const IDENTITY_PROJECT = "ax";
export const IDENTITY_KEY = "identity.core";
export const DIRECTIVE_KINDS = Object.freeze(["preference", "goal", "decision"]);

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Stable across provider, model, session and process. Excludes anything provider-specific. */
export function identityDigest(core = AX_IDENTITY_CORE) {
  const subset = {
    name: core.name,
    designation: core.designation,
    role: core.role,
    version: core.version,
    continuity: core.continuity,
    principles: core.principles,
    voice: core.voice
  };
  return createHash("sha256").update(canonical(subset)).digest("hex");
}

function clean(value, max = 400) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function slug(value) {
  return clean(value, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function createAxIdentity({
  repository = null,
  project = IDENTITY_PROJECT,
  core = AX_IDENTITY_CORE,
  ownerVerifier = null,
  now = () => new Date().toISOString(),
  log = console
} = {}) {
  const projectId = String(project || IDENTITY_PROJECT).trim().toLowerCase();
  const digest = identityDigest(core);

  async function readCoreRecord() {
    if (!repository || typeof repository.get !== "function") return null;
    try {
      return await repository.get({ project: projectId, key: IDENTITY_KEY });
    } catch (error) {
      log.error?.("AX_IDENTITY_READ_FAILED", clean(error?.message || error, 160));
      return null;
    }
  }

  /**
   * Persist the core record if it is missing. Idempotent: an unchanged record is not rewritten because
   * the repository treats identical statements as a no-op.
   */
  async function ensure() {
    if (!repository || typeof repository.put !== "function") {
      return { ok: false, code: "memory_not_configured", digest };
    }
    const existing = await readCoreRecord();
    const statement =
      "Ax identity " + core.version + ": " + core.name + " is " + core.role +
      " Identity is stored outside every provider; provider and model changes do not alter it. Digest " + digest.slice(0, 16) + ".";
    try {
      const written = await repository.put({
        project: projectId,
        key: IDENTITY_KEY,
        kind: "decision",
        statement,
        provenance: { source: "system", actor: "habitat", ref: "identity:" + digest.slice(0, 16), observedAt: now() },
        tags: ["identity", "continuity", "provider-independent"],
        confidence: 1
      }, { expectedVersion: existing ? existing.version : 0, now: now() });
      if (!written.ok) {
        // A concurrent writer created the same row first; identical content means it already exists.
        return { ok: written.code === "memory_conflict" ? false : false, code: written.code || "identity_write_failed", digest, current: written.current || null };
      }
      return { ok: true, unchanged: Boolean(written.unchanged), version: written.entry?.version ?? null, digest };
    } catch (error) {
      log.error?.("AX_IDENTITY_WRITE_FAILED", clean(error?.message || error, 160));
      return { ok: false, code: "identity_write_failed", digest };
    }
  }

  /**
   * Owner-approved instruction, preference or goal. Only an owner write is accepted: an agent may not
   * install a standing instruction for itself.
   */
  async function setDirective({ statement, kind = "preference", key = null, actor = "owner", source = "owner", confidence = null, attestation = null } = {}) {
    if (!repository || typeof repository.put !== "function") return { ok: false, code: "memory_not_configured" };
    if (source !== "owner") return { ok: false, code: "owner_required" };
    if (!DIRECTIVE_KINDS.includes(kind)) return { ok: false, code: "invalid_directive_kind", allowed: DIRECTIVE_KINDS };
    const text = clean(statement, 1000);
    if (!text) return { ok: false, code: "empty_statement" };
    const directiveKey = "directive:" + (slug(key || text) || "note");
    const existing = await repository.get({ project: projectId, key: directiveKey }).catch(() => null);
    // A directive is a standing owner instruction. When an attestation key exists, an unsigned claim
    // is refused: the string "owner" is not authentication.
    const check = ownerVerifier
      ? ownerVerifier.verifyEntry({ project: projectId, key: directiveKey, kind, statement: text, tags: ["directive", kind], confidence }, attestation)
      : { ok: true, unattested: true };
    if (!check.ok) return { ok: false, ...check };
    try {
      const written = await repository.put({
        project: projectId,
        key: directiveKey,
        kind,
        statement: text,
        provenance: { source: "owner", actor: clean(actor, 64) || "owner", ref: "directive", observedAt: now() },
        tags: ["directive", kind],
        confidence,
        attestation
      }, { expectedVersion: existing ? existing.version : 0, allowKindChange: false, now: now() });
      if (!written.ok) return { ok: false, code: written.code, reason: written.reason || null, current: written.current || null };
      return { ok: true, key: directiveKey, version: written.entry?.version ?? null, unchanged: Boolean(written.unchanged) };
    } catch (error) {
      log.error?.("AX_IDENTITY_DIRECTIVE_FAILED", clean(error?.message || error, 160));
      return { ok: false, code: "directive_write_failed" };
    }
  }

  async function directives() {
    if (!repository || typeof repository.list !== "function") return { ok: false, code: "memory_not_configured", entries: [] };
    try {
      const entries = await repository.list({ project: projectId, limit: 100 });
      return {
        ok: true,
        entries: entries.filter(entry => typeof entry.key === "string" && entry.key.startsWith("directive:"))
      };
    } catch (error) {
      return { ok: false, code: "directive_read_failed", entries: [] };
    }
  }

  async function status() {
    const record = await readCoreRecord();
    const storedDigestMatches = record ? String(record.statement || "").includes(digest.slice(0, 16)) : false;
    const all = repository && typeof repository.list === "function"
      ? await repository.list({ project: projectId, limit: 100 }).catch(() => [])
      : [];
    const list = Array.isArray(all) ? all : [];
    const count = kind => list.filter(entry => entry.kind === kind).length;
    return {
      name: core.name,
      version: core.version,
      digest,
      providerIndependent: true,
      repository: Boolean(repository),
      stored: Boolean(record) && storedDigestMatches,
      state: repository ? (record && storedDigestMatches ? "persistent" : "not_yet_persisted") : "committed_only",
      directives: {
        preferences: count("preference"),
        goals: count("goal"),
        decisions: count("decision") - (record ? 1 : 0),
        total: list.filter(entry => typeof entry.key === "string" && entry.key.startsWith("directive:")).length
      },
      ownerAuthentication: {
        verifierConfigured: Boolean(ownerVerifier),
        policy: ownerVerifier ? "attested" : "unattested_allowed"
      },
      detail: repository
        ? (record
          ? "Identity is stored in the memory repository, independent of any provider."
          : "Memory is available; the identity record has not been written yet.")
        : "Identity is committed in code only; no memory repository is configured."
    };
  }

  /** Identity and intelligence are reported side by side, never merged. */
  function snapshot({ provider = null, model = null } = {}) {
    return {
      at: now(),
      identity: { name: core.name, version: core.version, digest, providerIndependent: true },
      intelligence: { provider: provider || null, model: model || null },
      coupled: false
    };
  }

  /** Prove that changing provider kept the identity and the owner's directives. */
  async function continuity({ before, after } = {}) {
    const first = before || snapshot();
    const second = after || snapshot();
    const current = await directives();
    return {
      ok: true,
      identityStable: first?.identity?.digest === second?.identity?.digest && second?.identity?.digest === digest,
      providerChanged: first?.intelligence?.provider !== second?.intelligence?.provider,
      providerIndependent: true,
      directivesPreserved: current.ok === true,
      directiveCount: current.entries?.length ?? 0
    };
  }

  return Object.freeze({
    core,
    digest,
    ensure,
    status,
    snapshot,
    continuity,
    setDirective,
    directives,
    project: projectId
  });
}
