import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadOnlyAdapters } from "../nexus-adapters.mjs";
import { detectSandbox } from "../nexus-sandbox.mjs";

const sandbox = await detectSandbox();
const needsSandbox = { skip: sandbox.available ? false : "sandbox backend unavailable: " + sandbox.reason };

const sha256 = value => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-adapters-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.js"), "export const answer = 42;\n");
  await fs.writeFile(path.join(root, "src", "README.md"), "# fixture\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  await fs.writeFile(path.join(root, "secret.txt"), "do not read\n");
  const adapters = createReadOnlyAdapters({ rootDir: root, allowedPrefixes: ["src", "tests", "package.json"] });
  return { root, adapters };
}

async function repoWith(task) {
  return { async get(id) { return id === task.id ? structuredClone(task) : null; } };
}

test("repo.inspect reads an allowed file and returns a content-hash it can be checked against", async () => {
  const { root, adapters } = await fixture();
  const result = await adapters["repo.inspect"]({ input: { path: "src/app.js" } });
  assert.equal(result.ok, true);
  assert.match(result.summary, /Read src\/app\.js/);
  const content = await fs.readFile(path.join(root, "src", "app.js"));
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0], /^repo\.file:src\/app\.js#bytes=0-\d+@sha256:[0-9a-f]{64}$/);
  assert.ok(result.evidence[0].endsWith(sha256(content)), "evidence hash matches the real file bytes");
});

test("repo.inspect lists directories without reading them", async () => {
  const { adapters } = await fixture();
  const result = await adapters["repo.inspect"]({ input: { path: "src" } });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0], /^repo\.dir:src\/@entries=2@sha256:[0-9a-f]{64}$/);
});

test("repo.inspect rejects traversal, absolute paths, disallowed prefixes and symlink escapes", async () => {
  const { root, adapters } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "src", "escape.txt"));

  for (const bad of ["../secret.txt", "/etc/passwd", "secret.txt", "app/secret.txt"]) {
    const result = await adapters["repo.inspect"]({ input: { path: bad } });
    assert.equal(result.ok, false, bad + " must be refused");
  }
  const escaped = await adapters["repo.inspect"]({ input: { path: "src/escape.txt" } });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /outside the repository/);
});

test("repo.test runs an allowlisted command and reports the real exit code and evidence", needsSandbox, async () => {
  const { root } = await fixture();
  const adapters = createReadOnlyAdapters({
    rootDir: root,
    allowedPrefixes: ["src", "package.json"],
    allowedTests: { "pass": { command: process.execPath, args: ["-e", "console.log('ok')"] } }
  });
  const result = await adapters["repo.test"]({ input: { test: "pass" } });
  assert.equal(result.ok, true);
  assert.match(result.summary, /exit code 0/);
  assert.match(result.evidence[0], /^test:pass:exit=0:duration=\d+ms:stdout_sha256=[0-9a-f]{64}:stderr_sha256=[0-9a-f]{64}:isolated=\d+:sandbox=linux-userns@command=/);
  assert.ok(result.evidence[0].includes(sha256("ok\n")), "stdout hash matches the real output");
});

test("repo.test reports a failing command as a failure, never as success", needsSandbox, async () => {
  const { root } = await fixture();
  const adapters = createReadOnlyAdapters({
    rootDir: root,
    allowedTests: { "fail": { command: process.execPath, args: ["-e", "console.error('boom'); process.exit(3)"] } }
  });
  const result = await adapters["repo.test"]({ input: { test: "fail" } });
  assert.equal(result.ok, false);
  assert.match(result.error, /code 3/);
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0], /exit=3/);
});

test("repo.test refuses commands that are not on the allowlist", async () => {
  const { root } = await fixture();
  const adapters = createReadOnlyAdapters({ rootDir: root, allowedTests: {} });
  const result = await adapters["repo.test"]({ input: { test: "rm -rf /" } });
  assert.equal(result.ok, false);
  assert.match(result.error, /allowed test list/);
});

test("repo.test kills a hung command and reports the timeout", needsSandbox, async () => {
  const { root } = await fixture();
  const adapters = createReadOnlyAdapters({
    rootDir: root,
    allowedTests: { "hang": { command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], timeoutMs: 1000 } }
  });
  const started = Date.now();
  const result = await adapters["repo.test"]({ input: { test: "hang" } });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.match(result.evidence[0], /timeout=1000ms/);
  assert.ok(elapsed < 6000, "the adapter returned promptly instead of waiting for the process");
});

