import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScheduledPost } from "../scheduled-post-guard.mjs";

const goodMedia = {
  ok: true,
  decision: "PASS",
  network: "tiktok",
  contentType: "image/jpeg",
  width: 1080,
  height: 1350
};

function ready(overrides = {}) {
  return evaluateScheduledPost({
    network: "tiktok",
    providerStatus: "scheduled",
    draft: false,
    autoPublish: false,
    mediaPreflight: goodMedia,
    explicitApproval: true,
    approvalRecordedAt: "2026-10-12T12:00:00Z",
    ...overrides
  });
}

test("holds failed provider posts and unknown or pending status", () => {
  assert.equal(ready({ providerStatus: "error" }).reason, "provider_reports_failure");
  assert.equal(ready({ providerStatus: "pending" }).reason, "provider_status_not_confirmed_ready");
  assert.equal(ready({ providerStatus: "" }).reason, "provider_status_unknown");
});

test("holds drafts, missing media proof, and media checked for another network", () => {
  assert.equal(ready({ draft: true }).reason, "post_is_still_a_draft");
  assert.equal(ready({ mediaPreflight: null }).reason, "media_preflight_not_passed");
  assert.equal(ready({ mediaPreflight: { ...goodMedia, network: "instagram" } }).reason, "media_preflight_network_mismatch");
});

test("requires an explicit approval recorded for the specific post", () => {
  assert.equal(ready({ explicitApproval: false }).reason, "explicit_post_approval_required");
  assert.equal(ready({ approvalRecordedAt: "" }).reason, "explicit_post_approval_required");
});

test("passes only to human review and never publishes or schedules", () => {
  const result = ready({ autoPublish: true });
  assert.equal(result.decision, "READY_FOR_HUMAN_REVIEW");
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.publisherInvoked, false);
  assert.equal(result.sideEffectsPerformed, false);
  assert.equal(result.autoPublishRequested, true);
});
