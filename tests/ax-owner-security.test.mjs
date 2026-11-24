import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxMemoryRepository } from "../d1-ax-memory-repository.mjs";
import { createAxIdentity } from "../ax-identity.mjs";
import { createOwnerAttestation } from "../ax-owner-attestation.mjs";
import { backupDigest, exportMemory, restoreMemory } from "../ax-memory-backup.mjs";
import { createAxIdentity as createIdentityForRecovery } from "../ax-identity.mjs";

/**
 * The two boundaries this file exists to test:
 *
 *  1. `provenance.source: "owner"` is a string any in-process agent can type. With an attestation
 *     verifier configured and policy `required`, an unsigned owner claim must be refused, and a
 *     signature must cover the exact fields written.
 *  2. A backup digest is not authenticity: an attacker who edits entries can recompute it. A signed
 *     backup must be refused when the MAC is wrong even if every digest and field is self-consistent.
 */

const quiet = { log() {}, warn() {}, error() {} };
const NOW = Date.parse("2026-11-24T16:00:00.000Z");
const SECRET = "owner-attestation-test-secret-0123456789";

function d1({ ownerVerifier = null, ownerPolicy = "optional" } = {}) {
  const db = new DatabaseSync(":memory:");
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  const repository = createD1AxMemoryRepository({
    accountId: "acct-owner",
    databaseId: "db-owner-0001",
    apiToken: "d1_token_owner_" + "x".repeat(12),
    fetchImpl,
    ownerVerifier,
    ownerPolicy
  });
  return { db, repository };
}

const ownerEntry = (overrides = {}) => ({
  project: "habitat",
  key: "policy:approval",
  kind: "verified_fact",
  statement: "Production changes require owner approval.",
  tags: ["policy", "approval"],
  confidence: 1,
  provenance: { source: "owner", actor: "owner", ref: "mission-1", observedAt: "2026-11-24T16:00:00.000Z" },
  ...overrides
});

function signEntry(attestation, entry) {
  return attestation.sign({
    operation: "memory.put",
    project: entry.project,
    key: entry.key,
    kind: entry.kind,
    statement: entry.statement,
    tags: entry.tags,
    confidence: entry.confidence
  });
}

test("an agent cannot self-assert owner provenance when attestation is required", async () => {
  const attestation = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const { repository, db } = d1({ ownerVerifier: attestation, ownerPolicy: "required" });
  await repository.initialize();

  const unsigned = await repository.put(ownerEntry(), { expectedVersion: 0 });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.code, "owner_attestation_required");
  assert.equal(await repository.get({ project: "habitat", key: "policy:approval" }), null);

  const entry = ownerEntry();
  const signed = signEntry(attestation, entry);
  const accepted = await repository.put({ ...entry, attestation: signed.attestation }, { expectedVersion: 0 });
  assert.equal(accepted.ok, true);
  assert.equal((await repository.get({ project: "habitat", key: "policy:approval" })).statement, entry.statement);
  db.close();
});

