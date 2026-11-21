# Habitat Revision 4 security model

Status: **implemented and locally tested; not deployed or live-verified.** This document describes
the non-production Revision 4 authorization boundaries and the required rollout steps for existing
D1 data.

## Trust boundaries

- A **device token** proves possession of a paired device credential. It does not by itself grant
  owner authority.
- The **owner device ID** is configured server-side (`HABITAT_OWNER_DEVICE_ID(S)`). A request body
  can never select or change the owner.
- The **Ax bridge token** authenticates machine/operator command routes. It is not an owner-device
  token and cannot approve owner actions.
- The **Home Bridge credentials** (`HOME_BRIDGE_AX_TOKEN`, `HOME_BRIDGE_BUFF_TOKEN`) are held only by
  the server. They are never returned to a browser or device.
- The **break-glass token** is a separate credential used only for owner lockout recovery. It is not
  an operator token, a device token, or a general owner-management credential.
- **Nexus runtime** is non-production only in Revision 4. Production runtime features stay disabled.

## Finding-by-finding controls

| Finding | Control |
| --- | --- |
| H1 `/chat` device commands | `/chat` device status requires a verified owner device token and owner ID before dispatch. The bridge selects only devices whose recorded owner matches the authenticated owner; an optional target must belong to that owner. Global most-recent-device selection is gone. |
| H2 Habitat dashboard/file/phone | `/device/habitat`, `/device/habitat/file`, and every `/device/habitat/phone` action require a paired device token **and** the configured owner device. A non-owner paired device receives 403 before any relay call. |
| H3 pairing replay | A code is consumed with a conditional update. A lost first response can be recovered once, only by the same device, within 60 seconds, using a conditional `recovery_at` claim. Later replays and other devices are refused. |
| H4 bootstrap reactivation | `seedBootstrapPairing` preserves `consumed_at` and the bound device; it never restores a wildcard or makes a consumed code usable on restart. A revoked bootstrap owner is skipped. |
| H5 revoked-owner codes | Pairing codes record their issuer in `habitat_pairing_owners`. Revoking a device deletes every code it issued. Redemption requires an active, non-revoked owner; enrolling a non-owner target requires the owner to be actively paired. |
| H6 legacy ownership | No legacy owner is inferred. `device-ownership-migration.mjs` accepts only an explicit operator mapping. Backfill preflight requires the proposed owner to be in the configured owner allowlist, exist as a paired device, be unrevoked, and hold an active credential; missing, inactive, revoked, or unauthorized owners are rejected. The target must exist and no different ownership may already exist. |
| H7 owner lockout | Owner recovery requires the target's recorded owner and destroys old credentials/codes. If the owner itself is revoked, a separate break-glass route requires `HABITAT_BREAK_GLASS_TOKEN`, audits the action, and leaves the device requiring a fresh pairing. |
| Atomic ownership | Ownership is claimed with a conditional `INSERT ... ON CONFLICT DO NOTHING` before the token write; the loser cannot overwrite the winner's owner or credential. |
| Task approval policy | Global-owner approval is deliberate: any configured owner device may approve any command task. The policy is audited. Per-owner task ownership was not added because Revision 4 tasks are operational queues, not tenant data. |
| Home Bridge URL | `HOME_BRIDGE_URL` is required and explicit. There is no hardcoded or default credential destination; a missing/malformed URL fails without a network call. |
| Console | Login and state-changing routes enforce same-origin (or exact `HABITAT_CONSOLE_ORIGIN`), rate-limit failed logins, and issue `HttpOnly; Secure; SameSite=Strict` session cookies. |
| Durable audit | `habitat_security_audit` records pairing mint/redeem/recovery, revocation/unrevocation, break-glass attempts, device status requests, ownership backfill, and command approvals/denials/completions. |
| Production safeguards | `HABITAT_RUNTIME_ENV=production` or `NODE_ENV=production`, or a configured D1 ID matching `HABITAT_PRODUCTION_D1_DATABASE_ID`, disables Nexus and owner enrollment. |
| D1 consistency | Pairing creation compensates a failed owner insert. Recovery deletes old codes before clearing revocation. Revocation invalidates codes and cancels pending commands. |
| Rollback | The verified rollback target is Revision 3 `662d6b5f2d1374cb0a8b9447b56ae3015036fdc2`; see `docs/NEXUS_RUNTIME_MOUNT.md`. |

