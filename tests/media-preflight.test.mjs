import test from "node:test";
import assert from "node:assert/strict";
import { preflightImage, isPrivateAddress, registerMediaPreflight } from "../media-preflight.mjs";

function makeDeps({ contentType = "image/jpeg", bytes = Buffer.from("image"), metadata = { format: "jpeg", width: 1080, height: 1350 }, metadataReader, status = 200, declaredLength } = {}) {
  const calls = [];
  return {
    calls,
    lookupImpl: async () => [{ address: "93.184.216.34" }],
    metadataReader: metadataReader || (async () => metadata),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: key => key === "content-type" ? contentType : key === "content-length" ? String(declaredLength ?? bytes.length) : null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      };
    }
  };
}

test("accepts accessible, bounded JPEG with verified matching dimensions and MIME", async () => {
  const deps = makeDeps();
  const result = await preflightImage({ url: "https://cdn.example/image.jpg", network: "tiktok", ...deps });
  assert.equal(result.ok, true);
  assert.equal(result.decision, "PASS");
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1350);
  assert.equal(result.autoPublish, false);
  assert.equal(deps.calls[0].options.redirect, "error");
});

test("holds unsupported target, invalid URL, non-HTTPS, and redirect/fetch failures", async () => {
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "unknown" })).decision, "HOLD");
  assert.equal((await preflightImage({ url: "http://cdn.example/a.jpg", network: "instagram" })).reason, "media_url_must_be_public_https");
  const deps = makeDeps();
  deps.fetchImpl = async () => { throw new Error("redirect or network failure"); };
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...deps })).reason, "media_fetch_failed_or_redirected");
});

test("holds private and unresolved media hosts before fetching", async () => {
  const deps = makeDeps();
  deps.lookupImpl = async () => [{ address: "127.0.0.1" }];
  const result = await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...deps });
  assert.equal(result.reason, "media_host_not_confirmed_public");
  assert.equal(deps.calls.length, 0);
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("::ffff:192.168.1.5"), true);
  assert.equal(isPrivateAddress("ff02::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("holds unknown MIME, non-success HTTP, and empty/corrupt images", async () => {
  assert.equal((await preflightImage({ url: "https://cdn.example/a.svg", network: "instagram", ...makeDeps({ contentType: "image/svg+xml" }) })).reason, "unsupported_or_unknown_mime_type");
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...makeDeps({ status: 404 }) })).reason, "media_http_not_successful");
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...makeDeps({ metadataReader: async () => { throw new Error("bad image"); } }) })).reason, "media_bytes_are_not_a_valid_image");
});

test("holds TikTok PNG, mismatched signatures, and oversized images", async () => {
  assert.equal((await preflightImage({ url: "https://cdn.example/a.png", network: "tiktok", ...makeDeps({ contentType: "image/png", metadata: { format: "png", width: 1080, height: 1350 } }) })).reason, "tiktok_image_requires_jpeg_for_this_publishing_path");
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...makeDeps({ metadata: { format: "png", width: 1080, height: 1350 } }) })).reason, "mime_and_image_signature_do_not_match");
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...makeDeps({ metadata: { format: "jpeg", width: 2560, height: 1440 } }) })).reason, "image_exceeds_1080p_dimension_guard");
});

test("holds low-resolution images, oversized bodies, and inconsistent lengths", async () => {
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...makeDeps({ metadata: { format: "jpeg", width: 200, height: 200 } }) })).reason, "image_dimensions_too_small");
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", maxBytes: 2, ...makeDeps({ bytes: Buffer.from("large") }) })).reason, "media_exceeds_byte_limit");
  assert.equal((await preflightImage({ url: "https://cdn.example/a.jpg", network: "instagram", ...makeDeps({ declaredLength: 100 }) })).reason, "media_content_length_mismatch");
});

test("registers read-only status and preflight endpoints", () => {
  const routes = new Map();
  const app = { get: (path, handler) => routes.set("GET " + path, handler), post: (path, handler) => routes.set("POST " + path, handler) };
  registerMediaPreflight(app);
  assert.equal(typeof routes.get("GET /media/preflight/status"), "function");
  assert.equal(typeof routes.get("POST /media/preflight"), "function");
});
