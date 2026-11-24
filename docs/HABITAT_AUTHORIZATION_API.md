# Habitat owner authorization interface v1

Everything a client needs to display and decide mission authorizations through the standard Ax API. All routes
require `Authorization: Bearer <HABITAT_AX_COMMAND_TOKEN>`; there is no anonymous or unsigned path.

## Signing view

`GET /ax/missions/:missionId/authorizations`

```json
{
  "ok": true,
  "missionId": "msn_…",
  "missionStatus": "approval_required",
  "generatedAt": "2026-11-24T12:00:00.000Z",
  "pending": [{
    "missionId": "msn_…",
    "approvalId": "apr:msn_…:t2",
    "taskId": "t2",
    "taskTitle": "Deploy to production",
    "description": "Deploy to production",
    "actionClass": "consequential",
    "action": "deploy release 7.0.0",
    "target": "staging",
    "parameters": "pf:0e90…",
    "expiresAt": "2026-11-24T12:30:00.000Z",
    "status": "pending",
    "decidedBy": null,
    "decidedAt": null,
    "reason": "consequential_action",
    "signature": null,
    "statement": "{\"v\":1,\"missionId\":…,\"decision\":\"approve\",…}",
    "rejectStatement": "{\"v\":1,…\"decision\":\"reject\"…}"
  }],
  "history": [ … same entries, including decided and revoked … ]
}
```

- `statement` and `rejectStatement` are **exactly** what the engine verifies for approve and reject. Sign the
  string itself with the owner key (HMAC-SHA256 payload over operation/project/key/kind/statement/tags/confidence).
- A mission-level authorization has `taskId: null` and `approvalId: "apr:<mission>:mission"`. Answering it does
  not approve any task.
- `signature` appears once decided: `{ keyId, issuedAt, nonce }` — never the MAC and never key material.
- The view never includes secrets, parameters themselves (only their fingerprint), or raw database rows.

## Decide

`POST /ax/missions/:missionId/approve` with exactly one target:

```json
{ "decision": "approve" | "reject",
  "taskId": "t2" | "approvalId": "apr:…",
  "attestation": { "v": 1, "keyId": "owner-1", "issuedAt": "…", "nonce": "…", "mac": "…" },
  "reason": "optional, ≤300 chars" }
```

No target means the single mission-scope authorization. Two matches return `approval_ambiguous`. Approval
expiry is the signed `expiresAt`; the engine never extends it.

## Revoke

`POST /ax/missions/:missionId/revoke` with `taskId` or `approvalId` (one is required) and optional `reason`.
Returns `{ ok, revoked: [approvalId], mission }`. The record stays in history as `revoked`.

## Refusal codes Habitat should render

| Code | Meaning |
|---|---|
| `approval_not_required` | Mission is not awaiting this decision (already decided/terminal) |
| `approval_not_found` | No authorization for that task/approval id |
| `approval_ambiguous` | More than one authorization matched |
| `approval_pending` / `approval_rejected` / `approval_revoked` | Gate-level status at execution |
| `approval_expired` | Approval expiry passed |
| `approval_action_changed` | Task target/parameters changed after the grant |
| `approval_missing` | No bound approval for the task |
| `approval_signature_missing` / `approval_signature_invalid` | No valid stored signature at execution |
| `owner_attestation_required` | Decision sent without an attestation |
| `owner_attestation_invalid` | Signature/statement mismatch |
| `owner_attestation_expired` | Attestation older than 5 minutes |
| `owner_attestation_replayed` | Nonce already used (shared across instances) |
| `owner_attestation_key_revoked` / `owner_attestation_unknown_key` | Key rotation/revocation state |
| `owner_attestation_not_configured` | No signer configured: consequential work fails closed |
| `owner_attestation_replay_unavailable` | Shared replay store unreachable: decision refused |
| `policy_denied` | Prohibited action, regardless of approval |

## Countdown and history

`expiresAt` is the single source for the countdown; use `generatedAt` to correct for clock skew. `history`
returns pending and decided authorizations in record order with `status`, `decidedBy`, `decidedAt`, `reason`,
`signature`. Mission-level evidence remains available from `GET /ax/missions/:missionId` (`tasks[].evidence`,
`tasks[].error`) and the mission event stream.

## What Habitat does not get

- No signing key, no MAC values, no database records.
- No implicit "approve all" operation.
- No access without the Ax credential; the v1 deployment has a single owner identity (`owner`), so per-user
  tenancy is not implemented.