## Deliberate global-owner task approval policy

An authenticated configured owner device may request, approve, deny, complete, fail, or retry any
command task. This is intentional for the current single-operator deployment. Task records are not
multi-tenant data and do not carry an owner column. Authorization is still fail-closed: the device
token must verify and the device ID must be in the configured owner set. The Ax bridge token cannot
perform owner decisions. If Habitat later supports multiple independent tenants, command tasks must
gain an owner/tenant column and every read/mutation must be scoped to it; do not reuse the current
global-owner policy for tenant data.

## Migration and backfill plan for existing D1

1. **Back up/snapshot** the non-production D1 database and record its ID. Confirm it differs from
   the production ID.
2. Apply additive `migrations/0003_device_ownership_security.sql`, or let the application's
   idempotent `initialize()` create the tables. `initialize()` also adds `recovery_at` to an existing
   Revision 3 pairing table after checking `PRAGMA table_info`; startup fails closed if the schema
   cannot be verified.
3. **Do not run the old bootstrap code to infer owners.** Enumerate existing paired devices through
   an authorized read-only inventory.
4. Write an explicit JSON mapping:
   `{ "devices": [ { "deviceId": "existing-phone", "ownerDeviceId": "owner-phone" } ] }`.
   Every mapping must be reviewed by the owner; the tool refuses duplicates, invalid IDs, missing
   targets, existing ownership, and owners that are not authorized, paired, active, or unrevoked.
5. Export the same explicit owner allowlist used by the runtime, for example
   `HABITAT_OWNER_DEVICE_IDS=owner-phone`. There is no implicit owner allowlist and no arbitrary
   CLI override: the mapping must use an owner the service actually authorizes.
6. Dry-run (does **not** call `initialize()`, create schema, insert mappings, or write audit rows):
   `HABITAT_OWNER_DEVICE_IDS=owner-phone node scripts/backfill-device-ownership.mjs --map ownership.json`.
   It runs the same owner/target/ownership preflight as apply and reports `wouldAssign`, failures,
   and already-assigned rows. The schema must already exist; dry-run never creates it.
7. Apply with an explicit confirmation:
   `HABITAT_OWNER_DEVICE_IDS=owner-phone node scripts/backfill-device-ownership.mjs --map ownership.json --apply --confirm APPLY_DEVICE_OWNERSHIP_BACKFILL`.
   Apply initializes the additive schema and repeats the preflight before each conditional write.
8. Verify every existing device has exactly one expected owner; devices omitted from the mapping
   remain unowned and therefore fail owner-scoped dashboard/file/phone access until explicitly
   mapped. Do not "fix" an omitted device by choosing the first owner.
9. Pair/rotate owner devices through fresh codes. Revoke any legacy device that cannot be mapped;
   revocation destroys its codes and pending commands.
10. Record the mapping file location in the operator's secure change record, never in git.

## Required environment (non-production)

`HABITAT_RUNTIME_ENV=nonproduction`, `HABITAT_OWNER_DEVICE_ID` (exactly one owner for bootstrap
minting), `HABITAT_AX_BRIDGE_TOKEN`, D1 credentials, and — when the Home Bridge console is used —
`HOME_BRIDGE_URL`, `HOME_BRIDGE_AX_TOKEN`, `HOME_BRIDGE_BUFF_TOKEN`, and a separate
`HABITAT_BREAK_GLASS_TOKEN`. Do not set production credentials. Do not enable these features in a
production runtime.

## Verification limits

Local tests cover the authorization, pairing, revocation, recovery, migration, audit, and SQL
paths. They do not prove live Cloudflare D1 behavior, Render deployment, Android behavior, or
production configuration. Those require separate authorized verification.
