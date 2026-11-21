# Habitat AI Media Engine — researched implementation handoff

Status: research and architecture handoff; no provider credentials added, no paid resources enabled, and no production deployment performed.

Branch: `ax/media-engine-foundation`

## Existing Habitat capabilities verified from main

- `server.mjs` already implements text-provider fallback, including Gemini through the Gemini Developer API REST endpoint. Do not add a second Gemini chat path merely to make existing chat work.
- `package.json` currently includes Express, OpenAI, ffmpeg-static, ffprobe-static, DejaVu fonts, and Sharp. It does not include `@google/genai` or `@huggingface/inference`.
- `product-image-video.mjs` creates a product showcase MP4 from an existing catalog image; it is not generative image creation.
- `product-demo-renderer.mjs` composes permission-confirmed source clips; it is not a generative video model.
- `content-engine.mjs` and `d1-content-job-repository.mjs` already provide a content-job pattern and D1 persistence. Reuse and extend these rather than creating a parallel queue.
- Current media renderers explicitly report temporary instance storage. A new media generation service must not claim durable output until an object-storage write and read-back are verified.

## Chosen architecture

### 1. Gemini image generation adapter
Use Google's official Gemini Developer API, with model IDs selected from current documented model capabilities and configured server-side. The official JavaScript SDK is `@google/genai`; use it only if it materially simplifies the image API integration. The current Habitat text-chat implementation uses REST already, so adding the SDK is optional, not a prerequisite.

Credential: `GEMINI_API_KEY` (existing server-side variable). Never expose it to Android, browser code, logs, or committed files.

### 2. Hugging Face Inference adapter
Use the official `@huggingface/inference` JavaScript SDK for text-to-image and image-to-image where the chosen model/provider supports the task.

Credential: `HF_TOKEN`, server-side only, with the minimum Inference Providers permission. Provider selection must be explicit/configurable; automatic provider selection is not proof of zero cost.

### 3. OpenAI image adapter
The `openai` package is already present. Add image generation only as an optional provider after its model, API availability, pricing, and configured spending limit have been verified. Do not assume ChatGPT subscription image limits equal API limits.

Credential: `OPENAI_API_KEY` (only if configured by owner).

### 4. ComfyUI adapter (optional later)
ComfyUI is a separate image/video workflow engine, not an npm package to embed in the Habitat API. Integrate through its documented HTTP/WebSocket API only when a remote ComfyUI server or approved hosted endpoint exists. Do not install large diffusion models on the Render Free web service or the Android phone. Comfy Cloud API requires a paid subscription; keep disabled by default.

## Provider policy

- Default spend ceiling: USD $0 until owner explicitly configures a budget.
- Skip providers without credentials or with disabled billing authorization.
- Do not rotate accounts, evade quotas, or repeatedly retry quota exhaustion.
- Retry transient network/5xx failures with bounded exponential backoff and idempotency keys.
- Do not treat HTTP 200 as completion until the image bytes are validated, persisted, and read back.
- Store provider/model, job ID, prompt, timestamps, byte size, MIME type, checksum, estimated/actual cost (when available), and errors.
- Expose provider readiness separately from provider entitlement/quota. A configured key does not prove usable quota.

## Storage and jobs

- Reuse D1 content-job conventions for durable lifecycle state.
- Use R2 only after confirming the account's existing R2 availability and pricing/limits; do not provision a paid resource.
- Store generated binary outputs in object storage, not in D1 or ephemeral Render disk.
- Suggested job states: queued, generating, storing, completed, failed, awaiting_approval.
- Use a stable job ID and idempotency key; enforce output size/type limits and timeouts.
- Keep prompts and metadata separate from secrets. Do not log base64 image payloads.

## Suggested implementation order

1. Add tests and provider-neutral interfaces without adding a new dependency yet.
2. Implement Gemini image adapter against the currently documented API and model catalog; verify model access with a harmless request only after key and spend authorization are confirmed.
3. Add Hugging Face adapter using `@huggingface/inference`; verify chosen model/provider pricing before any request.
4. Add optional OpenAI adapter using the already installed SDK.
5. Add R2 storage only after owner confirms the account resource is available and no paid upgrade is needed.
6. Expose authenticated media job endpoints to the paired-device dashboard; never pass provider credentials to the APK.
7. Add media studio UI and push notifications after backend job lifecycle is tested.

## Team roles (logical roles until independently running agents exist)

- AX: planner, delegation, synthesis, verification.
- NEXUS: implementation and tests.
- ORION: provider/model research and prompt preparation.
- SENTINEL: credential, budget, permissions, and output checks.
- ATLAS: queue, persistence, retries, and notifications.

Do not advertise these as separate live agents unless separate runtimes and dispatch evidence exist.

## Official source material reviewed

- Google Gen AI JavaScript SDK: https://github.com/googleapis/js-genai
- Google SDK documentation and multimodal image output: https://googleapis.github.io/js-genai/
- Gemini API coding guidance: https://github.com/googleapis/js-genai/blob/main/codegen_instructions.md
- Hugging Face JavaScript inference SDK: https://github.com/huggingface/huggingface.js/tree/main/packages/inference
- Hugging Face inference providers: https://huggingface.co/docs/inference-providers/index
- Hugging Face text-to-image: https://huggingface.co/docs/inference-providers/tasks/text-to-image
- ComfyUI: https://github.com/Comfy-Org/ComfyUI
- ComfyUI server API routes: https://github.com/Comfy-Org/docs/blob/main/development/comfyui-server/comms_routes.mdx
- ComfyUI Cloud quickstart and billing requirement: https://github.com/Comfy-Org/docs/blob/main/development/api-development/quickstart.mdx
- LangGraph.js human-in-the-loop reference (evaluate only if Habitat's existing task engine proves insufficient): https://github.com/langchain-ai/langgraphjs

## Acceptance criteria

- No API key appears in source, APK, browser JS, logs, or generated artifacts.
- Tests cover missing credentials, quota errors, transient failures, invalid image bytes, oversized output, duplicate jobs, storage failure, and successful storage read-back.
- $0 budget blocks all paid providers.
- Provider fallback never bypasses provider quotas or owner spending controls.
- A job is marked completed only after verified durable storage.
- No production deploy or paid provider request occurs without explicit owner authorization.
