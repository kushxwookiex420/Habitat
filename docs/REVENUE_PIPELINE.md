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

## Next concrete step (no spend, no publishing)

Run the renderer against a single catalog entry in a scratch directory, produce one video file, and
record its path, duration and byte size as evidence. That proves the productive step works before any
account is connected. Publishing stays behind the approval gate and is **not** part of this step.

## Guardrails that stay on

- No autonomous publishing, purchase, or customer transaction without an owner approval record.
- No ad spend. No paid plan without explicit owner approval.
- No revenue, customer or profit figure is written into the financial ledger until a settlement
  document exists; the ledger module already rejects anything unevidenced.
