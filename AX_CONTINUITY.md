# Habitat Ax — Durable Continuity Checkpoint

**Last checkpoint:** 2026-10-09 07:57 UTC  
**Repository:** https://github.com/kushxwookiex420/Habitat  
**Live backend:** https://habitat-1-szzd.onrender.com  
**Current rule:** Never claim a feature works until the live service or produced artifact has been tested.

## Mission

Build Habitat into a dependable Android-first AI control center for DropPilot AI and Vice City Files. Ax should orchestrate work, retain evidence, recover after interruption, and require human approval before public publishing. Prefer free, no-expiration software and existing infrastructure; do not create paid services without explicit approval.

## Verified facts at this checkpoint

- Cloudflare Workers AI inference succeeded in Render logs using `@cf/meta/llama-3.2-1b-instruct`.
- Latest storage-honesty regression checks passed on commit `0e066b26ad79215c460a1f35aed2930a8927f8c9`: Build Test https://github.com/kushxwookiex420/Habitat/actions/runs/37901681372 and CI https://github.com/kushxwookiex420/Habitat/actions/runs/37901681153.
- Latest provider-awareness changes are committed as `6397fbf5d37487e01ad298dbf1ab34ea7a6404eb`; CI passed at https://github.com/kushxwookiex420/Habitat/actions/runs/37901893203, Build Test passed at https://github.com/kushxwookiex420/Habitat/actions/runs/37901893222, and release checks passed at https://github.com/kushxwookiex420/Habitat/actions/runs/37901893179. APK build for that commit was still in progress at https://github.com/kushxwookiex420/Habitat/actions/runs/37901893262 at the last check.
- The autonomous scheduler no longer launches a mission 10 seconds after each boot and clamps its configured interval to at least 60 minutes.
- The standalone Artifact 001 workflow is manual-only; ordinary commits should not trigger expensive video rendering.
- Added `GET /continuity` and `GET /continuity/status` endpoints, backed by the committed `AX_CONTINUITY.md` file; README points fresh sessions to the checkpoint.
- Added `docs/FREE_RESOURCES.md` covering Cloudflare Workers AI's published daily free allocation, GitHub Actions public-repo policy, and local-first memory candidates (Engram, Alice Memory, CSM). These are candidates/references, not installed services.
- Artifact 001 renderer was changed to fetch six official Rockstar GTA VI screenshot assets and create narration via a free TTS endpoint. This code change is committed, but actual output playback, narration naturalness, and full visual QA are **not yet verified**.
- The Android APK workflow for commit `624c78f596a49cc92dbb764ec5e8d9fc7747cccc` was still running when last checked: https://github.com/kushxwookiex420/Habitat/actions/runs/37900042669. Check its result and artifact list before offering a download.
- Current release page: https://github.com/kushxwookiex420/Habitat/releases/tag/habitat-v0.8-latest
- TikTok OAuth has previously reported `connected:false`. Do not claim publishing works; keep it approval-gated.
- The storage endpoint and system check now explicitly treat process-local memory as non-durable and block an overall VERIFIED PASS when storage is UNKNOWN.
- Worker registry availability now checks all configured AI providers, including Cloudflare Workers AI, rather than relying only on OPENROUTER_API_KEY. Added `GET /brain/status` with provider-presence diagnostics that do not expose secret values. Release/CI/build tests passed for these changes; the latest APK build and live deployment still need confirmation.
- Render deploy for the previous commit `0e066b26ad79215c460a1f35aed2930a8927f8c9` is live. The latest provider-aware deploy was queued at the last check; do not claim `/brain/status` is live until deployment completes and endpoint is checked.
- No Render Postgres or Render Key Value instances were found in the connected Render workspace at last check.

## Important known gaps

1. Content jobs and TikTok OAuth state/tokens live in process memory. Render restarts can lose them.
2. A repo checkpoint gives a new assistant session durable project context, but does not by itself make runtime job state persistent.
3. Do not write important state only to Render's ephemeral filesystem and call it durable.
4. Free quotas can change or run out. A free tier is not the same as a lifetime guarantee.
5. Do not expose credentials, tokens, or secret values in logs, checkpoints, commits, APKs, or public endpoints.
6. Do not auto-publish content. Require a verified artifact, explicit user approval, valid authorization, and an honest result from the publisher.

