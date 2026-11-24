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

## Worker leases and execution ledger (0018)

Autonomous workforce v1 adds four tables. They are additive: 0010 remains the agent registry, and 0018 is
the execution-ownership layer around it.

| Table | Key | Meaning |
| --- | --- | --- |
| `habitat_ax_workforce_workers` | `worker_id` | registration state, capability JSON, `accepting`, `max_concurrent`, `heartbeat_at`, `revision` |
| `habitat_ax_workforce_leases` | `lease_id` | one worker's right to execute one task: `state`, `attempt`, `expires_at`, `renewed_at`, `released_at` |
| `habitat_ax_workforce_executions` | `idempotency_key` | at-most-once ledger per attempt: `inflight`, `succeeded`, `failed`, `uncertain` |
| `habitat_ax_workforce_recovery` | `seq` | append-only journal: lease expiries, worker stalls, resumes, uncertain outcomes |

Two guarantees are structural:

- `habitat_ax_workforce_leases_active_task` is a **partial unique index** on `(task_id) WHERE state =
  'active'`, so two workers racing the same task cannot both own it. Closed leases remain for history.
- The executions primary key means a retried attempt reaches the same row and is refused instead of
  calling an external operation twice.

Indexes: workers `(state, heartbeat_at DESC)`; leases `(worker_id, state)`, `(state, expires_at)`,
`(mission_id, acquired_at)`; executions `(mission_id, task_id, attempt)`, `(state, updated_at)`; recovery
`(mission_id, seq)`, `(kind, at)`.

Lease rows are never deleted. Expiry marks `state = 'expired'`; forced deregistration marks `abandoned`;
a lost outcome marks `uncertain`. Because the sweep is one `UPDATE`, reads treat the **columns** as
authoritative over `record_json` — otherwise a swept lease would still read as active.

`GET /system/status` reports `workforceV1.enforced` so an environment with 0010 but not 0018 is visibly
running without lease enforcement rather than silently claiming it.

Contract and dashboard mapping: `docs/AUTONOMOUS_WORKFORCE_V1.md`.
