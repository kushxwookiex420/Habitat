# DropPilot product ranking

The ranker is an evidence gate, not a sales predictor. Run it from the repository root:

```sh
node scripts/rank-droppilot-products.mjs
```

Optional paths:

```sh
node scripts/rank-droppilot-products.mjs --manifest data/droppilot-active-product-video-manifest.json --enrichment data/droppilot-supplier-enrichment.json --out dist/droppilot-ranked-products.json
```

It writes a JSON review report to `dist/droppilot-ranked-products.json`. The default enrichment file is intentionally not fabricated; until verified inputs are supplied, products remain `HOLD_FOR_EVIDENCE`.

## Required evidence per Shopify product

Create `data/droppilot-supplier-enrichment.json` locally or through an authorized data workflow with a `products` array. Each record is keyed by the exact `shopifyProductId` from the manifest and includes:

- `supplierCost`, `shippingCost`, `otherPerOrderCosts`: current quoted costs in the store currency
- `platformFeeRate`, `paymentFeeRate`: decimal rates (for example, 0.08 means 8%); verify current channel-specific fees
- `demandScore`, `demoScore`, `supplierReliabilityScore`: evidence-backed scores from 0 to 100, not guesses
- `evidenceUrl`, `evidenceCheckedAt`: source and timestamp for the research

Use Amazon as a demand/competition signal only through permitted sources and methods. An Amazon retail listing price is **not** a supplier quote, proof of demand, proof of rights to its images/video, or permission to fulfill a TikTok Shop order from Amazon. Prefer authorized suppliers with documented stock, shipping SLAs, returns handling, and rights to media. Recheck the live Shopify price and supplier quote before acting.

## Decision meanings

- `HOLD_FOR_EVIDENCE`: required cost or evidence missing
- `HOLD_STOCK_CHECK`: no available inventory in the snapshot; recheck supplier stock
- `REJECT_LOW_MARGIN`: estimated profit is non-positive or estimated margin is below 20%
- `REVIEW_FOR_LISTING`: passes this basic gate only; it is not approved to publish

Estimated profit excludes any cost not entered, including possible refunds, chargebacks, taxes, discounts, and platform-specific adjustments. Treat every result as a shortlist for human review, never a guarantee.
