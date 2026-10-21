import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const redirectsPath = resolve(root, "legal-pages/_redirects");
const redirects = readFileSync(redirectsPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.split(/\s+/));

test("legal site redirect targets resolve to real published files", () => {
  assert.ok(redirects.length > 0, "redirect file should define routes");
  for (const [source, target, status] of redirects) {
    assert.ok(source.startsWith("/"), `route source must be absolute: ${source}`);
    assert.ok(target.startsWith("/"), `route target must be absolute: ${target}`);
    assert.ok(["200", "301", "302", "307", "308"].includes(status), `unsupported status for ${source}: ${status}`);
    const targetFile = resolve(root, "legal-pages", target.replace(/^\/+/, ""));
    assert.ok(
      existsSync(targetFile),
      `redirect ${source} points to missing file ${targetFile}`
    );
  }
});

test("privacy and terms routes point to their intended documents", () => {
  const bySource = new Map(redirects.map(([source, target]) => [source, target]));
  assert.equal(bySource.get("/privacy.html"), "/privacy-policy.html");
  assert.equal(bySource.get("/privacy"), "/privacy-policy.html");
  assert.equal(bySource.get("/terms"), "/terms.html/index.html");
});
