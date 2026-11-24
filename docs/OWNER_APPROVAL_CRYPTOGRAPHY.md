# Owner approval cryptography

Mission approvals are the only way consequential work is released. This document describes exactly what a
signature covers, how the key is held, how it rotates, and what the system does not prove.

## Algorithm

`HMAC-SHA256` over a canonical JSON object, using the key material from the environment. Comparison is
constant-time (`timingSafeEqual`). The payload is:

```
{ operation, project, key, kind, statement, tags, confidence }
```

and the signed value also covers `v`, `keyId`, `issuedAt`, `nonce` (each attestation is single-use). The
`statement` for a mission approval is the canonical authorization:

```
{ v: 1, missionId, approvalId, taskId | "mission", decision | "approve"|"reject",
  actionClass, action, target, parameters, expiresAt, owner }
```

`parameters` is `pf:<sha256-32>` of the canonicalised parameter object (sorted keys), so key order cannot
change it and any value change does. `owner` is the deciding identity written into the record.

The engine verifies the signature twice:

1. **At decision time**, against the approval as persisted, before any field is written. The nonce is spent
   here (replay protection).
2. **Immediately before execution**, against the record as it is then, with replay consumption disabled.
   A task whose approval, target or parameters changed after signing fails with
   `owner_attestation_invalid` / `approval_action_changed` and never reaches an executor.

Approving no longer marks a mission complete: it sets the mission `running`. Completion still requires
executed, independently verified tasks.

## Key ownership

| Variable | Purpose |
|---|---|
| `HABITAT_OWNER_ATTESTATION_KEY` | Single active signing key, at least 32 characters |
| `HABITAT_OWNER_ATTESTATION_KEYS` | JSON keyring for rotation: `[{ keyId, secret, status }]`, exactly one `active` |
| `HABITAT_OWNER_ATTESTATION_REVOKED` | Comma-separated key ids that must no longer verify |

Only the owner holds the active secret. It is never written to mission records, evidence, logs or API
responses: approvals store `signed: { v, keyId, issuedAt, nonce, mac, statement }` — a reference, not the key.
A verifier with a malformed keyring yields **no verifier**; mission decisions then fail closed with
`owner_attestation_not_configured`, and consequential tasks cannot execute.

## Rotation

Add the new key as `active` and demote the previous one to `retired`. Retired keys still verify existing
signatures, so nothing signed before the rotation becomes unverifiable. Remove a compromised key by adding
its id to `HABITAT_OWNER_ATTESTATION_REVOKED`; new and old signatures from it are then refused with
`owner_attestation_key_revoked`.

## Replay protection

- Each attestation carries a random 96-bit nonce and an `issuedAt`; it is valid for 5 minutes
  (`ttlMs`), and a nonce can be spent once.
- The in-process replay store is bounded (5000 ids) and pruned by expiry. Multi-instance deployments need a
  shared store for hard cross-instance replay prevention; the gateway's nonce/timestamp headers cover its own
  request replay separately.
- A decision names exactly one authorization: `approvalId`, or `taskId`, or — when omitted — the single
  mission-scope signal. One signature can never approve an unrelated task.

## Trust assumptions and limits

1. **Key custody is human.** The signature proves the signer held the key at signing time and that the
   payload was not altered. It does not prove which person was at the keyboard.
2. **The signature does not cover the request transport.** TLS and the gateway's nonce/timestamp headers
   protect the request itself.
3. **Replay across instances is not fully solved** without the shared store described above.
4. **Expiry is fixed by the approval record** (30 minutes from intake) and is part of the signed statement.
   A stale approval cannot be extended by the engine; it needs a fresh request and a fresh signature.
5. **Mission-scope and task-scope are separate authorizations.** Answering the objective-level signal does
   not approve any task; each consequential task needs its own signature.
6. **Presentation projections may omit binding fields.** Clients should read the persisted mission record
   (or a future explicit signing view) to build the statement they sign.
