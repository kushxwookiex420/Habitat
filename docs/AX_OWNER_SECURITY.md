# Owner security: attestation, key management, backup recovery

This document records the Phase Two security model, its remaining limits, and the procedures an owner
must follow. It is not a claim that any key is configured: no owner attestation key exists in any
environment today, so the enforcement switches are off.

## What is authenticated

| Action | Without a key | With `HABITAT_OWNER_ATTESTATION_KEY` |
| --- | --- | --- |
| Memory write with `provenance.source: "owner"` | allowed, recorded `unattested` | verified if an attestation is supplied; refused if `HABITAT_OWNER_ATTESTATION_ENFORCE=true` and none is |
| Identity directive | allowed, reported `unattested_allowed` | refused without a valid attestation |
| Memory deletion (`actor: "owner"`) | allowed | refused without a valid attestation when enforced |
| Mission approval | refused (`owner_attestation_not_configured`) | requires a valid attestation |
| Backup restore | integrity-only unless a key is supplied | MAC verified; `requireSigned` available |

Attestations are HMAC-SHA256 over canonical, explicitly enumerated fields (operation, project, key, kind,
statement, tags, confidence), plus key id, issue time and nonce. Verification uses constant-time
comparison, a ±5 minute window, single-use nonces, and key status (active / retired / revoked).

## Key management

- **Storage:** the key lives only in the environment/secret store (`HABITAT_OWNER_ATTESTATION_KEY`), is at
  least 32 characters, and must never be written to memory, a backup, a log line, a prompt or a client
  response. `/system/status` reports presence as a boolean only.
- **Rotation:** configure `keys: [{keyId, secret, status}]` with one `active` key and the previous key
  `retired`. Retired keys still verify old attestations and old backup MACs, so rotation does not
  silently invalidate recoverable data. Signing always uses the active key.
- **Revocation:** add the key id to `revokedKeyIds`. Revoked keys verify nothing; plan for data signed
  with them to be re-signed/restored through the new key, because refusing the old key is the point.
- **Backups:** export with a key id, keep the key ring available, and store `expiresAt` where a recovery
  window is required. A backup signed with a retired key restores through the keyring; a revoked key is
  refused (`backup_mac_key_revoked`).
- **Enforcement switch:** install the key first, verify signed reads/writes in staging, then set
  `HABITAT_OWNER_ATTESTATION_ENFORCE=true`. Until then the repository reports `optional` and route-
  authenticated owner writes keep working (recorded as a known limitation, not a silent bypass).

## Disaster recovery

1. **Before any migration or risky write:** record a D1 Time Travel bookmark, or export the database.
2. **Memory:** `exportMemory({signingKey})` produces `{schema, project, exportedAt, expiresAt, digest,
   entries, revisions, mac}`. Keep the MAC key outside the backup.
3. **Restore:** `restoreMemory` verifies schema, project, digest, expiry and MAC **before any write**. A
   tampered payload + recomputed digest fails on the MAC; an unsigned document fails when
   `requireSigned`; an expired or incompatible document fails with zero writes.
4. **Recovery target:** restore into a *separate* database first, re-export it and compare digests (the
   test suite does exactly this), then restart a process against it and read the entries again.
5. **Never** treat a checksum/digest as proof of authenticity, and never restore a backup whose key id is
   unknown or revoked without deciding what to do with the affected data.

## Evidence

`tests/ax-owner-security.test.mjs` (13 tests): unsigned owner write refused, modified statement refused,
expired attestation, unsigned delete refused, agent writes unaffected, signed directive accepted,
forged backup refused, rotation with retired key accepted, revoked key refused, single-use nonce, expired
backup and unsupported schema refused with zero writes, retired-key restore through a keyring, and
restore into a separate database followed by a fresh repository read.

## Remaining limits

- One HMAC key model, no hardware-backed signing and no per-human identity: possession of the key is the
  owner. Which person used it is not provable.
- Replay protection for attestations is in-process unless a shared nonce store is supplied.
- No automatic re-signing of data after a key rotation.
