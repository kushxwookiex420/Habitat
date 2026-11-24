# Approval nonce lookup benchmark (0017)

`node scripts/benchmark-approval-nonces.mjs` (override with `BENCH_MISSIONS`, `BENCH_LOOKUPS`).

Environment: local `node:sqlite` in-memory database, migrations `0011_ax_missions` + `0017_ax_approval_nonces`.
This is **not** a D1 measurement; it is the closest verification available without applying anything to a live
database. Data: 2,000 missions, 3 approvals each, 4,000 registry rows, random nonce lookups.

| Lookup | Query plan | 500 lookups | Per lookup |
|---|---|---|---|
| Indexed registry (`WHERE nonce = ?`) | `SEARCH ... USING COVERING INDEX sqlite_autoindex_habitat_ax_approval_nonces_1 (nonce=?)` | 1.05–1.10 ms | 0.0021–0.0022 ms |
| Legacy JSON scan (`record_json LIKE '%"nonce":"…"%'`) | `SCAN habitat_ax_missions` | 3,039–3,505 ms | 6.08–7.01 ms |

Speedup at this size: **≈2,780–3,350×** across runs. The scan is linear in mission count and reads full mission records; the
registry lookup is O(log n) on the primary key and touches no mission payload. The gap grows with mission
history, which is exactly why replay checks cannot remain a JSON scan.

Limit: SQLite and D1 both use the same primary-key B-tree shape, but D1 network latency dominates a single
remote lookup. The benchmark proves algorithmic behavior and plan selection, not D1 wall-clock latency.