## Resume protocol for every new Ax / coding-agent session

1. Read this file first, then inspect the latest commit and current GitHub Actions runs.
2. Check live Render health and latest deploy/logs before making another commit.
3. Verify the current code rather than assuming this checkpoint is still current.
4. Choose one highest-value improvement and implement it; avoid several commits that restart the service while a mission is running.
5. Run the automated tests, check the deployment result, and inspect any generated artifact before claiming success.
6. Update this checkpoint with the new commit SHA, test run links/results, deployment status, what remains broken, and the next concrete action.
7. Never overwrite a failure with a success summary. Keep failures and unresolved work visible.

## Next actions, in priority order

1. **Finish latest deployment and APK verification.** Check Render deploy for commit `6397fbf5d37487e01ad298dbf1ab34ea7a6404eb`, verify `/brain/status` and `/storage/check` on the live backend, and check APK run 37901893262 plus artifact/release only if the build succeeded.
2. **Add durable runtime persistence.** No Render Postgres or Key Value instances were found in the connected workspace. Inspect options genuinely available at zero cost before selecting one. Do not provision a paid database or storage product without approval. Persist content job state, step results, retries, OAuth state, and token expiry securely.
3. **Resume/recovery API.** Make jobs discoverable after process restart, with idempotent retries and a single-worker/lease guard so multiple instances cannot duplicate work.
4. **Verify Artifact 001 end to end.** Run the manual render workflow, ensure narration exists and is intelligible, inspect scene changes/text safe areas, confirm audio/video streams and duration, and publish the artifact only as a downloadable test output.
5. **Free provider resilience.** Check the actual configured provider keys by presence only, confirm a real inference test, and keep quota/rate-limit failures visible. Never assume a free provider's quota is unlimited.
6. **TikTok OAuth persistence.** Fix the authorization flow and store refreshable tokens securely before claiming connection or publishing works.

## Free-first policy

- Open-source code with a permissive license can remain usable without a subscription, but hosting, API access, rate limits, and maintenance may change.
- Use GitHub's public repository as the durable human/agent handoff and source of truth. Avoid putting private business information or secrets into this public repository.
- Prefer local SQLite for local-only memory where appropriate; it is not shared runtime storage when the server is hosted elsewhere.
- Evaluate Cloudflare free allocations only after checking the current official limits. Do not treat them as unlimited or guaranteed forever.


## Verified update — 2026-10-09 10:30 UTC

- Latest main commit: `15bb5ced6d667f110cd9f8f7baf2fe1128645c20`.
- GitHub Actions completed successfully for that exact SHA: Habitat CI, Habitat Build Test, Habitat release checks, and Habitat APK Build.
- APK artifact `Habitat-v0.8-Ax-debug-apk` was produced by run [37902488725](https://github.com/kushxwookiex420/Habitat/actions/runs/37902488725); artifact ID `11603310544`, SHA-256 `75bba7e6c318fcfa73d8e6719a104191162da758f12194b11096ababb45236c9`, expires 2027-01-07.
- Render confirms deployment `dep-db49uv8mifls73esf7cg` for the same SHA is `live`; startup logs confirm service listening and OpenRouter runtime key accepted.
- Workspace inventory again confirms there is no configured Render Postgres or Key Value store. Durable task persistence remains unresolved; do not claim tasks survive a restart.
- Direct endpoint verification for `/brain/status` and `/storage/check` was not available through the connected inspection tools; do not claim those endpoints were live-tested.
- A small usability defect remains: the task delegation missing-provider error message omits Cloudflare Workers AI and does not explain the explicit Cerebras opt-in. Fix this with a regression test.
- Next engineering priority: implement and test a genuinely durable task repository with restart hydration, awaited writes, safe error handling, and idempotent recovery. Only activate it when real storage credentials/IDs are configured; no paid resources without approval. Add a restart integration test before marking storage PASS.
