import test from "node:test";
import assert from "node:assert/strict";
import { buildCapabilityStatus } from "../capability-status.mjs";

test("capability report distinguishes configured AI from verified inference", () => {
  const report = buildCapabilityStatus({ aiProviderConfigured: true, workerRegistered: true });
  assert.equal(report.capabilities.aiInference.status, "configured_unverified");
  assert.equal(report.capabilities.aiWorker.status, "configured_unverified");
});

test("capability report never claims task durability before D1 is configured and ready", () => {
  const report = buildCapabilityStatus({
    env: { CLOUDFLARE_ACCOUNT_ID: "account", HABITAT_D1_DATABASE_ID: "database", HABITAT_D1_API_TOKEN: "token" },
    aiProviderConfigured: true,
    workerRegistered: true
  });
  assert.equal(report.capabilities.taskPersistence.durable, false);
  assert.equal(report.capabilities.taskPersistence.d1CredentialsPresent, true);
  assert.equal(report.capabilities.taskPersistence.d1Integrated, true);
  assert.equal(report.capabilities.taskPersistence.restartRecovery, false);
});

test("capability report marks missing provider and Android heartbeat as blocked/unverified", () => {
  const report = buildCapabilityStatus({ aiProviderConfigured: false, workerRegistered: false, androidStatus: "UNVERIFIED" });
  assert.equal(report.capabilities.aiInference.status, "blocked");
  assert.equal(report.capabilities.aiWorker.status, "blocked");
  assert.equal(report.capabilities.androidDevice.status, "unverified");
});

test("publishing remains approval-gated and media QA is not presumed", () => {
  const report = buildCapabilityStatus({ aiProviderConfigured: true });
  assert.equal(report.capabilities.externalPublishing.status, "approval_gated_unverified");
  assert.equal(report.capabilities.contentQualityGates.status, "unverified");
  assert.equal(report.capabilities.contentJobPersistence.status, "blocked");
  assert.equal(report.capabilities.contentJobPersistence.durable, false);
  assert.equal(report.secretsExposed, false);
});

test("capability report marks task routes durable only after repository readiness", () => {
  const report = buildCapabilityStatus({
    taskRepositoryConfigured: true,
    taskRepositoryReady: true
  });
  assert.equal(report.capabilities.taskPersistence.durable, true);
  assert.equal(report.capabilities.taskPersistence.adapter, "cloudflare-d1");
  assert.equal(report.capabilities.taskPersistence.restartRecovery, true);
  assert.equal(report.capabilities.taskExecution.status, "available_durable_task_routes");
});


test("capability report reflects durable content-job storage only after D1 initialization", () => {
  const report = buildCapabilityStatus({
    taskRepositoryConfigured: true,
    taskRepositoryReady: true,
    contentJobRepositoryReady: true
  });
  assert.equal(report.capabilities.contentJobPersistence.status, "ready");
  assert.equal(report.capabilities.contentJobPersistence.adapter, "cloudflare-d1");
  assert.equal(report.capabilities.contentJobPersistence.durable, true);
  assert.match(report.capabilities.contentJobPersistence.detail, /TikTok OAuth state\/tokens remain separate/);
});
