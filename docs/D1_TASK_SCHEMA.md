# D1 Task Storage Schema

The runtime task repository needs durable storage before tasks can survive Render restarts. The initial schema should use a stable task ID, serialized task record, indexed status, and updated timestamp. Use a Cloudflare D1 database with least-privilege credentials held only in Render environment settings. Do not mark storage healthy until a real restart-and-hydration test passes.

## Owner approval nonces (0017)

`habitat_ax_approval_nonces` is the durable replay boundary for owner-signed mission decisions.

| Column | Meaning |
| --- | --- |
| `nonce` | PRIMARY KEY; one attestation, one decision |
| `key_id` | owner signing key that produced the statement |
| `mission_id`, `approval_id`, `task_id` | the exact authorization consumed (mission scope has NULL task) |
| `decision` | `approve` or `reject` (CHECK constrained) |
| `issued_at`, `expires_at` | attestation issue time and signed approval expiry |
| `consumed_at` | when the registry accepted the nonce |
| `status` | `consumed`, `revoked`, `expired` or `released` (CHECK constrained) |
| `revoked_at`, `revoke_reason` | audit trail for withdrawals |

Indexes: `..._mission (mission_id, consumed_at DESC)`, `..._approval (approval_id)`,
`..._expiry (status, expires_at)`. Rows are never deleted by expiry cleanup; it marks them `expired` so a
replayed attestation still fails. A `released` row means the mission write failed and the nonce was rolled
back. Application code never migrates: `verifySchema()` refuses to serve when this table is absent.