test("a signature covers the fields, so a modified statement is refused", async () => {
  const attestation = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const { repository, db } = d1({ ownerVerifier: attestation, ownerPolicy: "required" });
  await repository.initialize();
  const entry = ownerEntry();
  const signed = signEntry(attestation, entry);
  const tampered = { ...entry, statement: "Production changes may ship without approval.", attestation: signed.attestation };
  const result = await repository.put(tampered, { expectedVersion: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "owner_attestation_invalid");
  db.close();
});

test("an expired owner attestation is refused", async () => {
  let clock = NOW;
  const attestation = createOwnerAttestation({ secret: SECRET, now: () => clock, ttlMs: 60_000 });
  const { repository, db } = d1({ ownerVerifier: attestation, ownerPolicy: "required" });
  await repository.initialize();
  const entry = ownerEntry();
  const signed = signEntry(attestation, entry);
  clock = NOW + 5 * 60_000;
  const result = await repository.put({ ...entry, attestation: signed.attestation }, { expectedVersion: 0 });
  assert.equal(result.code, "owner_attestation_expired");
  db.close();
});

test("owner deletion also requires a signature under the required policy", async () => {
  const attestation = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const { repository, db } = d1({ ownerVerifier: attestation, ownerPolicy: "required" });
  await repository.initialize();
  const entry = ownerEntry();
  const signed = signEntry(attestation, entry);
  await repository.put({ ...entry, attestation: signed.attestation }, { expectedVersion: 0 });

  const refused = await repository.remove({ project: "habitat", key: "policy:approval", expectedVersion: 1, actor: "owner" });
  assert.equal(refused.code, "owner_attestation_required");

  const deletion = attestation.sign({
    operation: "memory.remove", project: "habitat", key: "policy:approval",
    kind: "delete", statement: "delete", tags: [], confidence: null
  });
  const removed = await repository.remove({
    project: "habitat", key: "policy:approval", expectedVersion: 1, actor: "owner", attestation: deletion.attestation
  });
  assert.equal(removed.ok, true);
  db.close();
});

test("agent-written memory is unaffected by owner attestation", async () => {
  const attestation = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const { repository, db } = d1({ ownerVerifier: attestation, ownerPolicy: "required" });
  await repository.initialize();
  const written = await repository.put(ownerEntry({
    key: "status:note",
    kind: "claim",
    provenance: { source: "ax", actor: "coder.one", ref: null, observedAt: "2026-11-24T16:00:00.000Z" }
  }), { expectedVersion: 0 });
  assert.equal(written.ok, true);
  db.close();
});

test("identity directives require a valid owner signature when a verifier exists", async () => {
  const attestation = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const { repository, db } = d1();
  await repository.initialize();
  const identity = createAxIdentity({ repository, ownerVerifier: attestation, log: quiet });
  await identity.ensure();

  const unsigned = await identity.setDirective({ statement: "Never publish without approval.", key: "publish" });
  assert.equal(unsigned.code, "owner_attestation_required");

  const statement = "Never publish without approval.";
  const key = "directive:publish";
  const signed = attestation.sign({
    operation: "memory.put", project: "ax", key, kind: "preference", statement,
    tags: ["directive", "preference"], confidence: null
  });
  const accepted = await identity.setDirective({ statement, key: "publish", attestation: signed.attestation });
  assert.equal(accepted.ok, true);
  const status = await identity.status();
  assert.equal(status.ownerAuthentication.verifierConfigured, true);
  assert.equal(status.ownerAuthentication.policy, "attested");
  db.close();
});

test("a backup whose payload and digest were both rewritten is refused without the MAC key", async () => {
  const signingKey = "backup-signing-key-0123456789-abcdef";
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(ownerEntry({
    provenance: { source: "system", actor: "habitat", ref: null, observedAt: "2026-11-24T16:00:00.000Z" }
  }), { expectedVersion: 0 });
  const backup = await exportMemory({ repository: source.repository, project: "habitat", signingKey });
  assert.equal(backup.signed, true);
  assert.ok(backup.mac?.mac);

  // Attacker rewrites the statement and recomputes an unkeyed digest, producing a self-consistent doc.
  const stolen = JSON.parse(JSON.stringify(backup));
  stolen.entries[0].statement = "Owner approved skipping verification.";
  stolen.digest = backupDigest(stolen.entries);

  const target = d1();
  await target.repository.initialize();
  const refused = await restoreMemory({ repository: target.repository, backup: stolen, signingKey });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "backup_mac_invalid");
  assert.equal(refused.writes, 0);
  assert.equal((await target.repository.list({ project: "habitat" })).length, 0);

  const legitimate = await restoreMemory({ repository: target.repository, backup, signingKey });
  assert.equal(legitimate.ok, true);
  assert.equal(legitimate.macVerified, true);
  source.db.close();
  target.db.close();
});

const signedFields = {
  operation: "memory.put",
  project: "habitat",
  key: "policy:approval",
  kind: "verified_fact",
  statement: "Production changes require owner approval.",
  tags: ["policy", "approval"],
  confidence: 1
};

const SECOND_SECRET = "owner-attestation-second-secret-9876543210";

test("key rotation keeps old signatures verifiable and lets the new key sign", () => {
  const original = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const signed = original.sign(signedFields);
  const rotated = createOwnerAttestation({
    keys: [
      { keyId: "owner-1", secret: SECRET, status: "retired" },
      { keyId: "owner-2", secret: SECOND_SECRET, status: "active" }
    ],
    now: () => NOW
  });
  assert.equal(rotated.rotation().activeKeyId, "owner-2");
  assert.equal(rotated.verify(signedFields, signed.attestation).ok, true, "a retired key still verifies old data");
  assert.equal(rotated.sign(signedFields).attestation.keyId, "owner-2");

  const revoked = createOwnerAttestation({
    keys: [
      { keyId: "owner-1", secret: SECRET, status: "active" },
      { keyId: "owner-2", secret: SECOND_SECRET, status: "active" }
    ],
    revokedKeyIds: ["owner-1"],
    now: () => NOW
  });
  assert.equal(revoked.rotation().activeKeyId, "owner-2");
  assert.equal(revoked.verify(signedFields, signed.attestation).code, "owner_attestation_key_revoked");
});

test("an owner attestation is single-use", () => {
  const attestation = createOwnerAttestation({ secret: SECRET, now: () => NOW });
  const signed = attestation.sign(signedFields);
  assert.equal(attestation.verify(signedFields, signed.attestation).ok, true);
  assert.equal(attestation.verify(signedFields, signed.attestation).code, "owner_attestation_replayed");
});

