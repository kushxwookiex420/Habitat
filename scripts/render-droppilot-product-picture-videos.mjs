import fs from "node:fs/promises";
import path from "node:path";

const manifestPath = process.env.CATALOG_MANIFEST || "data/droppilot-active-product-video-manifest.json";
const baseUrl = String(process.env.HABITAT_BASE_URL || "https://habitat-1-szzd.onrender.com").replace(/\/+$/, "");
const outputDir = process.env.VIDEO_OUTPUT_DIR || "dist/product-picture-videos";
const limit = Math.max(1, Math.min(5, Number.parseInt(process.env.VIDEO_BATCH_LIMIT || "3", 10) || 3));
const maxCatalogAgeMs = 36 * 60 * 60 * 1000;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const products = Array.isArray(manifest) ? manifest : manifest.products;
if (!Array.isArray(products)) throw new Error("Catalog manifest has no products array.");
const snapshotAt = Date.parse(manifest.generatedAt || "");
const priceSnapshotFresh = Number.isFinite(snapshotAt) && Date.now() - snapshotAt >= 0 && Date.now() - snapshotAt <= maxCatalogAgeMs;
const candidates = products.filter(product =>
  product.status === "ACTIVE" &&
  product.featuredImageUrl &&
  product.title &&
  product.productUrl
).slice(0, limit);
if (!candidates.length) throw new Error("No active catalog products have a featured image URL.");

await fs.mkdir(outputDir, { recursive: true });
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  store: manifest.store || "DropPilot",
  catalogSnapshotAt: manifest.generatedAt || null,
  priceSnapshotFresh,
  outputType: "animated catalog-image showcase",
  note: "Videos animate catalog images; they do not depict real product operation. No videos are auto-published.",
  results: []
};

async function waitForRenderer() {
  let lastError = "renderer not ready";
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const response = await fetch(baseUrl + "/product-image-video/status", { signal: AbortSignal.timeout(15000) });
      const status = await response.json().catch(() => ({}));
      if (response.ok && status.ready === true) return status;
      lastError = "renderer status HTTP " + response.status + ": " + JSON.stringify(status).slice(0, 200);
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 200);
    }
    console.log("Renderer readiness attempt " + attempt + "/12: " + lastError);
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  throw new Error("Product-picture renderer never became ready: " + lastError);
}

await waitForRenderer();

for (const [index, product] of candidates.entries()) {
  const result = {
    shopifyProductId: product.shopifyProductId || null,
    title: product.title,
    productUrl: product.productUrl,
    status: "render_failed",
    priceIncluded: false,
    publishStatus: "not_published"
  };
  try {
    const body = {
      productName: product.title,
      imageUrl: product.featuredImageUrl,
      callToAction: "Explore it at DropPilot"
    };
    const low = Number(product.minVariantPrice);
    const high = Number(product.maxVariantPrice);
    if (priceSnapshotFresh && product.currency === "USD" && Number.isFinite(low) && low > 0 && low === high) {
      body.price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(low);
      body.priceVerified = true;
      result.priceIncluded = true;
      result.price = body.price;
    }
    const response = await fetch(baseUrl + "/product-image-video/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    const rendered = await response.json().catch(() => ({}));
    if (!response.ok || rendered.ok !== true || rendered.verified !== true || !rendered.artifactUrl) {
      throw new Error("Render failed HTTP " + response.status + ": " + String(rendered.error || rendered.note || JSON.stringify(rendered)).slice(0, 300));
    }
    const artifactResponse = await fetch(new URL(rendered.artifactUrl, baseUrl), { signal: AbortSignal.timeout(60000) });
    if (!artifactResponse.ok || !String(artifactResponse.headers.get("content-type") || "").includes("video/mp4")) {
      throw new Error("Verified artifact could not be downloaded as MP4.");
    }
    const bytes = Buffer.from(await artifactResponse.arrayBuffer());
    if (bytes.length < 100000) throw new Error("Rendered MP4 is unexpectedly small.");
    const slug = product.handle || product.shopifyProductId?.split("/").pop() || "product-" + (index + 1);
    const filename = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) + ".mp4";
    const filePath = path.join(outputDir, filename);
    await fs.writeFile(filePath, bytes);
    result.status = "verified";
    result.file = filename;
    result.bytes = bytes.length;
    result.durationSeconds = rendered.artifact.durationSeconds;
    result.width = rendered.artifact.width;
    result.height = rendered.artifact.height;
    result.visualQA = rendered.visualQA?.status || "unknown";
    result.videoType = rendered.videoType;
    console.log("Rendered " + (index + 1) + "/" + candidates.length + ": " + product.title + " (" + filename + ")");
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 400);
    console.error("Could not render " + product.title + ": " + result.error);
  }
  report.results.push(result);
}

await fs.writeFile(path.join(outputDir, "product-picture-video-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("Product-picture videos verified: " + report.results.filter(result => result.status === "verified").length + "/" + report.results.length);
if (!report.results.some(result => result.status === "verified")) process.exitCode = 1;