test("task.inspect reports ownership, lease, approvals and history", async () => {
  const task = {
    id: "cmd_1", objective: "inspect", status: "working", attempts: 2,
    claimedBy: "nexus-worker-1", fence: "fence-1", leaseUntil: "2026-11-21T12:00:00.000Z",
    approvals: [{ state: "approved" }], statusHistory: [{ to: "queued" }, { to: "working" }]
  };
  const adapters = createReadOnlyAdapters({ rootDir: ".", repository: await repoWith(task) });
  const result = await adapters["task.inspect"]({ input: { taskId: "cmd_1" } });
  assert.equal(result.ok, true);
  assert.match(result.summary, /working/);
  assert.match(result.summary, /approvals: approved/);
  assert.match(result.evidence[0], /^task:cmd_1:status=working:attempts=2:owner=nexus-worker-1:fence=present:lease=2026-11-21T12:00:00\.000Z:history=2@observed=/);
  assert.equal(result.evidence[0].includes("fence-1"), false, "the fence value itself is not exposed");
});

test("task.inspect fails honestly for a missing task or repository", async () => {
  const adapters = createReadOnlyAdapters({ rootDir: ".", repository: { async get() { return null; } } });
  const missing = await adapters["task.inspect"]({ input: { taskId: "nope" } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No task/);

  const noRepo = createReadOnlyAdapters({ rootDir: "." });
  const unavailable = await noRepo["task.inspect"]({ input: { taskId: "nope" } });
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error, /needs a task repository/);
});

test("runtime.health reports live, stale and stopped workers plus active working tasks", async () => {
  const now = Date.now();
  const iso = offset => new Date(now + offset).toISOString();
  const query = async sql => {
    if (sql.includes("habitat_nexus_workers")) {
      return [{ results: [
        { worker_id: "live-1", heartbeat_at: iso(-1000), state: "idle", claimed: 3, completed: 2, failed: 1 },
        { worker_id: "stale-1", heartbeat_at: iso(-300000), state: "idle", claimed: 0, completed: 0, failed: 0 },
        { worker_id: "stopped-1", heartbeat_at: iso(-1000), state: "stopped", claimed: 1, completed: 1, failed: 0 }
      ] }];
    }
    return [{ results: [{ n: 2 }] }];
  };
  const adapters = createReadOnlyAdapters({ rootDir: ".", query });
  const result = await adapters["runtime.health"]({});
  assert.equal(result.ok, true);
  assert.match(result.summary, /1 live, 1 stale, 1 stopped/);
  assert.match(result.summary, /2 task\(s\) in working state/);
  assert.match(result.evidence[0], /^runtime:workers=3:live=1:stale=1:stopped=1:working=2@observed=/);
});

test("runtime.health fails honestly when the database read fails", async () => {
  const adapters = createReadOnlyAdapters({ rootDir: ".", query: async () => { throw new Error("D1 down"); } });
  const result = await adapters["runtime.health"]({});
  assert.equal(result.ok, false);
  assert.match(result.error, /D1 down/);
});

test("every successful adapter result carries verifiable evidence", needsSandbox, async () => {
  const { root, adapters } = await fixture();
  const task = { id: "cmd_2", status: "queued", attempts: 0, approvals: [], statusHistory: [] };
  const full = createReadOnlyAdapters({
    rootDir: root,
    repository: await repoWith(task),
    query: async () => [{ results: [] }],
    allowedTests: { "pass": { command: process.execPath, args: ["-e", "process.exit(0)"] } }
  });
  const results = await Promise.all([
    full["repo.inspect"]({ input: { path: "src/app.js" } }),
    full["repo.test"]({ input: { test: "pass" } }),
    full["task.inspect"]({ input: { taskId: "cmd_2" } }),
    full["runtime.health"]({})
  ]);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length >= 1);
    assert.ok(result.evidence.every(item => typeof item === "string" && item.length > 10));
    assert.equal(typeof result.summary, "string");
    assert.ok(!("blockers" in result) || Array.isArray(result.blockers));
  }
});

test("repo.test does not leak service secrets into the child environment", needsSandbox, async () => {
  const { root } = await fixture();
  const adapters = createReadOnlyAdapters({
    rootDir: root,
    allowedTests: {
      "env": { command: process.execPath, args: ["-e", "process.exit(process.env.NEXUS_TEST_SENTINEL ? 7 : 0)"] }
    }
  });
  process.env.NEXUS_TEST_SENTINEL = "should-not-be-inherited";
  try {
    const result = await adapters["repo.test"]({ input: { test: "env" } });
    assert.equal(result.ok, true, "the sentinel was not present in the child environment");
  } finally {
    delete process.env.NEXUS_TEST_SENTINEL;
  }
});

test("repo.test never echoes command output that could contain a secret", needsSandbox, async () => {
  const { root } = await fixture();
  const adapters = createReadOnlyAdapters({
    rootDir: root,
    allowedTests: {
      "leak": { command: process.execPath, args: ["-e", "console.error('super-secret-value'); process.exit(1)"] }
    }
  });
  const result = await adapters["repo.test"]({ input: { test: "leak" } });
  assert.equal(result.ok, false);
  assert.equal(result.error.includes("super-secret-value"), false);
  assert.match(result.evidence[0], /stderr_sha256=[0-9a-f]{64}/);
});
