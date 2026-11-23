# Owner-device and deployed-origin tests

These are the checks that cannot be run on the development machine. Local tests prove the code
paths with injected fakes; the rows below are the remaining evidence. Every row says what to send,
what must come back, and what a failure means. None of it is authorised by this repository: each row
is an owner action against a deployment the owner controls.

Do not install or sign a Bridge build, connect a supplier account, or enable `NEXUS_RUNTIME_ENABLED`
to complete these rows. If a row needs one of those, it is out of scope and stays unrun.

## 1. Owner-device identity (needs the phone attached)

| # | Check | Command | Expected | If it fails |
| --- | --- | --- | --- | --- |
| 1.1 | Installed app identity matches the repository build | `node scripts/bridge-identity-check.mjs` | the script reports the installed package and signing identity and exits 0 | `adb_unavailable` is **not** a pass; record it as not run |
| 1.2 | Pairing survives a restart | pair, kill the app, reopen | the same device id is presented; no second pairing row | a new id per launch means pairing is not persisted |
| 1.3 | The owner token is device-bound | reuse the owner token with a different `x-owner-device-id` | `401 owner_invalid` | any 2xx means the token is not bound to the device |

## 2. Approval decisions against the deployed origin

Set `B` to the deployed origin and `T` to the device-bridge token. The owner headers are
`x-owner-device-id` and `x-owner-device-token`.

```sh
B=https://<deployed-origin>
H="Authorization: Bearer $HABITAT_AX_BRIDGE_TOKEN"
```

Create a request with an agent credential, then decide it as the owner:

| # | Request | Expected | Meaning |
| --- | --- | --- | --- |
| 2.1 | `POST $B/ax/command/network/approvals` with the command token | `201`, `approval.status=requested`, `requestedBy` starts `ax:` | an agent can ask, never decide |
| 2.2 | same body with `capabilityId` set to an id not in the catalogue | `400 unknown_capability`, and `GET .../approvals` is unchanged | the registry is the authority, not the body |
| 2.3 | `POST .../approvals/<id>/approve` with the command token **and** valid owner headers | `403 command_token_cannot_approve` | the command surface cannot self-approve even with a device header |
| 2.4 | `POST .../approve` with the bridge token, no owner headers | `401 owner_required` | pairing is required for money |
| 2.5 | `POST .../approve` with a wrong `x-owner-device-token` | `401 owner_invalid` | token comparison fails closed |
| 2.6 | `POST .../approve` with valid owner headers | `200`, `approval.status=approved`, `decidedBy` starts `owner:` | the decision names the device |
| 2.7 | repeat 2.6 | `409 already_decided` | one decision per request |
| 2.8 | `POST .../deny` on a fresh request | `200`, status `denied` | denial is first-class |
| 2.9 | wait past the TTL, then `GET .../approvals/<id>` | `expired` | reads report the effective status |
| 2.10 | `POST .../approve` on the expired request | `409 approval_expired` | expiry cannot be revived by a late decision |

## 3. Treasury entries (owner-device only)

| # | Request | Expected |
| --- | --- | --- |
| 3.1 | `POST $B/ax/command/network/treasury/events`, state `available`, with owner headers and evidence | `201`; `GET .../treasury` shows `availableCents` and `cashCents` |
| 3.2 | the same with the command token | `403 command_token_cannot_approve` |
| 3.3 | `POST .../treasury/events`, state `refunded`, with `externalId` | `201`; `refundedCents` rises once |
| 3.4 | replay 3.3 with a new event `id` and a different evidence string | `409 duplicate_refund` |
| 3.5 | `POST .../treasury/events`, state `reversed`, **without** `externalId` | `400 refund_reference_required` |
| 3.6 | `POST .../treasury/payouts`, state `in_transit`, owner headers | `201`, `externalActionPerformed=false`; in-transit rises, cash does not |

## 4. Per-credential write limit

| # | Request | Expected |
| --- | --- | --- |
| 4.1 | more `POST .../approvals` in one minute than `AX_NETWORK_WRITE_RATE_MAX` (default 60) | `429 network_rate_limited` with `retry-after` |
| 4.2 | `GET .../network/status` while 4.1 is returning 429 | `200`; reads are not in the write bucket |
| 4.3 | wait for `retry-after`, then retry | `201` again |

`429` is per process. Behind N instances the effective limit is N times the configured value; record
the instance count alongside the result rather than hiding it.

## 5. Scheduler tick and approval-expiry monitoring

| # | Request | Expected |
| --- | --- | --- |
| 5.1 | `POST $B/ax/command/scheduler/tick` with `X-Scheduler-Token` only | `200`, `ok=true`, an `approvals` block |
| 5.2 | same without any credential | `401 scheduler_auth_required` |
| 5.3 | create a request, let it pass its TTL, tick | `approvals.expired >= 1`; findings contain `approval.expired` with `subject: "approval:<id>"`; `status` is `degraded` |
| 5.4 | tick again without changes | `approvals.expired` is `0`; the row is already `expired`; no duplicate finding |
| 5.5 | create a request expiring in under an hour, tick | `approvals.expiringSoon >= 1` and an `approval.expiring` warning |
| 5.6 | two ticks in parallel | one completes, the other reports the lease as held; the ledger is never swept twice |

If the process also runs a Cron Trigger, add the request id and dashboard invocation time to the
record. A trigger that is configured but never observed firing is not evidence.

## 6. Deployed-origin surface

| # | Request | Expected |
| --- | --- | --- |
| 6.1 | `GET $B/ax/command/network/status` with no credential | `401 invalid_token` |
| 6.2 | same with `Origin: https://attacker.example` and no credential | `401`; no `access-control-allow-origin` header; a browser cannot read the response cross-origin |
| 6.3 | same with a valid token and a foreign `Origin` | `200` for curl (no CORS header is added). Record the header set; if a CORS policy is added later, it must name an allowlist, never `*` on an authenticated route |
| 6.4 | `GET $B/` over plain HTTP | redirect to HTTPS or a refusal; never a served page and a token prompt over HTTP |
| 6.5 | `GET $B/ax/command/network/treasury` with a valid token | `200`; response carries `cache-control: no-store` (or no cacheable header) so a shared cache cannot replay it |
| 6.6 | check the deployed commit | it equals the commit recorded for this hardening run; otherwise every row above describes older code |

## 7. What stays unverified until these run

- That the installed Bridge build is the reviewed one (1.1).
- That a real phone's owner token cannot be replayed from another device (1.3).
- That the deployed origin enforces the same approval, refund and rate-limit rules as the test
  harness (2–5).
- That scheduling fires in production (5.6 with a real trigger, and the dashboard history).
- That no cross-origin page can read an authenticated response (6.2–6.3).

Record the date, origin, deployed commit and the exact response bodies. A row without a recorded
response body is not evidence.
