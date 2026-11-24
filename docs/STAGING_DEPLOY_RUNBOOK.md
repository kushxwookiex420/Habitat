# Staging deployment runbook

Target service: `habitat-staging-e3ie.onrender.com` (blueprint `render.staging.yaml`, `autoDeploy: false`).
Production (`habitat-1-szzd.onrender.com`) is out of scope for every step below.

## 0. Machine-checked preflight

```
node scripts/staging-deploy-preflight.mjs --target <sha>
```

Exit `0` means the diff carries no migration, no production configuration and no deployment-file change,
and the staging blueprint still has `NEXUS_RUNTIME_ENABLED`, `HABITAT_MISSIONS_ENABLED` and
`HABITAT_WORKFORCE_ENABLED` false with `HABITAT_ENVIRONMENT=staging`. Exit `1` prints the blockers; do
not deploy while any exist. The script reads the commit from the live `/health`, so the "before" side is
observed, not assumed, and it refuses a production origin.

Last run: `afa97af` against deployed `efcf65c`. Preflight **exited `1`** with one blocker,
`migrations_in_diff`: `0017_ax_approval_nonces.sql`, `0018_ax_workforce_v1.sql` and
`0019_ax_workforce_identity.sql` are in the diff. Outside `.scratch` the diff is 91 files (+19,263/−339),
and the target tree also carries 8,297 tracked `.scratch/` files with no `.dockerignore`, so the Docker
build context is far larger than "a console fix". Flags read `environment=staging, nexus=false,
migrations=false, workforce=false`.

The deploy was therefore made **code-only**: none of 0017–0019 was applied, `HABITAT_WORKFORCE_ENABLED`
stayed `false`, and the process runs the documented degraded workforce
(`/ax/v1/workforce*` → 503 `workforce_leases_not_attached`, `workforce.state: disabled`). Treat
`migrations_in_diff` as a real blocker for any deploy that would also apply schema; overriding it is a
recorded decision, not a routine step.

## 1. Deploy

1. Render → `habitat-staging-e3ie` → Environment: confirm the three autonomy flags are `false` and
   `HABITAT_ENVIRONMENT=staging`.
2. Manual Deploy → branch `staging/integration` → the target commit. Render deploys the branch **head**,
   so confirm `git ls-remote origin refs/heads/staging/integration` equals the target SHA first.
3. Watch the startup log for `STAGING_GUARD` pass (no `STAGING_GUARD_REFUSED_START`) and
   `NEXUS_RUNTIME: disabled`.

## 2. Verify (all four must hold)

| Check | Expected |
| --- | --- |
| `GET /health` | `commit` = target, `deviceBridge.ready:true`, `nexus.configured:false` |
| `GET /system/status` | `environment.name:"staging"`, `databaseGuardActive:true`, storage `ready`, gateway enabled, `workers.execution.canExecute:false` |
| unauthenticated `/ax/device/devices`, `/device/commands/next`, `/ax/command/diagnostics`, `/mcp` | `401` |
| `GET /health` `secretsExposed` | `false` |

A response `200` is not verification: read the fields. Deployment is "deployed"; the checks above are what
make it "live and verified".

## 3. Roll back

Render → Deploys → previous successful deploy (`efcf65c`) → Redeploy. The `efcf65c..afa97af` deploy was
code-only (0017–0019 were never applied), so rollback is a code revert only; no data is touched. Re-run the `/health` commit
check afterwards.

## 4. What stays off after this deploy

The deploy does not enable autonomy. `NEXUS_RUNTIME_ENABLED` remains false until the authenticated round
trip, the failure notification, approval enforcement and this rollback procedure are each verified.

## 5. Credentials (values never in chat, logs, or the repository)

**Dedicated staging bridge token.** Generate it on your own machine (`openssl rand -hex 32`), then set that
one value in two places: Render → `habitat-staging-e3ie` → `HABITAT_AX_BRIDGE_TOKEN`, and GitHub →
Settings → Secrets and variables → Actions → `HABITAT_AX_COMMAND_TOKEN`. Do not reuse production's bridge
token: a staging incident must never force a production rotation, and a probe must never be able to reach
production by accident. Both probes treat the value as opaque and stop at `401` before doing any work;
neither prints it, and the round trip redacts the device id as well.

**D1, CI only.** `HABITAT_D1_API_TOKEN` exists so CI can verify and read D1 metadata. The Render service's
own D1 credential is separate and must not be changed to fix CI.

**How to verify the token without seeing it.** Run the `Staging round trip` workflow (the round trip) and
the `Staging device audit (read-only)` workflow (the token itself). The audit prints
`/user/tokens/verify` status, its `expires_on`, and the D1 metadata status, which is what distinguishes an
expired token (`1000:Invalid API Token`) from an under-scoped one (verify active, metadata refused).

## 6. Observed preflight results

| Target | Deployed | Migrations | Deployment files | Production config | Blockers | Warnings |
| --- | --- | --- | --- | --- | --- | --- |
| `76e9330` | `efcf65c` | 0 | 0 | 0 | none | none |
| `ee467a3` | `efcf65c` | 0 | 0 | 0 | none | none |
| `afa97af` | `efcf65c` | 3 | 0 | 0 | `migrations_in_diff` (accepted, code-only) | none |

Every run reads the deployed commit from the live `/health`; all found `environment=staging` with
`nexus`, `missions` and `workforce` false. The `afa97af` deploy was manual (`dep-dc2u4mpksfps73drao1g`,
`trigger: manual`, `status: live`, 19:15:39Z–19:18:59Z), `autoDeploy` is still `false`, and its
verification results are recorded in `docs/STAGING_EVIDENCE.md` under the 19:15Z update.
