# NEXUS GitHub Actions scheduler (free-hosted runner)

This is the $0 Render alternative for the one-shot NEXUS tick. It uses GitHub-hosted
Ubuntu runners and the existing `scripts/nexus-tick.mjs`; it does not keep Habitat's
Render web service awake.

## What it does

- Scheduled every five minutes, plus a manual workflow dispatch.
- Executes at most one unit of queued work per run.
- Uses the same Cloudflare D1 database as Habitat. All worker/task state remains in D1.
- Installs only runtime dependencies and runs the existing tick entrypoint.
- Preserves the tick's exit codes: 0 healthy, 1 infrastructure/runtime failure,
  2 stale eligible queue, 3 configuration refusal.
- Does not grant the workflow any GitHub write permission.
- Does not run a shell command supplied by a queued task. The current NEXUS adapter
  registration is read-only while side-effecting adapters remain disabled.

## Safety defaults

The workflow is committed with execution **off**. When enabled, each run first
calls Habitat's authenticated scheduler route (Ax message drain/objective advance)
and then runs one NEXUS D1 worker tick (task execution).

- Scheduled runs do nothing until the repository variable
  `NEXUS_SCHEDULER_ENABLED` is explicitly set to the exact string `true`.
- Manual dispatch defaults to `run_tick=false`. The operator must explicitly select
  `run_tick=true` to execute a tick.
- Even after the gate is enabled, the workflow refuses to run if any required D1
  secret is missing.
- `NEXUS_RUNTIME_ENABLED=true` is scoped to the tick process in this workflow only.
  It does not change the Render web service environment.
- No secrets are stored in the repository, workflow file, or logs.

## Owner setup

In GitHub, open **Settings → Secrets and variables → Actions** for this repository.

Create these **repository secrets** using the exact values already configured on
Habitat-1. Do not paste them into ChatGPT or commit them to files:

1. `AX_SCHEDULER_TOKEN` — set the same randomly generated value as the
   `AX_SCHEDULER_TOKEN` environment variable on Habitat-1. Generate it locally
   (for example with a password manager); never reuse the Ax command or phone-bridge token.
2. `CLOUDFLARE_ACCOUNT_ID`
3. `HABITAT_D1_DATABASE_ID`
4. `HABITAT_D1_API_TOKEN`

Also add this **repository variable**:

- `HABITAT_BASE_URL` = `https://habitat-1-szzd.onrender.com`

The scheduler secret is used only to call Habitat's authenticated
`POST /ax/command/scheduler/tick` endpoint. The three D1 secrets are used by
the separate one-shot NEXUS worker process. The workflow first asks Habitat to
drain Ax messages and advance eligible objectives, then runs the NEXUS worker
against the same D1 database to execute the queued read-only task. This ordering
is intentional: the scheduler creates eligible work; the NEXUS tick executes it.

The database ID and token must point to the **same D1 database** used by Habitat-1.
A different database would make the workflow process a different queue.

First test safely: open **Actions → NEXUS Free D1 Scheduler → Run workflow** and
leave `run_tick` unchecked. It should report that it did not run.

Only after verifying all three secrets point to the intended Habitat database,
add the repository variable `NEXUS_SCHEDULER_ENABLED=true` under
**Settings → Secrets and variables → Actions → Variables**. That authorizes
scheduled execution. A manual run still requires selecting `run_tick=true`.

## Activation and branch behavior

This workflow is being added to PR #93's feature branch. GitHub scheduled workflows
run from the repository's **default branch only**. Therefore:

- Before PR #93 is merged, the workflow can be inspected and manually dispatched
  from its feature branch, but its five-minute schedule will not start.
- After the reviewed PR is merged to `main`, the schedule becomes eligible to run.
- Do not merge merely to activate the scheduler; review and merge the PR deliberately.

## Operational limits

GitHub's public-repository hosted-runner allowance is free, but scheduled runs are
best-effort and may be delayed or dropped during high load. A five-minute cron is
a request, not a precise real-time guarantee. GitHub Actions is not a substitute for
a 24/7 low-latency worker.

The tick processes at most one task each time. If the queue grows faster than one
eligible task per run, the tick reports stale backlog (exit 2). Monitor the Actions
run history and Habitat's `/nexus/runtime` endpoint; do not treat a green skipped
run as proof that NEXUS is executing.

## Rollback

Set `NEXUS_SCHEDULER_ENABLED` to anything other than `true` or remove the variable.
Scheduled runs then become no-ops. Remove the three D1 secrets if the integration
is being retired. This does not change Habitat-1 or delete queued D1 records.
