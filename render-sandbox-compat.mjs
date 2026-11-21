#!/usr/bin/env node
/**
 * Render / host sandbox compatibility probe.
 *
 * Run this in the intended NON-PRODUCTION service image (never in production):
 *   node render-sandbox-compat.mjs
 *
 * It performs no writes outside a temporary directory, never reads credentials, never prints
 * environment values, and exits non-zero if any required primitive is missing. A failing check
 * means `repo.test` must stay disabled on that runtime; nothing falls back to host execution.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectSandbox, runSandboxed } from "./nexus-sandbox.mjs";
import { createReadOnlyAdapters } from "./nexus-adapters.mjs";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? " — " + detail : ""));
}

function run(command, args, timeoutMs = 10_000) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { out += chunk; });
    child.on("error", error => resolve({ code: null, out: String(error.code || error.message) }));
    child.on("close", code => resolve({ code, out }));
  });
}

async function probeScript(script, { timeoutMs = 20_000, limits = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-compat-"));
  try {
    await fs.writeFile(path.join(dir, "probe.js"), script);
    return await runSandboxed({ sourceDir: dir, allowedPrefixes: ["probe.js"], command: "node", args: ["/work/probe.js"], timeoutMs, limits });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const required = ["/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/prlimit", "/usr/sbin/chroot", "/usr/bin/mount", "/bin/sh", "/usr/bin/env"];
const missing = [];
for (const binary of required) {
  try { await fs.access(binary); } catch { missing.push(binary); }
}
record("1. unshare and sandbox binaries present", missing.length === 0, missing.join(", "));

const userNs = await run("/usr/bin/unshare", ["-Ur", "/bin/true"]);
record("2. user namespace creation", userNs.code === 0, "exit " + userNs.code);

const mountDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-compat-mnt-"));
const mountNs = await run("/usr/bin/unshare", ["-Urm", "/bin/sh", "-c", "mount -t tmpfs none " + JSON.stringify(mountDir) + " && umount " + JSON.stringify(mountDir)]);
record("3. mount namespace creation", mountNs.code === 0, "exit " + mountNs.code);
await fs.rm(mountDir, { recursive: true, force: true });

const pidProbe = await probeScript(`
  import fs from "node:fs";
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  process.exit(stat.split(" ")[0] === "1" ? 0 : 21);
`);
record("4. PID namespace (probe runs as PID 1)", pidProbe.exitCode === 0, "exit " + pidProbe.exitCode);

const netProbe = await probeScript(`
  import net from "node:net";
  let escaped = false;
  await new Promise(resolve => {
    const socket = net.connect({ host: "1.1.1.1", port: 443 });
    socket.on("connect", () => { escaped = true; resolve(); });
    socket.on("error", () => resolve());
    setTimeout(resolve, 1500);
  });
  process.exit(escaped ? 22 : 0);
`);
record("5. network namespace isolation", netProbe.exitCode === 0, "exit " + netProbe.exitCode);

const chrootProbe = await probeScript(`
  import fs from "node:fs";
  let sawHost = false;
  try { fs.statSync("/workspace"); sawHost = true; } catch {}
  process.exit(sawHost ? 23 : 0);
`);
record("6. chroot root is isolated", chrootProbe.exitCode === 0, "exit " + chrootProbe.exitCode);

const roProbe = await probeScript(`
  import fs from "node:fs";
  let wrote = false;
  try { fs.writeFileSync("/usr/compat-pwn", "x"); wrote = true; } catch {}
  process.exit(wrote ? 24 : 0);
`);
record("7. read-only /usr enforcement", roProbe.exitCode === 0, "exit " + roProbe.exitCode);

const timeoutProbe = await probeScript("setTimeout(() => {}, 60000);", { timeoutMs: 1500 });
record("8. process termination on timeout", timeoutProbe.timedOut === true && timeoutProbe.exitCode !== 0, "timedOut=" + timeoutProbe.timedOut);

const limitProbe = await probeScript(`
  import { spawn } from "node:child_process";
  const blocked = [];
  await Promise.all(Array.from({ length: 120 }, () => new Promise(resolve => {
    const child = spawn("/bin/sh", ["-c", "sleep 0.5"], { stdio: "ignore" });
    child.on("error", error => { if (error.code === "EAGAIN") blocked.push(1); resolve(); });
    child.on("exit", () => resolve());
    setTimeout(resolve, 3000);
  })));
  process.exit(blocked.length > 0 ? 0 : 25);
`, { timeoutMs: 30000, limits: { pids: 16, nproc: 512 } });
record("9. process ceiling enforced by host supervisor", limitProbe.limitsExceeded === "pids" && limitProbe.exitCode !== 0, "limitsExceeded=" + limitProbe.limitsExceeded + " exit=" + limitProbe.exitCode);

const verdict = await detectSandbox();
let failClosed = false;
if (!verdict.available) {
  failClosed = true;
} else {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-compat-fc-"));
  try {
    const adapters = createReadOnlyAdapters({
      rootDir: dir,
      allowedTests: { unit: { command: "node", args: ["-e", "process.exit(0)"] } },
      sandboxRunner: async () => ({ ok: false, code: "sandbox_unavailable", error: "probe: unavailable" })
    });
    const outcome = await adapters["repo.test"]({ input: { test: "unit" } });
    failClosed = outcome.ok === false && /unavailable/i.test(outcome.error) && !("exitCode" in outcome);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
record("10. fail-closed when the sandbox is unavailable", failClosed);

const failed = results.filter(result => !result.ok);
console.log("\n" + JSON.stringify({ backend: verdict.backend, available: verdict.available, reason: verdict.reason, checks: results.length, failed: failed.length }));
console.log(failed.length === 0 ? "RENDER-SANDBOX-COMPAT: PASS (run again inside the intended non-production Render image)" : "RENDER-SANDBOX-COMPAT: FAIL — keep repo.test disabled on this runtime");
process.exit(failed.length === 0 ? 0 : 1);
