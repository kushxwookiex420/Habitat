# Revenue pipeline

Rule for this document: a product is ranked by **evidence that the capability already exists in this
repository**, not by how much money it might make. Verified revenue is currently **zero** — there are
no customers, no payouts and no settlements. Any figure labelled "unknown" is genuinely unknown, and
no cost below has been quoted by a provider.

Costs: `0` means no new paid service. "Credits" means image/video/model calls whose price depends on
the provider and the volume, so it is not stated as a number here.

## Ranked

| # | Product | Evidence in the repo | Missing to earn | Cost | Risk |
| --- | --- | --- | --- | --- | --- |
| 1 | **DropPilot product videos** — short product videos from a catalog, for organic posting | `product-demo-renderer.mjs`, `product-image-video.mjs`, `overlay-text.mjs`, `promotion-engine.mjs`, `content-engine.mjs`, `tiktok-publisher.mjs`, `d1-content-job-repository.mjs`, `scripts/rank-droppilot-products.mjs`, `scripts/render-droppilot-product-picture-videos.mjs` | A publishing credential and a merchant/affiliate relationship; a refreshed product catalog | Credits for image/video generation | Platform terms and account standing; posting without an approval gate is prohibited by the current policy |
| 2 | **Digital product storefront** (templates, guides, presets) | `public-pages.mjs`, `shopify-oauth.mjs`, `d1-content-job-repository.mjs` | A store or payment account, a product to sell, and a delivery path | Payment processor fees only | Low technical risk; revenue depends entirely on demand, which is unproven |
| 3 | **Habitat as a paid tool** (owner-operated agent console) | `control-center.mjs`, `ax-*.mjs`, `command-routes.mjs`, the whole runtime | Billing, multi-tenant isolation, support — none of which exist | Hosting (see `docs/RENDER_STAGING_PLAN.md`) | Multi-tenant isolation is a security project, not a feature; not viable soon |
| 4 | **Ad-supported mobile utility or casual game** | No game code in the repository; the Android app is a bridge client | An entire product, an ad SDK, store accounts, retention | High (weeks of work plus store fees) | Highest risk of the four; no evidence of demand |

## Why #1 is first

It is the only candidate where the pipeline is already written and testable end to end offline: the
catalog can be ranked, a product image can be turned into a video, text can be overlaid, and the
result can be inspected without publishing anything. The remaining work is credentialing and
distribution, not construction.

## First local render, measured (2026-11-24)

Run against a local server on 127.0.0.1, from `data/droppilot-active-product-video-manifest.json`,
with no publishing:

| Field | Value |
| --- | --- |
| File | `droppilot-car-seat-gap-organizer.mp4` |
| Bytes | 858,276 |
| Duration | 12.000 s |
| Picture | 1080×1920 H.264, 360 frames |
| SHA-256 | `54bd7ac39895d9711b4bf1a707afba47eb11c9bca4b06929beadc0316ca1bc12` |
| Visual QA | `VISUAL_PASS` (file, container, streamSync, audioTrack, safeArea, blackFrames, freeze, sceneProgression) |
| Published | **no** — `publishStatus: not_published`, and no publish path was called |

Two defects were found and fixed to get there, both of which would have blocked production:

1. `ffmpeg-static`'s binary had never been downloaded and `ffprobe-static` was absent, so the renderer
   answered 503 while `/product-image-video/status` still reported some checks as fine.
2. The available ffmpeg build has **no `drawtext`** (no libfreetype). The readiness check trusted
   `ffmpeg -version`, so it reported ready and then failed at render time with a 502. It now probes the
   filter list and falls back to libass subtitles (`subtitles=`), reporting `textOverlayMethod`.
   A third fix: `visual-qa.mjs` failed a deliberately silent video with `stream_duration_mismatch`
   (12s video vs 0s audio) although `requireAudio: false`; a missing audio track is now handled by the
   audio-track check, not the sync check.

The catalog-title blocker is now fixed at the source: `estimateTextWidth` split on a literal backslash
instead of a newline, so a wrapped three-line title was measured as one 52-character line (1597 px
against 924 px max). With the split corrected, the real catalog item renders and verifies:

| Field | Value |
| --- | --- |
| Product | Universal Car Seat Gap Organizer with Storage Pocket |
| Bytes | 892,530 |
| Duration | 12.000 s |
| Picture | 1080×1920 H.264, 360 frames |
| SHA-256 | `e3891bc0f0e9974600b83fd39c173a0cab5898199135966e081e325fd9ff3ebf` |
| Pipeline result | `Product-picture videos verified: 1/1` |
| Published | **no** |

No QA threshold was weakened: the estimate is still a conservative overestimate per line.

## Next concrete step (no spend, no publishing)

Run the renderer against a single catalog entry in a scratch directory, produce one video file, and
record its path, duration and byte size as evidence. That proves the productive step works before any
account is connected. Publishing stays behind the approval gate and is **not** part of this step.

## Guardrails that stay on

- No autonomous publishing, purchase, or customer transaction without an owner approval record.
- No ad spend. No paid plan without explicit owner approval.
- No revenue, customer or profit figure is written into the financial ledger until a settlement
  document exists; the ledger module already rejects anything unevidenced.
