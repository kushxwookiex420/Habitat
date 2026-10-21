import fs from "node:fs/promises";
import path from "node:path";

const inputRoot = process.env.RESEARCH_ARTIFACTS_DIR || "dist/research";
const outputRoot = process.env.RESEARCH_AGGREGATE_DIR || "dist";
const reportName = "droppilot-demo-research-batch.json";

async function findReports(dir) {
  const found = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findReports(full));
    else if (entry.isFile() && entry.name === reportName) found.push(full);
  }
  return found;
}

const files = await findReports(inputRoot);
if (!files.length) {
  console.error(`No ${reportName} files found under ${inputRoot}; no research report can be aggregated.`);
  process.exit(1);
}

const reports = [];
for (const file of files) {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.products)) {
    throw new Error(`Invalid research report schema: ${file}`);
  }
  reports.push({ file, report: parsed });
}

const productsById = new Map();
const missingIds = [];
for (const { file, report } of reports) {
  for (const product of report.products) {
    const id = String(product.shopifyProductId || "").trim();
    if (!id) {
      missingIds.push({ file, title: product.title || "(untitled)" });
      continue;
    }
    const previous = productsById.get(id);
    if (!previous || String(product.createdAt || report.createdAt || "") > String(previous.createdAt || "")) {
      productsById.set(id, { ...product, researchReportCreatedAt: report.createdAt || null, sourceArtifact: path.basename(path.dirname(file)) });
    }
  }
}

const products = [...productsById.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
const count = status => products.filter(p => p.status === status).length;
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inputArtifactCount: reports.length,
  productRecordCount: products.length,
  recordsMissingShopifyProductId: missingIds.length,
  statusCounts: {
    videoPageLeadsFound: count("video_page_leads_found"),
    webLeadsOnly: count("web_leads_only"),
    noRelevantResults: count("no_relevant_results"),
    researchFailed: count("research_failed")
  },
  totals: {
    sourceLeads: products.reduce((n, p) => n + Number(p.candidateCount || 0), 0),
    videoPageLeads: products.reduce((n, p) => n + Number(p.videoPageCandidateCount || 0), 0),
    directVideoLeads: products.reduce((n, p) => n + Number(p.directVideoCandidateCount || 0), 0)
  },
  policy: "Research candidates are leads only. This report does not confirm commercial reuse rights, prove a product is shown in footage, mark QA as passed, create a rendered video, or authorize publishing. All product records retain their original rights, QA, and publishing states.",
  products
};

await fs.mkdir(outputRoot, { recursive: true });
await fs.writeFile(path.join(outputRoot, "droppilot-demo-research-aggregate.json"), JSON.stringify(summary, null, 2) + "\n");
const markdown = [
  "# DropPilot Demo Research Aggregate",
  "",
  `Generated: ${summary.generatedAt}`,
  `Research artifacts combined: ${summary.inputArtifactCount}`,
  `Unique product records: ${summary.productRecordCount}`,
  "",
  "## Results",
  "",
  `- Video-page leads found: ${summary.statusCounts.videoPageLeadsFound}`,
  `- Web leads only: ${summary.statusCounts.webLeadsOnly}`,
  `- No relevant results: ${summary.statusCounts.noRelevantResults}`,
  `- Research failed: ${summary.statusCounts.researchFailed}`,
  `- Video-page candidates: ${summary.totals.videoPageLeads}`,
  `- Direct-video candidates: ${summary.totals.directVideoLeads}`,
  "",
  "## Safety boundary",
  "",
  summary.policy,
  "",
  "No Shopify product, inventory, price, video, or publishing state was changed."
].join("\n") + "\n";
await fs.writeFile(path.join(outputRoot, "droppilot-demo-research-aggregate.md"), markdown);
console.log(JSON.stringify({
  inputArtifactCount: summary.inputArtifactCount,
  productRecordCount: summary.productRecordCount,
  statusCounts: summary.statusCounts,
  totals: summary.totals,
  output: [
    path.join(outputRoot, "droppilot-demo-research-aggregate.json"),
    path.join(outputRoot, "droppilot-demo-research-aggregate.md")
  ]
}, null, 2));
