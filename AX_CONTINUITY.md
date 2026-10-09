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


## Verified update — 2026-10-09 18:16 UTC

- Latest merged task dispatch guard: commit `24194147f58e9637548c3bd4534e6572673f5020`, PR [#17](https://github.com/kushxwookiex420/Habitat/pull/17). It blocks duplicate dispatch attempts within one running process.
- Latest durable task route integration: commit `b7eaec32e51a4bef78269a0bdcd8f3ceb37044a5`, PR [#18](https://github.com/kushxwookiex420/Habitat/pull/18). All three PR checks passed: CI, release checks, and D1 repository tests.
- Render deployment for `b7eaec32e51a4bef78269a0bdcd8f3ceb37044a5` is confirmed live. Startup logs confirm the backend started and OpenRouter accepted its runtime key.
- Render startup logs explicitly report `TASK_STORAGE: memory-only — D1 credentials are not configured`. Therefore **durable runtime storage is not active yet**. A Workers AI token does not substitute for `HABITAT_D1_API_TOKEN`; the account ID, D1 database ID, and correctly permissioned token are all required.
- Production task routes now use D1 when configured, await writes, restore up to 500 recent records before listening, and mark persisted `delegated`/`running` tasks as `interrupted` rather than automatically rerunning them. `POST /tasks/:id/retry` permits an explicit retry for `failed`/`interrupted` tasks while retaining bounded attempt history. This is not a distributed atomic lock.
- `/capabilities`, `/storage/check`, and `/system-check` now distinguish a ready D1 repository from the in-memory fallback. Content pipeline jobs, TikTok OAuth state, and TikTok tokens remain separate in-memory stores; the status report explicitly discloses this gap.
- Direct HTTP inspection of the live `/capabilities` and `/storage/check` endpoints was not available through the current inspection tools. Do not claim those responses were live-tested; deployment and startup were verified from Render.
- Next actions: (1) activate D1 only after a D1 database ID and scoped D1 API token are available; (2) persist content jobs and OAuth state/tokens securely; (3) run the manual Artifact 001 workflow and inspect actual video/audio output and QA report; (4) continue TikTok authorization troubleshooting without claiming connected/publishing until verified; (5) inspect the APK build/artifact for the latest backend release if one is produced.



## Verified update — 2026-10-09 19:21 UTC

- User configured `CLOUDFLARE_ACCOUNT_ID`, `HABITAT_D1_DATABASE_ID`, and `HABITAT_D1_API_TOKEN` in Render. Never copy the token into chat or source control.
- PR [#19](https://github.com/kushxwookiex420/Habitat/pull/19) was merged as commit `4811857fdf39df5f2835f310e7399ec2075e959f`. CI, release checks, and D1 repository tests passed for the final PR head `365877f076604f085087dfb916531698e7d139b2`.
- Render deployment `dep-db4jsqeq1p3s73fe7l9g` for the merge commit is `live`. Startup logs confirm both `TASK_STORAGE: D1 ready; restored 0 task records` and `CONTENT_JOB_STORAGE: D1 ready; restored 0 jobs`. OpenRouter runtime auth check passed.
- Content jobs now have a D1 repository, startup restoration (up to 500 jobs), awaited persistence before JSON responses, and running stages are marked interrupted on restart instead of being silently rerun.
- When a persisted verified artifact references a missing Render `/tmp` file, the job is downgraded to interrupted and the artifact is marked `missing_after_restart`/unverified. D1 preserves job metadata, not MP4 bytes.
- D1 repository unit tests and production startup/schema initialization are verified. A direct HTTP POST/GET content-job round trip and process-restart round trip have **not** yet been externally exercised through the available inspection tools; do not overstate end-to-end verification.
- Remaining gaps: TikTok OAuth state/access/refresh tokens still live in process memory; OAuth authorization still needs to be fixed and verified; rendered video files are still on ephemeral disk; TikTok publishing remains approval-gated. Do not claim publishing or video artifact durability works until tested.
- Next priority: design encrypted persistence for TikTok OAuth state/tokens using a dedicated encryption key in Render, with expiry/refresh handling and tests. Then evaluate free durable binary storage for rendered MP4s; never put secrets or large media bytes in the public continuity file.


## Verified update — 2026-10-09 19:34 UTC

- Cloudflare D1 is configured in Render. Live startup logs confirm task storage and content-job storage both initialize as D1 ready.
- PR #20 merged as `6ef7fedc7913f24fbe8d6f2bd574c8950986b770`; capability reporting now reflects D1 content-job readiness instead of falsely saying memory-only.
- PR #21 merged as `d8284f5becbdd5f67a5aa2d2f9aea926a449eadf`. New `d1-secret-vault.mjs` stores OAuth state and TikTok token bundles encrypted using AES-256-GCM in D1. Render environment variable `HABITAT_TOKEN_ENCRYPTION_KEY` is set directly in Render; never print or commit its value.
- Render startup log confirms `TIKTOK_TOKEN_VAULT: D1 AES-256-GCM ready; token values are not logged`, followed by content-job D1 ready and OpenRouter auth PASS.
- PR #22 merged as `f3479e8a939d4fa8d0658ef3985c52030c93070f`; `/storage/check` now checks task repository, content-job repository, and encrypted vault together and reports component readiness without revealing secrets. Deployment was in progress at checkpoint; verify it is live before claiming the combined endpoint is deployed.
- CI, release checks, and D1 repository tests passed for PR #21. PR #22 release checks and CI passed before merge.
- TikTok OAuth still has not been proven successful; the developer portal previously returned a client_key error. The new vault is ready but no valid TikTok token is yet confirmed. Token refresh logic is still a follow-up, and external publishing remains approval-gated.
- Render video bytes still reside on ephemeral disk; durable MP4 storage (e.g. object storage) is a separate unresolved item.
- Next actions: verify PR #22 deployment and combined `/storage/check`; test content-job create/get persistence; implement token refresh using the encrypted vault; then fix TikTok Developer app authorization and verify a real OAuth round trip without publishing.


## Verified update — 2026-10-09 20:26 UTC — Vice City Files video reliability push

- User requested a major reliability milestone for Habitat's Vice City Files video pipeline. Do not claim the video generator is fully fixed until a real output is rendered and reviewed.
- Inspected `scripts/render-artifact-001.sh` and `.github/workflows/artifact_001.yml`. The renderer hard-codes a 45-second timeline and currently does not preserve the user's original approved intro or implement a dedicated branded outro. Basic MP4 metadata and scene checks were insufficient to catch this.
- Existing production standard: `docs/VICE_CITY_FILES_VIDEO_QA.md` requires original intro preservation (first 7 seconds), episode narration beginning at 00:08, a branded outro of at least 2 seconds, complete narration, no fixed-duration truncation, safe-area checks, a contact sheet, and explicit human approval before publishing.
- Added `scripts/vice-city-release-gate.mjs` (commit `3e53a1b801e62e0998237dec4ce6428ebdece8aa`). The gate fails closed if the final video, original intro, or branded outro is missing/invalid; it also requires an explicit edit manifest proving the original intro is first, narration starts no earlier than 8 seconds, narration is complete, a branded outro is last, and fixed-duration trimming is disabled. It never authorizes publishing.
- Added `tests/vice-city-release-gate.test.mjs` (commit `f8c3686dabcbddf0ec73e881147357b2e92e6704`) to test missing-media fail-closed behavior and the timeline contract. Added the release gate to package source checks in commit `20a70cba485be913571f80dd9fd09095025a1386`.
- Added `.github/workflows/vice-city-channel-audit.yml` (commit `cf4599e639f487b1fad119347b1d0e44b2bff0fb`) to download up to eight recent public YouTube channel videos, make opening/ending contact sheets, and upload an inspection artifact. The run was started as GitHub Actions run [37986777095](https://github.com/kushxwookiex420/Habitat/actions/runs/37986777095); inspect completion and its artifact before claiming channel videos were compared.
- Updated `.github/workflows/release-checks.yml` in commit `ec7c96f81569998ea9d8692bfd4e84e897b0dc47` to parse the release gate and prove it blocks missing intro/outro media. Verify CI results before claiming tests passed for this newest commit.
- Critical unresolved dependency: the original approved intro and approved outro are not present in the inspected repository. Do not silently recreate them. Channel audit may identify the repeated intro/outro visually, but only an inspected source video/asset can establish the canonical version. The actual renderer has not yet been updated to assemble these segments, and the new release gate has not yet been integrated into the Artifact 001 workflow. Thus the actual video fix is not complete.
- TikTok access remains blocked/unverified; no publishing is authorized. Keep the user-facing status honest and focus next on the audit artifact, extracting/validating the repeated intro/outro from their own public videos, implementing dynamic narration-duration assembly plus the segments, then running the release gate and inspecting actual video/contact sheets.


## Corrected status — 2026-10-09 20:28 UTC — Artifact 001 release gate integration

- Artifact 001 workflow now invokes `scripts/vice-city-release-gate.mjs` and uploads `vice-city-release-gate-report.json` alongside the MP4 and visual QA report. Changes: `06f96a207d1d9b2404e6794c0e3ad0a5ccf0bb32`, shell variable expansion correction `a778c0af9a2a80442de246af219fcf589dd4bb60`.
- GitHub CI, build tests, and release checks passed for commit `a778c0af9a2a80442de246af219fcf589dd4bb60`; see [release checks run 81](https://github.com/kushxwookiex420/Habitat/actions/runs/37987133339).
- Artifact 001 execution runs [58](https://github.com/kushxwookiex420/Habitat/actions/runs/37987116202) and [59](https://github.com/kushxwookiex420/Habitat/actions/runs/37987133423) were triggered by workflow changes. Check their final status. With no approved intro/outro assets or edit manifest in the repo, the new release gate is expected to mark the video BLOCKED; this is intended to prevent another false “ready” claim.
- Public-channel audit successfully enumerated eight video IDs, but YouTube rejected direct video downloads with “Sign in to confirm you’re not a bot.” The audit artifact therefore contains no video frames and **does not constitute an intro/outro comparison**. Do not claim the channel was visually compared. A newer audit workflow run uses the corrected explicit enumeration/download flow; inspect its outcome.
- The user's Library has several storyboard/concept images describing the Vice City Files intro (neon car/chase, money, TOP SECRET folder, like/comment/subscribe paper, and VICE CITY FILES neon title reveal), but these are image storyboards, not the approved original video asset. They may inform styling only; do not silently substitute them for the canonical intro.
- Next blocker is sourcing the actual approved intro/outro from a downloadable original channel video or original media asset. Do not ask the user to recreate the whole project; if all public retrieval paths remain blocked, ask only for the original intro clip as the smallest required input. Once source assets are available, assemble dynamically around actual narration duration, add the branded outro, generate contact sheets, and verify full ending playback. Publishing remains approval-gated.


## Verified update — 2026-10-09 20:42 UTC — Original intro recovered; dynamic timeline and review preview assembled

- Located the user's saved intro MP4s in ChatGPT Library (not the repository). Compared sampled frames/durations of several variants. The strongest match to the user's explicit "TOP SECRET folder + floating paper + LIKE / COMMENT / SUBSCRIBE + VICE CITY FILES logo" description is `Vice_City_Files_Intro_Vice_Style_CTA_Playable.mp4` (5.3 seconds, 1920x1080). It is now the selected source for the review preview. Do not trim or redesign it.
- Created local review preview at `/mnt/data/vice-city-files-release-preview/Vice_City_Files_Artifact_001_Review_Preview.mp4`: verified 55.821333 seconds, H.264/AAC, 1080x1920, 30 fps. Timeline: full source intro + branded final-frame hold to 7s; narration begins at 8s; one-second tail after body audio; 2-second CTA/logo ending derived from the final part of the source intro. This is a review preview, not public-ready. Human listening review is still required.
- Preview QA metadata: `/mnt/data/vice-city-files-release-preview/preview-qa-report.json`; contact sheet: `/mnt/data/vice-city-files-release-preview/contact-sheet-final.jpg`.
- Created a portable asset bundle at `/mnt/data/vice-city-files-assets.zip` containing `vice-city-files-intro.mp4`, `vice-city-files-outro.mp4`, and a README. This is the one remaining file-placement blocker: GitHub Actions cannot read the user's private ChatGPT Library directly. Upload the ZIP to the repository as `assets/vice-city-files-assets.zip`; the Artifact 001 workflow now extracts it automatically. Do not claim the remote pipeline has the original assets until this ZIP exists in the repo.
- Updated `scripts/render-artifact-001.sh` (commit `12e0796b208c451741e9d14407ccdbdedd56f6c1`) to derive scene duration from actual neural TTS audio, remove fixed 45-second trims, and add a one-second tail.
- Added `scripts/assemble-vice-city-files.sh` (commit `3844f303411f17836331428359c576e9accb22b0`, refined at `ec7b667ef140f422c3edced664f78531489586ba` and `7e0769f935fb065f74783ca1d9188a32a62b6c82`) to preserve the entire source intro, extend the final brand frame to a 7-second intro timeline, delay narration until 8 seconds, add a one-second tail, fit the original 16:9 brand segments into portrait without cropping, preserve source audio when present, and concatenate the final branded outro. It writes an edit manifest.
- Updated `scripts/vice-city-release-gate.mjs` to accept the full original intro source duration and require the timeline manifest to prove intro timeline >=7s, narration starts >=8s, a complete narration flag, and >=2s branded outro. The gate never authorizes public posting.
- Updated `.github/workflows/artifact_001.yml` to render a body draft, unpack `assets/vice-city-files-assets.zip` if present, assemble the original intro/body/outro, run visual QA and release gate, and upload the reports. If the bundle is absent, assembly intentionally fails closed.
- Updated `docs/VICE_CITY_FILES_VIDEO_QA.md`, `tests/vice-city-assembler.test.mjs`, `tests/release-contract.test.mjs`, package checks, and release CI. Release checks and Habitat CI passed at commit `7e0769f935fb065f74783ca1d9188a32a62b6c82`; see [release checks run 101](https://github.com/kushxwookiex420/Habitat/actions/runs/37988785012).
- Latest Artifact 001 run is [run 67](https://github.com/kushxwookiex420/Habitat/actions/runs/37988784979). Check its completion. Because the asset ZIP is not yet in the repository, the assembly step will block until it is added; this is intentional, to avoid delivering another render without the intro/outro.
- The public YouTube audit was blocked by YouTube bot verification and did not produce video frames. The saved intro asset is recovered, but the exact published-channel outro is not independently verified. The two-second outro in the preview is derived from the saved intro's final CTA/logo reveal; tell the user that distinction clearly.


## Latest correction — 2026-10-09 20:45 UTC — Audio/video duration mismatch regression

- The new dynamic renderer exposed an important hidden defect: MP4 metadata could report a longer audio stream than video even though the container-level duration looked valid. The latest generated body draft had audio 51.88s and video 51.40s, a 0.48s mismatch. Do not call that render ready.
- Increased visual end padding before trimming to the measured narration-plus-tail duration in `scripts/render-artifact-001.sh` (commit `1be50a0f44289471ac55ee3d8e9a0d296b641a1d`).
- Added a deterministic `streamSync` check to `visual-qa.mjs`: fail if video/audio stream durations differ by more than 0.12 seconds, especially when audio exceeds video (commit `23e5b494430e9f47c8856c1b9f78a02774e8106d`). Added contract tests in commit `72bf936aab273817b2b064602ebd831a785b5979`. Release checks passed at run [106](https://github.com/kushxwookiex420/Habitat/actions/runs/37989131823).
- Artifact workflow was updated to rerun when visual QA changes; latest run [70](https://github.com/kushxwookiex420/Habitat/actions/runs/37989144979) is queued. It still cannot complete assembly until `assets/vice-city-files-assets.zip` is committed to the repo. The user has been given the ZIP download and a review-preview MP4 link; the upload page is `https://github.com/kushxwookiex420/Habitat/upload/main/assets`.

## Current in-progress milestone — 2026-10-09

- Active branch: `fix/product-demo-action-footage-gate`; pull request #27: https://github.com/kushxwookiex420/Habitat/pull/27.
- Product-demo renderer changes require explicit commercial reuse permission and action categories (`vacuuming`, `blowing`, `attachments-in-use`), with at least two distinct categories per render. These are caller-supplied labels, **not computer-vision proof** that the footage actually depicts the action.
- Render responses preserve source metadata, mark action review as pending human review, and keep public publishing approval-gated.
- Added `.github/workflows/product-demo-ci.yml` to run backend syntax checks and regression tests on relevant pull requests and on this work branch. Added regression cases for missing action labels, repeated action types, missing reuse permission, missing product name, too-short narration, and clip-count limits.
- The latest observed workflow runs for commit `17d3b0e4c9e0f75f0504dafa474cc33aba0b8bf1` were queued/in progress; do not mark CI as passed until the workflow reports success.
- **Not yet completed:** merge, Render deployment/live verification, authorized direct video URLs for the actual HOTO AutoCare Air Duster & Vacuum, a newly rendered MP4, and human visual inspection. The official HOTO demo is a discovery lead, not permission to reuse commercial footage.
- Next steps: inspect CI outcomes; fix any failures; merge only after checks pass; identify footage with explicit commercial reuse rights; render and inspect the final sales video; then request the user's approval before posting.
