import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectSandbox, SANDBOX_BACKEND, SANDBOX_LIMITS, runSandboxed } from "../nexus-sandbox.mjs";
import { createReadOnlyAdapters } from "../nexus-adapters.mjs";

/**
 * Portable tier: everything here must pass on any CI runner, including one where unprivileged user
 * namespaces are blocked. It verifies the *contract* the sandbox makes, not that the kernel enforces
 * isolation — the namespace tier (`tests/nexus-sandbox.test.mjs`) does that and is skipped, with a
 * reason, where the kernel will not allow it.
 */

const verdict = await detectSandbox();

test("capability detection returns a fail-closed verdict and never throws", () => {
  assert.equal(typeof verdict.available, "boolean");
  assert.equal(verdict.backend, SANDBOX_BACKEND);
  assert.equal(typeof verdict.reason, "string");
  assert.ok(verdict.reason.length > 0);
  assert.ok(Array.isArray(verdict.missing));
  if (verdict.available) {
    assert.equal(verdict.missing.length, 0);
    assert.match(verdict.reason, /namespace/i);
  } else {
    // An unavailable verdict must say what is missing: tools, the setup script, the platform, or
    // the namespace probe. A bare "unavailable" is not diagnosable.
    assert.match(verdict.reason, /missing primitives|namespace probe failed/);
  }
});

test("a host without chroot is reported unavailable, naming the primitive", async () => {
  const injected = await detectSandbox({ hostTools: { chroot: null } });
  assert.equal(injected.available, false);
  assert.match(injected.reason, /missing primitives/);
  assert.ok(
    injected.missing.some(entry => entry.startsWith("chroot")),
    "the verdict must name chroot, got: " + injected.missing.join(", ")
  );
  // The seam must not poison the cached real verdict for this process.
  const again = await detectSandbox();
  assert.equal(again.available, verdict.available);
});

test("a host without unshare fails closed before any command can run", async () => {
  const injected = await detectSandbox({ hostTools: { unshare: "/nonexistent/unshare" } });
  assert.equal(injected.available, false);
  assert.ok(injected.missing.some(entry => entry.startsWith("unshare")));
});

test("the adapter refuses rather than falling back to host execution when the sandbox is unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-contract-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.mjs"), "export const ok = true;\n");

  const adapters = createReadOnlyAdapters({
    rootDir: root,
    allowedPrefixes: ["src"],
    enableTestAdapter: true,
    allowedTests: { smoke: { command: process.execPath, args: ["-e", "console.log(1)"] } },
    // Exactly what the real sandbox returns when detectSandbox() says no.
    sandboxRunner: async () => ({
      ok: false,
      code: "sandbox_unavailable",
      error: "Sandbox unavailable: namespace probe failed"
    })
  });
  assert.equal(typeof adapters["repo.test"], "function");
  const result = await adapters["repo.test"]({ input: { test: "smoke" } });
  assert.equal(result.ok, false, "a missing sandbox must never be reported as a successful run");
  const serialized = JSON.stringify(result);
  assert.match(serialized, /sandbox_unavailable/);
  // No fabricated process evidence: there was no process.
  assert.equal(result.exitCode ?? null, null);
});

test("runSandboxed refuses with a typed code when detection says unavailable", async () => {
  // On a host where the tier-1 verdict is already false this is the real path; on a capable host the
  // same refusal is proven above through the adapter. Both cases assert the same contract: a refusal
  // is typed, not an exception and not a success.
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-contract-src-"));
  await fs.writeFile(path.join(source, "noop.mjs"), "process.exit(0);\n");
  const direct = await runSandboxed({
    sourceDir: source,
    allowedPrefixes: ["noop.mjs"],
    command: process.execPath,
    args: ["noop.mjs"],
    timeoutMs: 5000
  });
  if (!verdict.available) {
    assert.equal(direct.ok, false);
    assert.equal(direct.code, "sandbox_unavailable");
    return;
  }
  assert.equal(direct.ok, true, "on a capable host the sandbox must actually run the command");
});

test("limits are concrete and bounded", () => {
  for (const key of ["memoryBytes", "pids", "nproc", "fileBytes", "workBytes", "tmpBytes", "openFiles"]) {
    assert.equal(typeof SANDBOX_LIMITS[key], "number", key + " must be a number");
    assert.ok(SANDBOX_LIMITS[key] > 0, key + " must be positive");
  }
});

test("every skip reason states the missing capability and the alternative verification path", async () => {
  const sandboxSuite = await fs.readFile(new URL("./nexus-sandbox.test.mjs", import.meta.url), "utf8");
  const adapterSuite = await fs.readFile(new URL("./nexus-adapters.test.mjs", import.meta.url), "utf8");
  for (const [name, source] of [
    ["nexus-sandbox.test.mjs", sandboxSuite],
    ["nexus-adapters.test.mjs", adapterSuite]
  ]) {
    assert.match(source, /missing capability:/, name + " skip reason must name the capability");
    assert.match(source, /alternative:/, name + " skip reason must name the alternative path");
  }
  const doc = await fs.readFile(new URL("../docs/SANDBOX_SECURITY.md", import.meta.url), "utf8");
  assert.match(doc, /Tier 1/, "the security doc must describe the portable tier");
  assert.match(doc, /Tier 2/, "the security doc must describe the namespace tier");
  assert.match(doc, /Tier 3/, "the security doc must describe the dedicated-host tier");
});
