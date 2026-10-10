import fs from "node:fs/promises";

const manifest = JSON.parse(await fs.readFile("data/droppilot-active-product-video-manifest.json", "utf8"));
const products = Array.isArray(manifest) ? manifest : manifest.products;
if (!Array.isArray(products)) throw new Error("Catalog manifest has no products array.");
const batchIndex = Math.max(0, Number.parseInt(process.env.BATCH_INDEX || "0", 10) || 0);
const start = batchIndex * 10;
const batch = products.slice(start, start + 10);
if (!batch.length) throw new Error("Selected batch is empty.");
const base = String(process.env.HABITAT_BASE_URL || "https://habitat-1-szzd.onrender.com").replace(/\/+$/, "");
const results = [];

for (const p of batch) {
  const title = String(p.title || "").trim();
  if (!title) continue;
  try {
    const requestBody = JSON.stringify({
      productName: title.slice(0, 180),
      brand: String(p.vendor || "").slice(0, 100),
      category: String(p.productType || ""),
      supplierUrl: String(p.supplierUrl || "")
    });
    let response;
    let research = {};
    let lastRequestError = null;
    // Render cold starts and public search providers can transiently fail. Retry once,
    // including valid-but-empty searches, while preserving every attempt's evidence.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(base + "/product-demo/research", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
          signal: AbortSignal.timeout(45000)
        });
        research = await response.json().catch(() => ({}));
        lastRequestError = null;
      } catch (error) {
        lastRequestError = String(error?.message || error).slice(0, 240);
        research = { ok: false, error: "Research request failed", details: lastRequestError };
      }
      const hasCandidates = Number(research.candidateCount || 0) > 0;
      const retryableStatus = !response || [429, 500, 502, 503, 504].includes(response.status);
      if ((response?.ok && research.ok && hasCandidates) || (attempt === 1) || (!retryableStatus && !response?.ok)) break;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
    const candidateCount = Number(research.candidateCount || 0);
    results.push({
      shopifyProductId: p.shopifyProductId || null,
      title,
      productUrl: p.productUrl || null,
      vendor: p.vendor || null,
      status: response?.ok && research.ok && candidateCount > 0 ? "researched" : "research_failed",
      httpStatus: response?.status || null,
      requestError: lastRequestError,
      attempts: 2,
      research,
      researchFailureReason: candidateCount === 0 ? "no candidate sources parsed after retry" : null,
      videoWorkflowStatus: "not_rendered",
      rightsStatus: "unverified",
      qaStatus: "not_run",
      publishStatus: "not_approved"
    });
  } catch (e) {
    results.push({
      shopifyProductId: p.shopifyProductId || null,
      title,
      productUrl: p.productUrl || null,
      vendor: p.vendor || null,
      status: "research_failed",
      error: String(e?.message || e).slice(0, 240),
      videoWorkflowStatus: "not_rendered",
      rightsStatus: "unverified",
      qaStatus: "not_run",
      publishStatus: "not_approved"
    });
  }
  console.log(results.length + "/" + batch.length + " " + title.slice(0, 80) + " " + results.at(-1).status);
}

const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  store: manifest.store || "DropPilot",
  storeUrl: manifest.storeUrl || null,
  catalogSnapshotDate: manifest.generatedAt || null,
  batchIndex,
  catalogProductCount: products.length,
  startIndex: start,
  endIndexExclusive: start + batch.length,
  researchedCount: results.filter(x => x.status === "researched").length,
  failedCount: results.filter(x => x.status === "research_failed").length,
  policy: "Search results are leads, not proof of reuse rights. No media is downloaded, rendered, or published by this research job. Recheck stock and price before scheduling; require confirmed commercial rights, QA, and human approval.",
  products: results
};
await fs.mkdir("dist", { recursive: true });
await fs.writeFile("dist/droppilot-demo-research-batch.json", JSON.stringify(report, null, 2) + "\n");
if (!report.researchedCount) process.exitCode = 1;
