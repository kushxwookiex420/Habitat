# NEXUS autonomous execution foundation

Branch: `ax-nexus/revision-4.6-nexus-mainline-integration` (PR #93). This describes what the code now
does and how an operator reads it. Nothing here is deployed or enabled.

---

## 1. Two ways to execute, one engine

| | Mounted runtime (`device-command-bridge.mjs`) | One-shot tick (`scripts/nexus-tick.mjs`) |
| --- | --- | --- |
| Process | the web service | a fresh process per run |
| Trigger | `setInterval`, only while the service is awake | a scheduler (cron, workflow, manual) |
| Lifetime | until the service sleeps or dies | one unit of work, then exit |
| Needs an HTTP port | yes (it is the web service) | no |
| State | D1 only | D1 only |

Both build the **same** repository, engine, tool registry, adapter map and claim SQL, and both read
their knobs from **one** resolver (`resolveNexusConfig`). Only one may run against a queue at a time
in practice, and it does not matter if both do: the claim is a single conditional `UPDATE`, so two
workers cannot own the same row.

Recommended production shape: **the cron tick is the executor; the in-process timer stays off.** That
is why `NEXUS_RUNTIME_ENABLED` is read by both — it is one switch for "NEXUS may execute".

---

## 2. What one tick does

```
heartbeat("idle")            routine liveness, throttled
pruneWorkerHeartbeats()      retention, at most once per hour
recoverExpired()             requeue or fail expired leases, bounded by maxAttempts
claim()                      one conditional UPDATE … RETURNING, oldest eligible row
heartbeat("executing")       only when a row was claimed
execute(task)                adapter → evidence → fenced complete, or fenced fail
heartbeat("idle")            throttled again
```

If any step throws, the tick records `{ok:false, stage:"tick", error}` in `lastTick`, writes an
`error` heartbeat (never throttled), and returns it. A failed tick is never reported as an idle one.

### Exit codes (`scripts/nexus-tick.mjs`)

| Code | Meaning | What an operator should do |
| --- | --- | --- |
| 0 | Tick completed; no eligible work waiting past the deadline | nothing |
| 1 | Tick failed — D1 unreachable, statement failed, claim failed, unexpected error | read the `error` field and the service log; the queue is intact |
| 2 | Tick completed but the queue is **stale** — eligible work waited past `NEXUS_STALE_QUEUE_SECONDS` | the scheduler is too slow or the work is too large; no data is lost |
| 3 | Not runnable — D1 configuration missing/invalid, or `NEXUS_RUNTIME_ENABLED` is not `true` | fix configuration; nothing was attempted |

A non-zero code is the alarm. Render Cron Jobs raise a failure notification on a non-zero exit, so
code 2 is a real, actionable page rather than a log line nobody reads.

stdout is exactly one JSON line (schema below) and contains no credential, so it can be captured as
evidence. Example (abridged, from a local SQLite run):

```json
{"schemaVersion":1,"ok":true,"state":"ticked","workerId":"nexus-1a2b3c4d",
 "tick":{"ok":true,"claimed":1,"completed":1,"failed":0,"recovered":0,"error":null},
 "queue":{"eligible":0,"blocked":0,"claimable":false,"stale":false,"staleAfterSeconds":600},
 "staleQueue":false,"config":{"heartbeatSeconds":30,"maxAttempts":3,"retentionDays":7}}
```

---

## 3. Heartbeat and retention policy

The old policy wrote a heartbeat every tick and every tick named itself twice (`polling`, then
`idle`), so an idle worker at a 5 s poll produced ≈34,600 rows/day — a third of D1 Free's daily write
allowance before doing any work.

New policy:

- **Lifecycle and execution transitions are always written**: `starting`, `executing`, `stopped`, `error`.
- **Routine liveness is written at most once per `NEXUS_HEARTBEAT_SECONDS`** (default 30, minimum 30).
  `polling` and `idle` are treated as the same routine state, so naming a tick twice does not double
  the write.
- **Retention**: `DELETE FROM habitat_nexus_workers WHERE worker_id <> ? AND heartbeat_at < ?`
  removes other workers' rows older than `NEXUS_RETENTION_DAYS` (default 7). It never deletes this
  worker's row, runs at most once per hour, and a failure is logged and ignored — housekeeping cannot
  fail a tick.

Resulting write budget with a 5-minute cron: ≈288 heartbeat rows/day, ≈288 claim statements (which
write nothing when the queue is empty), plus one retention statement per hour. Well inside D1 Free.

---

## 4. Stale-queue alarm

`readQueueHealth()` answers one query:

```sql
SELECT SUM(eligible), SUM(blocked), MIN(updated_at of eligible) FROM habitat_command_tasks
```

- **eligible** — queued rows that name an adapter. Only these can be claimed.
- **blocked** — queued rows that name no adapter. They wait for a human and are reported, never
  silently ignored and never executed.
- **stale** — eligible work whose `updated_at` is older than `NEXUS_STALE_QUEUE_SECONDS`
  (default 600). `updated_at` is used rather than `createdAt` so a requeued task is measured from
  when it re-entered the queue.

Surfaces: the tick's exit code 2 and `report.queue.stale`; `GET /nexus/runtime` → `runtime.queue`,
`runtime.staleQueue`; `GET /health` → `nexus.lastTick` (in-process) and `nexus.state`.

---

## 5. Honest reporting

| Observation | Honest meaning |
| --- | --- |
| `nexus.configured=false, reason="disabled_by_config"` | the worker was never mounted; nothing will execute |
| `reason="command_store_unavailable"` | D1 is not configured; nothing will execute |
| `reason="mount_failed"` | mounting threw (bad config or a refused adapter); read the log line |
| `state="mounted_not_ready"` | mounted, storage not initialized yet |
| `state="mounted_not_started"` | mounted but not polling (`startWorker:false`, or init failed) |
| `state="running"` + `asleep=false` | a fresh heartbeat exists in D1 |
| `state="started_no_live_heartbeat"` / `asleep=true` | this process believes it started, but no heartbeat is fresh: **nothing is executing** |
| `staleQueue=true` | eligible work is waiting too long |
| `queue.ok=false` | the queue could not be read — that is not a success signal |
| tick `ok=false` | the tick failed; `error` and `stage` say where |
| tick exit 2 | execution works, throughput does not keep up |

`asleep` is deliberately separate from `heartbeatVerified`: a sleeping service is a pause, not a
failure and certainly not a success.

---

## 6. Adapter policy

`assertReadOnlyAdapters()` runs at mount and refuses any adapter outside
`repo.inspect`, `task.inspect`, `runtime.health` while `SIDE_EFFECTING_ADAPTERS_ENABLED` is false.
The refusal is a boot-time error with the offending names, not a comment.

Reason: the worker retries an expired lease. An adapter that cannot prove it is idempotent would
perform its side effect twice after a crash. Side-effecting adapters stay off until per-task
idempotency (or an `atMostOnce` class) is implemented **and tested**. `repo.test`, the only adapter
that executes anything, is not part of the mounted set at all.

---

## 7. Configuration

| Variable | Default | Range | Used by |
| --- | --- | --- | --- |
| `NEXUS_RUNTIME_ENABLED` | unset (off) | exactly `true` | both — the master switch |
| `NEXUS_HEARTBEAT_SECONDS` | 30 | 30–3600 | both |
| `NEXUS_RETENTION_DAYS` | 7 | 1–365 | both |
| `NEXUS_STALE_QUEUE_SECONDS` | 600 | 60–86400 | both |
| `NEXUS_MAX_ATTEMPTS` | 3 | 1–100 | both |
| `NEXUS_LEASE_MS` | 300000 | 200–86400000 | worker |
| `NEXUS_POLL_MS` | 5000 | 50–3600000 | mounted worker only |
| `NEXUS_ADAPTER_TIMEOUT_MS` | 120000 | 100–86400000 | both |
| `NEXUS_SHUTDOWN_TIMEOUT_MS` | 15000 | 0–600000 | mounted worker only |

An invalid value is a **boot-time error**, not a clamp: the mount records
`nexus.reason="mount_failed"` with the variable name, and a tick exits 3 with
`state:"invalid_configuration"`.

---

## 8. Local verification (no D1, no deployment)

```sh
npm run check                                   # syntax of every module and test
node --test tests/nexus-tick.test.mjs tests/nexus-autonomous-foundation.test.mjs
npm test                                        # whole suite

npm run tick                                    # no D1 credentials:
# {"schemaVersion":1,"ok":false,"state":"disabled","reason":"missing_configuration",...}
# exit code 3
```

What those prove: the entrypoint claims and completes eligible work, reports it, refuses to run
unconfigured or disabled, exits 2 on a stale backlog and 1 on a D1 failure; heartbeats are bounded;
retention is bounded and safe; the queue alarm means throughput; a mutating adapter cannot mount.

What they do **not** prove: that the live database, the cron service or the deployment behave this
way. That requires the checks in `docs/NEXUS_CRON_DEPLOYMENT.md`.
