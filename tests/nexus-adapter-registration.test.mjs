import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DISABLED_ADAPTER_NAMES, READ_ONLY_ADAPTER_NAMES, READ_ONLY_ADAPTER_SPECS, buildReadOnlyNexusAdapters } from "../nexus-adapter-registration.mjs";

async function options() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-registration-"));
  await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "src", "app.js"), "export const answer = 42;\n");
  return {
    rootDir,
    allowedPrefixes: ["src"],
    taskRepository: { async get() { return null; } },
    d1Query: async () => [{ results: [] }],
    allowedPrefixesCount: 1
  };
}

test("registration returns exactly the three candidate adapters and never repo.test", async () => {
  const adapters = buildReadOnlyNexusAdapters(await options());
  assert.deepEqual(Object.keys(adapters).sort(), [...READ_ONLY_ADAPTER_NAMES].sort());
  assert.deepEqual(Object.keys(adapters).sort(), ["repo.inspect", "runtime.health", "task.inspect"]);
  assert.equal("repo.test" in adapters, false);
  assert.deepEqual([...DISABLED_ADAPTER_NAMES], ["repo.test"]);
  assert.equal(Object.isFrozen(adapters), true);
  for (const name of READ_ONLY_ADAPTER_NAMES) {
    assert.equal(typeof adapters[name], "function");
    assert.equal(READ_ONLY_ADAPTER_SPECS[name].permissions.length > 0, true);
  }
});

test("a registered adapter produces the runtime result contract", async () => {
  const adapters = buildReadOnlyNexusAdapters(await options());
  const result = await adapters["repo.inspect"]({ id: "t1", input: { path: "src/app.js" } });
  assert.equal(result.ok, true);
  assert.equal(typeof result.summary, "string");
  assert.ok(Array.isArray(result.evidence) && result.evidence.length === 1);
  assert.equal(typeof result.error === "string" || result.error === undefined, true);
});

test("registration fails closed when required wiring is missing", async () => {
  const partial = await options();
  delete partial.d1Query;
  assert.throws(() => buildReadOnlyNexusAdapters(partial), /d1Query/);
  assert.throws(() => buildReadOnlyNexusAdapters({}), /rootDir/);
  const withTests = { ...(await options()), allowedTests: { unit: { command: "node" } } };
  assert.equal("repo.test" in buildReadOnlyNexusAdapters(withTests), false, "repo.test stays disabled even if a test allowlist is supplied");
});
