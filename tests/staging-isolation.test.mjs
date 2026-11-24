import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const STAGING_DB = "0fdf1ac9-65a3-4e83-8042-f3fa52282068";
const PRODUCTION_DB = "3a906029-bc64-4e2a-b648-163e34a2d502";
const PRODUCTION_HOST = "habitat-1-szzd.onrender.com";

test("the staging blueprint is free, separate, manually deployed and points only at staging", async () => {
  const yaml = await readFile(new URL("../render.staging.yaml", import.meta.url), "utf8");
  assert.match(yaml, /name:\s*habitat-staging/);
  assert.match(yaml, /plan:\s*free/);
  assert.match(yaml, /branch:\s*staging\/integration/);
  assert.match(yaml, /autoDeploy:\s*false/);
  assert.match(yaml, /healthCheckPath:\s*\/health/);
  assert.ok(yaml.includes(STAGING_DB), "staging database id is fixed in the blueprint");
  assert.equal(yaml.includes(PRODUCTION_DB), false, "the production database must never appear");
  assert.equal(yaml.includes(PRODUCTION_HOST), false, "the production service must never appear");
  assert.match(yaml, /key:\s*HABITAT_MCP_SECRET_KEY\n\s+sync:\s*false/);
  assert.match(yaml, /key:\s*HABITAT_D1_API_TOKEN\n\s+sync:\s*false/);
  assert.match(yaml, /key:\s*HABITAT_WORKFORCE_ENABLED\n\s+value:\s*"false"/);
  assert.match(yaml, /key:\s*HABITAT_MISSIONS_ENABLED\n\s+value:\s*"false"/);
  assert.match(yaml, /key:\s*NEXUS_RUNTIME_ENABLED\n\s+value:\s*"false"/);
});

test("the owner checklist never tells the owner to deploy to production", async () => {
  const doc = await readFile(new URL("../docs/STAGING_OWNER_CHECKLIST.md", import.meta.url), "utf8");
  assert.match(doc, /habitat-staging/);
  assert.match(doc, /Never deploy to `habitat-1-szzd`/);
  assert.equal(doc.includes("Open Render → the `habitat-1-szzd` service"), false);
  assert.match(doc, /Do not paste secrets into\s+ChatGPT/);
});

test("the isolation finding names the evidence for treating the live service as production", async () => {
  const doc = (await readFile(new URL("../docs/RENDER_STAGING_SETUP.md", import.meta.url), "utf8")).toLowerCase();
  for (const marker of ["ax_continuity.md", "android", "content workflows", "/system/status", "3a906029"]) {
    assert.ok(doc.includes(marker), "missing isolation evidence: " + marker);
  }
});
