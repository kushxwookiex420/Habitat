# DropPilot Catalog-Wide Product Video Rollout

**Owner:** Habitat / Ax  
**Scope:** Every active product in the connected Shopify catalog  
**Catalog snapshot checked:** 2026-10-10 UTC  
**Observed active product count:** 183 (50 + 50 + 50 + 33 from Shopify search pagination; recheck before execution)

## Current implementation facts

- `.github/workflows/dropilot-product-video.yml` is a manually triggerable GitHub Actions workflow that renders one HOTO first-look video and uploads an artifact for review.
- `scripts/render-dropilot-product-video.sh` currently builds a narrated vertical video from a product image. It is an informational first-look, **not** real product-in-use footage.
- `product-demo-renderer.mjs` is the separate product-demo path. It accepts direct HTTPS video media only, requires `permissionConfirmed: true`, requires labeled product actions, and requires at least two distinct product-action types. It includes visual QA and keeps final publishing approval-gated.
- Public video pages (including YouTube pages) are not direct media files, and visibility alone is not permission to download or republish them.
- Existing Metricool image-based scheduled posts must not be relabeled as demo videos.

## Required rollout design

### 1. Build a live catalog manifest
For each active Shopify product, capture Shopify product ID, title, canonical URL, supplier, variant/SKU identifiers, current price and inventory snapshot time, category/use case, eligibility, media rights/source attribution, content-job ID, script version, render artifact, QA report, approval status, and post ID. Use product IDs as stable keys and re-fetch price/inventory before scheduling.

### 2. Batch and resume
- Process no more than 10 products per worker batch.
- Persist progress to durable storage before acknowledging work.
- Make retries idempotent so repeated jobs do not duplicate campaign posts.
- Continue when one product is blocked, retaining the reason.
- Track statuses: not started, sourcing, rights pending, script ready, assets ready, rendering, QA failed, QA passed, approved, scheduled, published, and blocked.

### 3. Source and rights policy
Priority order: (1) merchant/supplier media explicitly licensed for the intended social/commercial use; (2) manufacturer media with written permission covering editing and intended channels; (3) original merchant-filmed or commissioned footage with written rights; (4) an original explainer using properly licensed assets, clearly disclosing illustrative visuals. Never present illustrative motion as proof the real product was tested.

Record source owner, URL, retrieval timestamp, permitted platforms, commercial/paid usage, editing rights, attribution, expiry/revocation terms, and proof of permission. A public URL, watermark-free file, or supplier listing is not sufficient by itself.

### 4. Product-specific creative
Each video should answer a real buyer question and show a product-specific use case. Avoid generic copy. Check claims against the live listing and supplier evidence. Do not invent results, testimonials, safety claims, shipping promises, or before/after comparisons.

### 5. Mandatory quality gate
- Confirm video exists, decodes, and has valid portrait dimensions.
- Verify product visibility and meaningfully distinct action shots.
- Check scene changes, black/frozen frames, and repeated frames.
- Check OCR text/captions stay inside safe margins and do not cover the product.
- Check narration/caption timing; final sentence must finish before the video ends.
- Check audio clipping/level and intelligibility where tooling permits.
- Produce a preview/contact sheet and machine-readable pass/fail report.
- Permit one automatic repair attempt; otherwise block for review.
- Human approval remains required before external publishing.

### 6. Prioritization
Score products by stock confidence and supplier reliability, demonstration potential, expected contribution margin after product cost/shipping/platform fees/creator commission/returns allowance, factual simplicity, differentiation from queued products, and authorized footage availability. Zero-stock products are blocked; low-stock or questionable inventory is rechecked. Supplier inventory counts do not prove guaranteed fulfillment.

### 7. First pilot and expansion
Start with HOTO AutoCare Air Duster & Vacuum only after rights and direct-media requirements are satisfied. Then process the full catalog in resumable batches. If authorized in-use footage is unavailable, mark rights-pending or use the clearly labeled illustrative-explainer fallback; do not call it a real demonstration.

### 8. Honest lifecycle states
A queued job is not rendered. A rendered file is not necessarily QA-passed. QA-passed is not human-approved. Scheduled is not published. Published is not sold.

## Acceptance criteria
- All 183 products in the current snapshot have a durable job or documented blocked reason.
- Every active product is rechecked against live inventory and price before scheduling.
- Each video has product-specific copy and recorded media rights.
- No unauthorized media or unverified product-use claims.
- Every scheduled video has a QA report and human approval record.
- Duplicate posts are prevented and processing resumes safely after restarts.
