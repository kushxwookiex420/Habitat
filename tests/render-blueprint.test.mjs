import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Static validation of render.yaml.
 *
 * This is a text-level check, not a Render API validation: Render only validates a Blueprint when
 * it is created from the dashboard. The assertions below mirror Render's documented Blueprint
 * fields (type, runtime, plan, region, branch, rootDir, buildCommand, startCommand,
 * healthCheckPath, autoDeployTrigger, envVars) so a mistake is caught before the dashboard.
 *
 * No Render service exists yet; nothing here contacts Render.
 */

const source = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
const lines = source.split("\n");

function serviceBlock() {
  const start = lines.findIndex(line => line.trim() === "services:");
  assert.notEqual(start, -1, "render.yaml must declare services");
  return lines.slice(start).join("\n");
}
const service = serviceBlock();

function valueOf(key) {
  const match = service.match(new RegExp("^\\s*-?\\s*" + key + ":\\s*(.+)$", "m"));
  return match ? match[1].trim().replace(/^"|"$/g, "") : null;
}

function envEntry(key) {
  const index = lines.findIndex(line => line.trim() === "- key: " + key);
  assert.notEqual(index, -1, "missing env var " + key);
  const block = [lines[index]];
  for (let i = index + 1; i < lines.length; i += 1) {
    if (/^\s*-\s*key:/.test(lines[i])) break;
    if (!/^\s{6,}/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}

test("the only declared service is the nonproduction web service on Render Free", () => {
  assert.equal((source.match(/-\s+type:\s*web/g) || []).length, 1, "exactly one web service");
  assert.equal(valueOf("type"), "web");
  assert.equal(valueOf("name"), "ax-nexus-habitat-nonprod");
  assert.equal(valueOf("runtime"), "node");
  assert.equal(valueOf("plan"), "free", "$0/month plan must be selected in the Blueprint");
  assert.equal(valueOf("region"), "oregon");
});

test("the blueprint pins the deployment branch, commands, and health check", () => {
  assert.equal(valueOf("branch"), "ax-nexus/revision-4.5-free-deployment-readiness");
  assert.equal(valueOf("rootDir"), ".");
  assert.equal(valueOf("buildCommand"), "npm install --omit=dev --ignore-scripts");
  assert.equal(valueOf("startCommand"), "npm start");
  assert.equal(valueOf("healthCheckPath"), "/health");
  assert.equal(valueOf("autoDeployTrigger"), "off", "auto-deploy must stay disabled");
});

test("no paid plan or paid resource is declared", () => {
  const paidPlans = ["starter", "0.5c-512mb", "1c-2g", "2c-4g", "2c-8g", "standard", "pro", "pro_plus"];
  for (const plan of paidPlans) {
    assert.equal(
      new RegExp("^\\s*plan:\\s*" + plan.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "m").test(source),
      false,
      "paid plan declared: " + plan
    );
  }
  assert.equal(/^\s*(databases|disks):/m.test(source), false, "no paid database or disk declared");
  assert.equal(/^\s*numInstances:\s*[2-9]/m.test(source), false, "one free instance only");
});

test("the service identifies itself as nonproduction and pins Node 22", () => {
  assert.match(envEntry("HABITAT_RUNTIME_ENV"), /value:\s*"?nonproduction"?/);
  assert.match(envEntry("HABITAT_SERVICE_NAME"), /value:\s*"?ax-nexus-habitat-nonprod"?/);
  assert.match(envEntry("NODE_VERSION"), /value:\s*"?22\./);
});

test("production isolation variables are declared and every secret is dashboard-only", () => {
  assert.match(envEntry("HABITAT_PRODUCTION_D1_DATABASE_ID"), /sync:\s*false/);
  assert.match(envEntry("HABITAT_D1_DATABASE_ID"), /sync:\s*false/);

  const secretKeys = [
    "CLOUDFLARE_ACCOUNT_ID",
    "HABITAT_D1_DATABASE_ID",
    "HABITAT_D1_API_TOKEN",
    "HABITAT_PRODUCTION_D1_DATABASE_ID",
    "HABITAT_AX_BRIDGE_TOKEN",
    "HABITAT_OWNER_DEVICE_IDS",
    "HABITAT_BREAK_GLASS_TOKEN",
    "HABITAT_DEVICE_PAIRING_BOOTSTRAP_CODE_HASH",
    "HABITAT_DEVICE_PAIRING_BOOTSTRAP_EXPIRES_AT"
  ];
  for (const key of secretKeys) {
    const entry = envEntry(key);
    assert.match(entry, /sync:\s*false/, key + " must be provided in the dashboard");
    assert.equal(/^\s*value:/m.test(entry), false, key + " must not carry a value in the repository");
  }
});

test("the repository contains no credential-shaped values", () => {
  assert.equal(/ax_bridge_[A-Za-z0-9]{10,}/.test(source), false);
  assert.equal(/owner_token_[A-Za-z0-9]{10,}/.test(source), false);
  assert.equal(/\b[a-f0-9]{64}\b/i.test(source), false, "no hash or key literals");
  assert.equal(/sync:\s*true/.test(source), false, "sync:true would commit a secret");
});