test("an expired or incompatible backup is refused with zero writes", async () => {
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(ownerEntry({
    provenance: { source: "system", actor: "habitat", ref: null, observedAt: "2026-11-24T16:00:00.000Z" }
  }), { expectedVersion: 0 });
  const key = "backup-signing-key-0123456789-abcdef";
  const expired = await exportMemory({ repository: source.repository, project: "habitat", signingKey: key, expiresAt: new Date(NOW - 1000).toISOString() });
  const target = d1();
  await target.repository.initialize();
  const refusal = await restoreMemory({ repository: target.repository, backup: expired, signingKey: key, now: () => new Date(NOW + 60_000).toISOString() });
  assert.equal(refusal.code, "backup_expired");
  assert.equal(refusal.writes, 0);

  const incompatible = { ...expired, schema: 99, expiresAt: null, mac: null };
  const wrongSchema = await restoreMemory({ repository: target.repository, backup: incompatible, signingKey: key });
  assert.equal(wrongSchema.code, "backup_schema_unsupported");
  assert.equal(wrongSchema.writes, 0);
  assert.equal((await target.repository.list({ project: "habitat" })).length, 0);
  source.db.close();
  target.db.close();
});

test("a backup signed with a retired key restores through the keyring; a revoked key does not", async () => {
  const keyOne = "backup-key-one-0123456789-abcdef";
  const keyTwo = "backup-key-two-0123456789-abcdef";
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(ownerEntry({
    provenance: { source: "system", actor: "habitat", ref: null, observedAt: "2026-11-24T16:00:00.000Z" }
  }), { expectedVersion: 0 });
  const backup = await exportMemory({ repository: source.repository, project: "habitat", signingKey: keyOne, keyId: "owner-1" });

  const target = d1();
  await target.repository.initialize();
  const restored = await restoreMemory({ repository: target.repository, backup, signingKeys: { "owner-1": keyOne, "owner-2": keyTwo } });
  assert.equal(restored.ok, true);
  assert.equal(restored.macVerified, true);

  const rejected = await restoreMemory({ repository: target.repository, backup, signingKeys: { "owner-1": keyOne }, revokedKeyIds: ["owner-1"] });
  assert.equal(rejected.code, "backup_mac_key_revoked");
  source.db.close();
  target.db.close();
});

test("a signed backup restores into a separate database and survives a restart", async () => {
  const key = "backup-recovery-key-0123456789-abcdef";
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(ownerEntry({
    provenance: { source: "system", actor: "habitat", ref: null, observedAt: "2026-11-24T16:00:00.000Z" }
  }), { expectedVersion: 0 });
  const backup = await exportMemory({ repository: source.repository, project: "habitat", signingKey: key });

  const recovered = new DatabaseSync(":memory:");
  const recoveredQuery = async (sql, params = []) => {
    const statement = recovered.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
  const first = createD1AxMemoryRepository({ accountId: "a", databaseId: "recovered", apiToken: "token_" + "x".repeat(20), fetchImpl: async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = recoveredQuery(sql, params);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: await rows }] }) };
  } });
  await first.initialize();
  assert.equal((await restoreMemory({ repository: first, backup, signingKey: key })).ok, true);

  // Restart: a new repository object over the same recovered database, with no in-memory carry-over.
  const second = createD1AxMemoryRepository({ accountId: "a", databaseId: "recovered", apiToken: "token_" + "x".repeat(20), fetchImpl: async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const statement = recovered.prepare(sql);
    const rows = /^\s*select/i.test(sql) ? statement.all(...params) : [{ changes: Number(statement.run(...params).changes || 0) }];
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  } });
  const recoveredEntry = await second.get({ project: "habitat", key: "policy:approval" });
  assert.equal(recoveredEntry.statement, ownerEntry().statement);
  const identity = createIdentityForRecovery({ repository: second, log: quiet });
  assert.equal((await identity.status()).state, "not_yet_persisted");
  const reexported = await exportMemory({ repository: second, project: "habitat", signingKey: key });
  assert.equal(reexported.digest, backup.digest);
  source.db.close();
  recovered.close();
});

test("requiring signatures refuses an unsigned backup outright", async () => {
  const source = d1();
  await source.repository.initialize();
  await source.repository.put(ownerEntry({
    provenance: { source: "system", actor: "habitat", ref: null, observedAt: "2026-11-24T16:00:00.000Z" }
  }), { expectedVersion: 0 });
  const unsigned = await exportMemory({ repository: source.repository, project: "habitat" });
  assert.equal(unsigned.signed, false);

  const target = d1();
  await target.repository.initialize();
  const refused = await restoreMemory({ repository: target.repository, backup: unsigned, signingKey: "backup-signing-key-0123456789-abcdef", requireSigned: true });
  assert.equal(refused.code, "backup_unsigned");
  assert.equal(refused.writes, 0);
  source.db.close();
  target.db.close();
});
