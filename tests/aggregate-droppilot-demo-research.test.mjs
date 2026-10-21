import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/aggregate-droppilot-demo-research.mjs");

test("aggregates product research while preserving unverified rights and publish states", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "habitat-demo-aggregate-"));
  try {
    const artifact = path.join(root, "research", "DropPilot-Daily-Demo-Research-Batch-0");
    const output = path.join(root, "out");
    await fs.mkdir(artifact, { recursive: true });
    await fs.writeFile(path.join(artifact, "droppilot-demo-research-batch.json"), JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-10-21T12:00:00.000Z",
      catalogProductCount: 2,
      products: [
        {
          shopifyProductId: "gid://shopify/Product/1",
          title: "Product with video-page leads",
          status: "video_page_leads_found",
          candidateCount: 3,
          videoPageCandidateCount: 2,
          directVideoCandidateCount: 1,
          rightsStatus: "unverified",
          qaStatus: "not_run",
          publishStatus: "not_approved"
        },
        {
          shopifyProductId: "gid://shopify/Product/2",
          title: "Product with no relevant results",
          status: "no_relevant_results",
          candidateCount: 0,
          videoPageCandidateCount: 0,
          directVideoCandidateCount: 0,
          rightsStatus: "unverified",
          qaStatus: "not_run",
          publishStatus: "not_approved"
        }
      ]
    }));
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCH_ARTIFACTS_DIR: path.join(root, "research"),
        RESEARCH_AGGREGATE_DIR: output
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(await fs.readFile(path.join(output, "droppilot-demo-research-aggregate.json"), "utf8"));
    assert.equal(report.inputArtifactCount, 1);
    assert.equal(report.productRecordCount, 2);
    assert.equal(report.statusCounts.videoPageLeadsFound, 1);
    assert.equal(report.statusCounts.noRelevantResults, 1);
    assert.equal(report.totals.videoPageLeads, 2);
    assert.equal(report.totals.directVideoLeads, 1);
    assert.ok(report.products.every(p => p.rightsStatus === "unverified"));
    assert.ok(report.products.every(p => p.qaStatus === "not_run"));
    assert.ok(report.products.every(p => p.publishStatus === "not_approved"));
    const markdown = await fs.readFile(path.join(output, "droppilot-demo-research-aggregate.md"), "utf8");
    assert.match(markdown, /Research candidates are leads only/);
    assert.match(markdown, /No Shopify product, inventory, price, video, or publishing state was changed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fails clearly when no research artifacts are available", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "habitat-demo-aggregate-empty-"));
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        RESEARCH_ARTIFACTS_DIR: path.join(root, "missing"),
        RESEARCH_AGGREGATE_DIR: path.join(root, "out")
      }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No droppilot-demo-research-batch\.json files found/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
