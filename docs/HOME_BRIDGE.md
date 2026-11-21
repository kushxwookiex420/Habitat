# Home Bridge in Habitat

Habitat hosts the Home Bridge command center at `/bridge/console`. The relay itself lives in
`kushxwookiex420/home-launcher` (`bridge/`), deployed at
`https://home-bridge-qn2hnd-preview.freebuff.site`.

## Credentials

| Secret | Role | What it can do |
| --- | --- | --- |
| `HABITAT_AX_BRIDGE_TOKEN` | Habitae operator | Opens the console. Exchanged for an HttpOnly, SameSite=Strict session cookie (8 h, in memory) so no credential is ever stored in browser JavaScript. |
| `HOME_BRIDGE_AX_TOKEN` | relay `ax` | Submit tasks, read task status and replies, list/read shared files, queue allowlisted phone commands, read phone state. |
| `HOME_BRIDGE_BUFF_TOKEN` | relay `buff` | Read and claim the task queue, post replies with artifacts, upload/update shared files, read files. |
| `HOME_BRIDGE_URL` | - | Relay base URL. Defaults to the preview deployment. |
| `HABITAT_GITHUB_REPO` | - | Repo whose commits the CLOUD tab lists. Defaults to `kushxwookiex420/home-launcher`. |
| `GITHUB_TOKEN` | - | Optional; raises the GitHub API rate limit for the commit list. |

The relay never receives `HABITAT_AX_BRIDGE_TOKEN`, and the browser never receives a relay token.
The owner pairing code is not used by Habitat at all.

## Permission matrix (relay)

| Endpoint | ax | buff | owner (pairing code) |
| --- | --- | --- | --- |
| `POST /note` (submit task) | yes | no | yes |
| `GET /tasks` | yes | yes | yes |
| `POST /reply` | no | yes | yes |
| `GET /replies` | yes | yes | yes |
| `GET /notes`, `POST /notes/ack` (claim) | no | yes | yes |
| `GET /files`, `GET /file` | yes | yes | yes |
| `POST /files` (upload/update) | no | yes | yes |
| `POST /send` (phone command) | yes | no | yes |
| `GET /state` | yes | no | yes |
| `GET/POST /keys`, `POST /keys/revoke` | no | no | yes |
| `POST /bridge`, `/poll`, `/result` (phone) | pairing code only | | |

`owner` is the 6-character pairing code: the only credential that can mint or revoke keys, and the
credential the installed launcher APK still uses. It is never needed by Habitat.

## Console routes

| Route | Purpose |
| --- | --- |
| `GET /bridge/console` | The console page (HTML only, no secrets). |
| `POST /bridge/console/login` | Exchange the operator token for a session cookie. |
| `POST /bridge/console/logout` | Drop the session. |
| `GET /bridge/console/session` | Session state plus which relay roles are configured. |
| `GET /bridge/console/dashboard` | Aggregated AX / BUFF / PHONE / CLOUD / FILES payload. |
| `GET /bridge/console/tasks` | Task list with status. |
| `POST /bridge/console/tasks` | Submit a task to Buff (`ax` credential). |
| `POST /bridge/console/claim` | Claim queued tasks (`buff` credential). |
| `GET /bridge/console/replies` | Replies with artifact links. |
| `GET /bridge/console/files` | Shared folder listing. |
| `GET /bridge/console/file?name=…` | One shared file. |
| `POST /bridge/console/send` | Queue an allowlisted phone command (`ax` credential). |

Every route except the page itself requires the operator token or a session. Without
`HABITAT_AX_BRIDGE_TOKEN` the console answers 503 instead of running unauthenticated.

## Rotation and revocation

Minting and revoking happen on the relay with the owner pairing code, so a rotated token can be
issued before the old one is killed:

```bash
BASE=https://home-bridge-qn2hnd-preview.freebuff.site

# 1. mint a replacement (role ax or buff, optional ttlDays 1-365)
curl -sS -X POST "$BASE/keys" \
  -H "authorization: Bearer $HOME_BRIDGE_OWNER_CODE" \
  -H "content-type: application/json" \
  -d '{"role":"buff","label":"buff-agent","ttlDays":90}'

# 2. list credentials to find the id of the old one
curl -sS "$BASE/keys" -H "authorization: Bearer $HOME_BRIDGE_OWNER_CODE"

# 3. revoke it (takes effect on the next request)
curl -sS -X POST "$BASE/keys/revoke" \
  -H "authorization: Bearer $HOME_BRIDGE_OWNER_CODE" \
  -H "content-type: application/json" -d '{"id":"<key id>"}'
```

Then update the secret in the Habitat host and restart it. Tokens are stored as SHA-256 hashes
only, so a lost token is replaced, never recovered. Leak response: revoke, mint, redeploy.

## Notes

- Phone commands are queued, not executed by Habitat. The launcher applies its own whitelist and
  reports results through `/result`; the console shows "awaiting phone result" until then.
- The WORKERS tab is derived from relay telemetry (credential presence, queue depth, reply count,
  phone polling, service health). It does not invent worker state.
- `HOME_BRIDGE_URL` defaults to the preview relay. Point it at the production relay only after that
  environment is deployed and tested.
