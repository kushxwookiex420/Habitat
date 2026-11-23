import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normaliseDigest, parseSidecar, sha256File, verifyDigest } from "../scripts/verify-apk-sha256.mjs";

const payload = "not a real apk — fixture bytes\n";
const digest = createHash("sha256").update(payload).digest("hex");

test("the digest of a file matches an independent hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apk-verify-"));
  const file = join(dir, "artifact.apk");
  await writeFile(file, payload);
  assert.equal(await sha256File(file), digest);
});

test("a correct digest passes regardless of case or prefix", () => {
  assert.equal(verifyDigest(digest, digest.toUpperCase()).ok, true);
  assert.equal(verifyDigest(digest, "SHA256: " + digest).ok, true);
  assert.equal(normaliseDigest("  SHA-256=" + digest + "  "), digest);
});

test("a mismatched digest fails closed", () => {
  const other = createHash("sha256").update("different").digest("hex");
  const result = verifyDigest(digest, other);
  assert.equal(result.ok, false);
  assert.match(result.reason, /mismatch/);
});

test("malformed digests fail instead of comparing loosely", () => {
  assert.equal(verifyDigest("abc", digest).ok, false);
  assert.equal(verifyDigest(digest, "").ok, false);
  assert.equal(verifyDigest(digest, digest.slice(0, 63) + "z").ok, false);
});

test("a sidecar in coreutils format is parsed", () => {
  assert.equal(parseSidecar(digest + "  Habitat-0.8.5-ax-debug.apk\n"), digest);
  assert.equal(parseSidecar("not-a-digest  file.apk"), "");
});
