import test from "node:test";
import assert from "node:assert/strict";
import { buildTikTokPublisherStatus, uploadTikTokToInbox } from "../tiktok-publisher.mjs";

test("TikTok upload-to-inbox requires explicit user consent before sending media", async () => {
  await assert.rejects(
    uploadTikTokToInbox({ artifactPath: "/not-used.mp4", bytes: 100, userConsent: false }),
    /explicit user consent is required/
  );
});

test("publisher status documents both selected Content Posting API scopes", () => {
  const status = buildTikTokPublisherStatus({ tokenPresent: true });
  assert.equal(status.scopeRequired, "video.publish");
  assert.equal(status.uploadScopeRequired, "video.upload");
});
