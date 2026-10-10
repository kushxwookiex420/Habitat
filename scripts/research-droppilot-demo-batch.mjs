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
    let attempts = 0;
    // Render cold starts and public search providers can transiently fail. Retry once,
    // including valid-but-empty searches, while preserving every attempt's evidence.
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts = attempt + 1;
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
    const videoPageCandidateCount = Number(research.videoPageCandidateCount || 0);
    const directVideoCandidateCount = Number(research.directVideoCandidateCount || 0);
    const hasSourceLeads = Boolean(response?.ok && research.ok && candidateCount > 0);
    const hasVideoPageLeads = hasSourceLeads && videoPageCandidateCount > 0;
    results.push({
      shopifyProductId: p.shopifyProductId || null,
      title,
      productUrl: p.productUrl || null,
      vendor: p.vendor || null,
      // A generic web page is not the same as a video source. Keep these states distinct
      // so downstream automation cannot mistake search matches for usable demo footage.
      status: hasVideoPageLeads ? "video_page_leads_found" : hasSourceLeads ? "web_leads_only" : "research_failed",
      candidateCount,
      videoPageCandidateCount,
      directVideoCandidateCount,
      httpStatus: response?.status || null,
      requestError: lastRequestError,
      attempts,
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
  // Keep researchedCount as a backward-compatible count of products with any source leads.
  researchedCount: results.filter(x => x.candidateCount > 0).length,
  sourceLeadProductCount: results.filter(x => x.candidateCount > 0).length,
  videoPageLeadProductCount: results.filter(x => x.status === "video_page_leads_found").length,
  webLeadOnlyProductCount: results.filter(x => x.status === "web_leads_only").length,
  failedCount: results.filter(x => x.status === "research_failed").length,
  totalCandidateCount: results.reduce((sum, x) => sum + Number(x.candidateCount || 0), 0),
  totalVideoPageCandidateCount: results.reduce((sum, x) => sum + Number(x.videoPageCandidateCount || 0), 0),
  totalDirectVideoCandidateCount: results.reduce((sum, x) => sum + Number(x.directVideoCandidateCount || 0), 0),
  policy: "Search results are leads, not proof of actual video availability or reuse rights. Video-page leads require manual verification. No media is downloaded, rendered, or published by this research job. Recheck stock and price before scheduling; require confirmed commercial rights, QA, and human approval.",
  products: results
};
await fs.mkdir("dist", { recursive: true });
await fs.writeFile("dist/droppilot-demo-research-batch.json", JSON.stringify(report, null, 2) + "\n");
if (!report.researchedCount) process.exitCode = 1;
