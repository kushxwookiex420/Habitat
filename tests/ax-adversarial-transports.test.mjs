import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRepositoryEngineeringTransport,
  createRepositoryResearchTransport,
  filteredEnv
} from "../ax-agent-transports.mjs";

async function fixtureRepo() {
  const directory = await mkdtemp(path.join(tmpdir(), "habitat-transport-"));
  const root = path.join(directory, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "safe.mjs"), "export const value = 1;\n// TODO: check me\n");
  await writeFile(path.join(root, ".env"), "HABITAT_AX_COMMAND_TOKEN=hidden-secret\n");
  await writeFile(path.join(root, "huge.txt"), "x".repeat(500));
  await writeFile(path.join(directory, "outside.txt"), "outside secret\n");
  await symlink(path.join(directory, "outside.txt"), path.join(root, "link.txt"));
  return { directory, root };
}

test("engineering refuses traversal, hidden files and symlink escapes", async () => {
  const { directory, root } = await fixtureRepo();
  try {
    const engineering = createRepositoryEngineeringTransport({
      root,
      inspectPaths: ["../outside.txt", ".env", "link.txt"],
      checks: []
    });
    const result = await engineering({ objective: "read forbidden paths" });
    assert.deepEqual(result.files.map(item => item.error), ["inspect_outside_root", "inspect_hidden_path", "inspect_symlink"]);
    assert.equal(result.ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("engineering refuses a file above its byte bound instead of reading it", async () => {
  const { directory, root } = await fixtureRepo();
  try {
    const engineering = createRepositoryEngineeringTransport({ root, inspectPaths: ["huge.txt"], checks: [], maxFileBytes: 100 });
    const result = await engineering({ objective: "read a huge file" });
    assert.equal(result.files[0].error, "inspect_file_too_large");
    assert.equal(result.ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a filename cannot become a shell command or create a side effect", async () => {
  const { directory, root } = await fixtureRepo();
  try {
    const engineering = createRepositoryEngineeringTransport({
      root,
      inspectPaths: ["safe.mjs; touch pwned"],
      checks: []
    });
    const result = await engineering({ objective: "attempt injection" });
    assert.equal(result.ok, false);
    await assert.rejects(() => access(path.join(root, "pwned")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("child checks inherit no credentials and cannot read them from the environment", async () => {
  const { directory, root } = await fixtureRepo();
  const previous = process.env.HABITAT_AX_COMMAND_TOKEN;
  process.env.HABITAT_AX_COMMAND_TOKEN = "parent-process-secret-value";
  try {
    const engineering = createRepositoryEngineeringTransport({
      root,
      inspectPaths: ["safe.mjs"],
      checks: [{
        name: "env-probe",
        command: process.execPath,
        args: ["-e", "console.log(process.env.HABITAT_AX_COMMAND_TOKEN || 'absent')"],
        env: { HABITAT_AX_COMMAND_TOKEN: "check-level-secret", SAFE_VALUE: "visible" }
      }]
    });
    const result = await engineering({ objective: "probe environment" });
    assert.equal(result.commands[0].exitCode, 0);
    assert.match(result.commands[0].stdoutTail, /absent/);
    assert.doesNotMatch(result.commands[0].stdoutTail, /secret-value/);
    assert.doesNotMatch(result.commands[0].stdoutTail, /check-level-secret/);
  } finally {
    if (previous === undefined) delete process.env.HABITAT_AX_COMMAND_TOKEN;
    else process.env.HABITAT_AX_COMMAND_TOKEN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("filteredEnv only passes interpreter basics and non-credential extras", () => {
  const env = filteredEnv({ SAFE_VALUE: "yes", API_KEY: "no", OWNER_TOKEN: "no", session: "no" });
  assert.equal(env.SAFE_VALUE, "yes");
  assert.equal(env.API_KEY, undefined);
  assert.equal(env.OWNER_TOKEN, undefined);
  assert.equal(env.session, undefined);
  assert.equal(env.NO_COLOR, "1");
});

test("a timed-out check is killed, bounded and reported as a failure", async () => {
  const { directory, root } = await fixtureRepo();
  try {
    const started = Date.now();
    const engineering = createRepositoryEngineeringTransport({
      root,
      inspectPaths: ["safe.mjs"],
      checks: [{ name: "hang", command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 150 }]
    });
    const result = await engineering({ objective: "timeout a child" });
    assert.equal(result.ok, false);
    assert.equal(result.commands[0].timedOut, true);
    assert.ok(Date.now() - started < 3_000, "the parent did not wait for the full child sleep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research cites only real local files and never invents web sources", async () => {
  const { directory, root } = await fixtureRepo();
  try {
    const research = createRepositoryResearchTransport({ root, maxFiles: 20 });
    const result = await research({ objective: "value TODO safe" });
    assert.equal(result.ok, true);
    assert.ok(result.sources.length >= 1);
    for (const source of result.sources) {
      assert.match(source.url, /^repo:\/\//);
      assert.match(source.digest, /^[a-f0-9]{32}$/);
    }
    assert.ok(result.limitations.some(line => /no web access/i.test(line)));
    assert.equal(result.sources.some(source => source.url.includes(".env")), false);
    assert.equal(result.sources.some(source => source.url.includes("link.txt")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
