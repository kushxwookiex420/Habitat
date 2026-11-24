# Render Cron Job deployment specification — NEXUS tick

Specification only. **Nothing in this document has been created.** Creating the service costs money
(at least $1/month) and requires the owner's approval.

Purpose: execute `habitat_command_tasks` on a schedule with no dependency on the free web service
staying awake.

---

## 1. Why a Cron Job

| | Free web service + timer | **Cron Job (this spec)** | Background worker |
| --- | --- | --- | --- |
| Cost | $0 | $1/month minimum (prorated per second, ~$0.00016/min on 512 MB) | $7/month |
| Runs when nobody calls it | no — sleeps after 15 min idle | **yes** | yes |
| Keeps a process alive | n/a | no — one process per run | yes |
| Maximum run | n/a | 12 h, then Render stops it | unlimited |
| Needs an HTTP port | yes | no | no |
| Free tier | yes | **no** | no |

Source: `render.com/pricing`, `render.com/docs/cronjobs` (checked 2026-11-21).

A 5-minute schedule of a tick that takes seconds lands far below the $1 floor.

The cron job is a **separate Render service** with its own environment. That is deliberate: set
`NEXUS_RUNTIME_ENABLED=true` **only there**, and the web service keeps its in-process timer off. One
executor, one switch, no double polling.

---

## 2. Service fields

| Field | Value |
| --- | --- |
| Type | Cron Job |
| Name | `ax-nexus-habitat-tick` |
| Region | same as `Habitat-1` (Oregon) |
| Repository | `kushxwookiex420/Habitat` |
| Branch | `ax-nexus/revision-4.6-nexus-mainline-integration` until PR #93 merges, then `main` |
| Root Directory | `.` (repository is flat) |
| Runtime | Node |
| `NODE_VERSION` | `22.14.0` (package `engines` requires >= 22) |
| Build Command | `npm install --omit=dev --ignore-scripts` |
| Command | `node scripts/nexus-tick.mjs` |
| Schedule | `*/5 * * * *` |
| Instance | smallest (Starter, 512 MB) — the $1/month minimum |
| Auto-deploy | off, until the owner has reviewed one manual run |

Do **not** add `npm start`, a port, or a health check path: this service runs one command and exits.

## 3. Environment variables

Set only these on the cron service. Values come from the Render dashboard, never from a file in this
repository.

| Variable | Value | Notes |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | from the dashboard | same account as the web service |
| `HABITAT_D1_DATABASE_ID` | same database as the web service | **must** be the same database; the tick and the API share `habitat_command_tasks` |
| `HABITAT_D1_API_TOKEN` | from the dashboard | same token as the web service |
| `NEXUS_RUNTIME_ENABLED` | `true` | the master switch; without it the tick exits 3 |
| `NEXUS_HEARTBEAT_SECONDS` | `30` | default; do not lower |
| `NEXUS_RETENTION_DAYS` | `7` | heartbeat retention |
| `NEXUS_STALE_QUEUE_SECONDS` | `600` | exit 2 threshold |
| `NEXUS_MAX_ATTEMPTS` | `3` | retry ceiling |

Do **not** set on this service: `HABITAT_AX_BRIDGE_TOKEN`, `HABITAT_OWNER_DEVICE_IDS`,
`HABITAT_BREAK_GLASS_TOKEN`, `OPENAI_API_KEY`, or any device/pairing secret. The tick needs D1 only.

**Non-production separation.** If this is ever pointed at a non-production database, use that
database's own id and token, and keep the production id out of this service's environment entirely.
A tick against production will execute production queued work.

## 4. Prerequisites (all owner actions)

1. `habitat_command_tasks` exists. Either make one authenticated `GET /ax/command/tasks` against the
   web service, or run `migrations/0002_habitat_command_tasks.sql` once in the D1 console. Both are
   `CREATE TABLE IF NOT EXISTS`.
2. The database id on the cron service equals the one on `Habitat-1`. Compare the non-secret
   fingerprint reported by `GET /nexus/runtime` (`databaseFingerprint`) if in doubt.
3. `HABITAT_OWNER_DEVICE_IDS` is set on the **web** service (not here) if owner approvals will be
   used.
4. No side-effecting adapter is mounted. Only `repo.inspect`, `task.inspect` and `runtime.health`
   are registrable while `SIDE_EFFECTING_ADAPTERS_ENABLED` is false.

## 5. Verification sequence

After creating the service, use **Trigger Run** once and read the log. Do not rely on the schedule
firing immediately.

```sh
# 1. local expectation (no D1): the same report shape and exit code
npm run tick ; echo "exit=$?"          # expect exit=3 and reason missing_configuration

# 2. Render log for one manual run
#    one JSON line, e.g.
#    {"schemaVersion":1,"ok":true,"state":"ticked","tick":{"claimed":0,...},"queue":{...}}
#    and the run's exit status. 0 = healthy. 2 = stale backlog. 1 = D1/claim failure. 3 = misconfigured.

# 3. runtime view (Ax bridge token required; never paste the token into a shared channel)
curl -sS "$BASE/nexus/runtime" -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN"
#    expect heartbeatVerified:true, liveWorkers>=1, state:"running",
#    lastHeartbeatAgeSeconds well under 120, queue values matching the tick report.

# 4. submit one read-only objective and watch it complete without any phone involved
curl -sS -X POST "$BASE/ax/command/tasks" -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"objective":"cron smoke check","role":"ax","adapter":"runtime.health","idempotencyKey":"cron-smoke-1"}'
# then, after the next scheduled run:
curl -sS "$BASE/ax/command/tasks/<id>" -H "Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN"
#    expect status:"done" and result.evidence containing a "runtime:" line
```

Pass criteria: the manual run exits 0, `/nexus/runtime` shows a live heartbeat, and a submitted
objective reaches `done` with adapter-produced evidence. Anything less is not operational.

Note: the tick writes its heartbeat to the **shared** `habitat_nexus_workers` table, so the web
service's `/nexus/runtime` reflects cron execution. If the web service has been asleep, its route may
need one request to wake; that wake is unrelated to whether the cron ran.

## 6. Failure handling and rollback

- Render Cron Job failure notifications fire on a non-zero exit. Map them with §2 of
  `docs/NEXUS_AUTONOMOUS_EXECUTION.md`: 1 = infrastructure, 2 = backlog, 3 = configuration.
- A run stopped at the 12-hour limit dies mid-execution; the task lease expires and a later tick
  requeues it (bounded by `NEXUS_MAX_ATTEMPTS`). No manual repair is needed.
- **Rollback is immediate and non-destructive**: suspend or delete the cron job. Nothing else
  changes. The web service, its routes and the database are untouched; queued rows simply wait.
- Never "fix" a backlog by deleting rows. Inspect `GET /ax/command/tasks?status=queued` first.

## 7. Cost

$1/month minimum per cron job service. A 5-minute schedule with a sub-minute tick spends well under
that, so the floor is the real cost. No other Render resource is required, and D1 Free covers the
resulting reads and writes.

## 8. What is still not implemented

- The cron job itself (this document is the specification).
- Any live verification of this specification.
- A wake-up path for the **web service's** own timer. The recommendation is to leave that timer off
  and let the cron job be the only executor.
