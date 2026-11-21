import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { detectSandbox, runSandboxed } from "../nexus-sandbox.mjs";
import { createReadOnlyAdapters } from "../nexus-adapters.mjs";

const sandbox = await detectSandbox();
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function fixture(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-attack-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (content && content.symlink) await fs.symlink(content.symlink, target);
    else await fs.writeFile(target, content);
  }
  return dir;
}

async function attack(sourceDir, script, { timeoutMs = 20000, limits = {} } = {}) {
  const dir = await fixture({ "attack.js": script });
  const result = await runSandboxed({ sourceDir: dir, allowedPrefixes: ["attack.js"], command: "node", args: ["/work/attack.js"], timeoutMs, limits });
  await fs.rm(dir, { recursive: true, force: true });
  return result;
}

const marker = "NEXUS_DETACHED_MARKER_" + process.pid;

test("sandbox backend is available on this host (required for the remaining tests)", () => {
  assert.equal(sandbox.available, true, "sandbox unavailable: " + sandbox.reason);
});

test("host filesystem and parent directories are not visible", async () => {
  const leaks = await attack("", `
    import fs from "node:fs";
    const probes = ["/etc/passwd", "/root/.ssh/id_rsa", "/var/run/docker.sock", "/workspace", "/home"];
    const leaks = [];
    for (const p of probes) { try { fs.readdirSync(p); leaks.push(p); } catch {} }
    process.exit(leaks.length ? 11 : 0);
  `);
  assert.equal(leaks.exitCode, 0, "visible host paths: " + leaks.exitCode);
});

test("production configuration and non-allowlisted files are not copied", async () => {
  const dir = await fixture({ "attack.js": "", ".env": "HABITAT_D1_API_TOKEN=fixture\n", "config/production.json": "{}\n" });
  await fs.writeFile(path.join(dir, "attack.js"), `
    import fs from "node:fs";
    const leaks = [];
    for (const p of ["/work/.env", "/work/config/production.json", "/work/node_modules"]) { try { fs.statSync(p); leaks.push(p); } catch {} }
    process.exit(leaks.length ? 12 : 0);
  `);
  const result = await runSandboxed({ sourceDir: dir, allowedPrefixes: ["attack.js"], command: "node", args: ["/work/attack.js"], timeoutMs: 20000 });
  await fs.rm(dir, { recursive: true, force: true });
  assert.equal(result.exitCode, 0);
});

test("inherited environment secrets are absent", async () => {
  process.env.HABITAT_D1_API_TOKEN = "sentinel-token-value";
  try {
    const result = await attack("", `
      const leaked = ["HABITAT_D1_API_TOKEN", "HABITAT_AX_BRIDGE_TOKEN", "CLOUDFLARE_API_TOKEN"].filter(k => process.env[k]);
      const suspicious = Object.keys(process.env).filter(k => /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(k));
      process.exit(leaked.length === 0 && suspicious.length === 0 ? 0 : 13);
    `);
    assert.equal(result.exitCode, 0, "environment leaked: " + result.exitCode);
  } finally {
    delete process.env.HABITAT_D1_API_TOKEN;
  }
});

test("writes outside the isolated checkout are refused and /work stays writable", async () => {
  const result = await attack("", `
    import fs from "node:fs";
    const bad = [];
    for (const p of ["/usr/pwn", "/etc/pwn", "/root/pwn", "/host/pwn"]) {
      try { fs.writeFileSync(p, "x"); bad.push(p); } catch {}
    }
    let workOk = false;
    try { fs.writeFileSync("/work/ok", "x"); workOk = true; } catch {}
    process.exit(bad.length === 0 && workOk ? 0 : 14);
  `);
  assert.equal(result.exitCode, 0, "write escaped: " + result.exitCode);
});

test("symlinks and traversal cannot escape the checkout", async () => {
  const host = await fixture({ "secret.txt": "host-secret\n" });
  const dir = await fixture({ "attack.js": "" });
  await fs.writeFile(path.join(dir, "attack.js"), `
    import fs from "node:fs";
    const leaks = [];
    for (const p of ["/work/escape", "/work/escape2", "/work/../etc/passwd", "/work/../../etc/passwd"]) {
      try { fs.readFileSync(p); leaks.push(p); } catch {}
    }
    process.exit(leaks.length ? 15 : 0);
  `);
  await fs.symlink("/etc/passwd", path.join(dir, "escape"));
  await fs.symlink(path.join(host, "secret.txt"), path.join(dir, "escape2"));
  const result = await runSandboxed({ sourceDir: dir, allowedPrefixes: ["attack.js", "escape", "escape2"], command: "node", args: ["/work/attack.js"], timeoutMs: 20000 });
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(host, { recursive: true, force: true });
  assert.equal(result.exitCode, 0);
});

test("outbound network access is unavailable", async () => {
  const result = await attack("", `
    import net from "node:net";
    const failures = [];
    await new Promise(resolve => {
      const socket = net.connect({ host: "1.1.1.1", port: 443 });
      socket.on("connect", () => { failures.push("tcp"); resolve(); });
      socket.on("error", () => resolve());
      setTimeout(resolve, 2000);
    });
    try { await fetch("http://example.com", { signal: AbortSignal.timeout(2000) }); failures.push("http"); } catch {}
    process.exit(failures.length ? 16 : 0);
  `);
  assert.equal(result.exitCode, 0, "network reachable: " + result.exitCode);
});

