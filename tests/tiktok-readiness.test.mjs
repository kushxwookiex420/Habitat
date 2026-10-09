import test from "node:test";
import assert from "node:assert/strict";
import { buildTikTokPublisherStatus } from "../tiktok-publisher.mjs";

test("missing token blocks TikTok readiness", () => {
  const status = buildTikTokPublisherStatus({ tokenPresent: false });
  assert.equal(status.configured, false);
  assert.equal(status.directPostReady, false);
  assert.equal(status.readiness, "blocked");
});

test("a token alone does not claim posting readiness", () => {
  const status = buildTikTokPublisherStatus({ tokenPresent: true });
  assert.equal(status.configured, true);
  assert.equal(status.directPostReady, false);
  assert.equal(status.readiness, "token_present_unverified");
  assert.match(status.note, /creator permissions have not been verified/i);
});

test("readiness only advances after explicit creator preflight", () => {
  const status = buildTikTokPublisherStatus({ tokenPresent: true, creatorPreflightPassed: true });
  assert.equal(status.directPostReady, true);
  assert.equal(status.readiness, "preflight_passed");
  assert.match(status.note, /explicit user approval/i);
});