test("detached child processes do not outlive the sandbox", async () => {
  const leaked = [];
  const scan = async () => {
    for (const entry of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = await fs.readFile("/proc/" + entry + "/cmdline", "utf8");
        if (cmdline.includes(marker)) leaked.push(entry);
      } catch { /* process gone */ }
    }
  };
  const started = Date.now();
  const result = await attack("", `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", ${JSON.stringify(marker)}], { detached: true, stdio: "ignore" }).unref();
    process.exit(0);
  `, { timeoutMs: 20000 });
  const elapsed = Date.now() - started;
  await new Promise(resolve => setTimeout(resolve, 300));
  await scan();
  assert.equal(result.exitCode, 0);
  assert.equal(leaked.length, 0, "detached process survived the namespace");
  assert.ok(elapsed < 6000, "sandbox returned while a detached child was still alive: " + elapsed + "ms");
});

test("excessive process creation is capped by the host process-group supervisor", async () => {
  const result = await attack("", `
    import { spawn } from "node:child_process";
    for (let i = 0; i < 120; i += 1) {
      const child = spawn("/bin/sh", ["-c", "sleep 0.5"], { stdio: "ignore" });
      child.on("error", () => {});
    }
    setInterval(() => {}, 1000);
  `, { timeoutMs: 15000, limits: { pids: 16, nproc: 512 } });
  assert.equal(result.ok, false);
  assert.equal(result.limitsExceeded, "pids");
  assert.ok(result.exitCode !== 0);
});

test("a hung test is killed with its process tree on timeout", async () => {
  const started = Date.now();
  const result = await attack("", `
    setTimeout(() => {}, 30000);
    setInterval(() => {}, 1000);
  `, { timeoutMs: 1000 });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(elapsed < 5000, "timeout took " + elapsed + "ms");
  assert.ok(result.signal === "SIGKILL" || result.exitCode !== 0);
});

test("memory exhaustion is contained by RLIMIT_AS", async () => {
  const result = await attack("", `
    const chunks = [];
    for (;;) chunks.push(Buffer.alloc(64 * 1024 * 1024, 1));
  `, { timeoutMs: 20000, limits: { memoryBytes: 3 * 1024 * 1024 * 1024 } });
  assert.equal(result.ok, false);
  assert.notEqual(result.exitCode, 0);
});

test("recognizable secret output never leaves the sandbox", async () => {
  const sentinel = "NEXUS_SANDBOX_SENTINEL_" + process.pid;
  const result = await attack("", `
    console.log(${JSON.stringify(sentinel)});
    console.error(${JSON.stringify(sentinel + "_stderr")});
  `);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(sentinel), false);
  assert.match(result.stdoutSha256, /^[0-9a-f]{64}$/);
  assert.match(result.stderrSha256, /^[0-9a-f]{64}$/);
  assert.equal(sha256(sentinel + "\n"), result.stdoutSha256);
});

test("the host checkout cannot be modified by the test", async () => {
  const host = await fixture({ "src/app.js": "export const answer = 42;\n" });
  const before = await fs.readFile(path.join(host, "src/app.js"));
  const result = await runSandboxed({
    sourceDir: host,
    allowedPrefixes: ["src"],
    command: "node",
    args: ["-e", "const fs=require('fs');fs.writeFileSync('/work/pwn','x');try{fs.writeFileSync(" + JSON.stringify(path.join(host, "src/app.js")) + ",'pwned')}catch{};try{fs.writeFileSync(" + JSON.stringify(path.join(host, "pwn.txt")) + ",'pwned')}catch{}"],
    timeoutMs: 20000
  });
  assert.equal(result.ok, true, "sandbox setup failed: " + result.error);
  const after = await fs.readFile(path.join(host, "src/app.js"));
  assert.equal(sha256(after), sha256(before));
  assert.deepEqual((await fs.readdir(host)).sort(), ["src"]);
  await fs.rm(host, { recursive: true, force: true });
});

test("capabilities are dropped and no_new_privs is set", async () => {
  const result = await attack("", `
    import fs from "node:fs";
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const nn = /NoNewPrivs:\\s+(\\d+)/.exec(status);
    const cap = /CapEff:\\s+([0-9a-f]+)/.exec(status);
    const ok = nn && nn[1] === "1" && cap && /^0+$/.test(cap[1]);
    process.exit(ok ? 0 : 18);
  `);
  assert.equal(result.exitCode, 0, "capabilities or no_new_privs wrong: " + result.exitCode);
});

test("exit codes and duration are preserved exactly", async () => {
  const result = await attack("", "setTimeout(() => process.exit(7), 250);", { timeoutMs: 20000 });
  assert.equal(result.exitCode, 7);
  assert.equal(result.ok, false);
  assert.ok(result.durationMs >= 200, "duration " + result.durationMs);
});

test("repo.test fails closed when the sandbox backend is unavailable", async () => {
  const dir = await fixture({ "attack.js": "" });
  let called = false;
  const adapters = createReadOnlyAdapters({
    rootDir: dir,
    enableTestAdapter: true,
    allowedTests: { unit: { command: "node", args: ["-e", "process.exit(0)"] } },
    sandboxRunner: async () => {
      called = true;
      return { ok: false, code: "sandbox_unavailable", error: "Sandbox unavailable: probe failed", sandbox: { available: false } };
    }
  });
  const result = await adapters["repo.test"]({ input: { test: "unit" } });
  assert.equal(called, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /Sandbox unavailable/);
  assert.equal("exitCode" in result, false);
  assert.match(result.evidence[0], /sandbox:sandbox_unavailable/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("no sandbox working directories are left behind", async () => {
  const entries = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("nexus-sbx-"));
  assert.deepEqual(entries, []);
});
