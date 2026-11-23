/**
 * Genuine execution boundary for repository tests.
 *
 * Backend: Linux user + mount + PID + network namespaces via `unshare -r -m -p -f -n`, a disposable
 * tmpfs root built by `sandbox/sandbox-setup.sh`, chroot, capabilities dropped, no_new_privs,
 * kernel rlimits, and an empty environment. There is no network interface in the sandbox and the
 * only host trees mounted are read-only `/usr` and, when the running Node binary lives elsewhere
 * (a CI tool cache such as `/opt/hostedtoolcache`), just that binary's own directory.
 *
 * If the host cannot provide those primitives, detection fails and callers must fail closed. This
 * module never falls back to running a command in the host namespace.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SCRIPT = path.join(HERE, "sandbox", "sandbox-setup.sh");

export const SANDBOX_BACKEND = "linux-userns";

export const SANDBOX_LIMITS = Object.freeze({
  memoryBytes: 4096 * 1024 * 1024,
  pids: 64,
  nproc: 256,
  fileBytes: 64 * 1024 * 1024,
  workBytes: 256 * 1024 * 1024,
  tmpBytes: 64 * 1024 * 1024,
  openFiles: 256
});

// Resolved across the usual prefixes: current Ubuntu merges /usr/sbin into /usr/bin, and older
// images keep chroot under /usr/sbin, so a fixed path silently disables the sandbox on one of them.
const HOST_TOOLS = Object.freeze({
  unshare: ["/usr/bin/unshare", "/bin/unshare"],
  setpriv: ["/usr/bin/setpriv", "/bin/setpriv"],
  prlimit: ["/usr/bin/prlimit", "/bin/prlimit"],
  chroot: ["/usr/sbin/chroot", "/usr/bin/chroot", "/sbin/chroot", "/bin/chroot"],
  mount: ["/usr/bin/mount", "/bin/mount"],
  sh: ["/bin/sh", "/usr/bin/sh"],
  env: ["/usr/bin/env", "/bin/env"]
});

let cached = null;

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveTool(candidates) {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

function probeNamespaces(unsharePath, shPath, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(unsharePath, ["-r", "-m", "-p", "-f", "-n", shPath, "-c", "echo probe-ok"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" }
    });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", error => resolve({ ok: false, reason: error.code || error.message }));
    child.on("close", code => resolve(code === 0 && out.includes("probe-ok") ? { ok: true } : { ok: false, reason: "namespace probe exited " + code }));
  });
}

/**
 * Returns a cached capability verdict. `available: false` means repo.test MUST NOT execute.
 */
export async function detectSandbox({ timeoutMs = 5000, hostTools = null } = {}) {
  // `hostTools` is a test seam: it lets a suite assert the fail-closed verdict for a host that is
  // missing a primitive without running as root or editing the host. A supplied seam is never
  // cached, so it cannot leak into a later real detection in the same process.
  const cacheable = hostTools === null;
  // A test seam must bypass the cache, not be answered by it: the whole point is to observe the
  // verdict this host would produce with a primitive missing.
  if (cached && cacheable) return cached;
  const missing = [];
  const tools = {};
  for (const [name, candidates] of Object.entries(HOST_TOOLS)) {
    const override = hostTools && Object.prototype.hasOwnProperty.call(hostTools, name) ? hostTools[name] : undefined;
    const found = override === null ? null : override ? await resolveTool([override]) : await resolveTool(candidates);
    if (found) tools[name] = found;
    else missing.push(name + " (" + (override === null ? "disabled by caller" : candidates.join(" or ")) + ")");
  }
  if (!(await exists(SETUP_SCRIPT))) missing.push(SETUP_SCRIPT);
  if (process.platform !== "linux") missing.push("linux");
  if (missing.length) {
    const verdict = Object.freeze({ available: false, backend: SANDBOX_BACKEND, missing, tools, reason: "missing primitives: " + missing.join(", ") });
    if (cacheable) cached = verdict;
    return verdict;
  }
  const probe = await probeNamespaces(tools.unshare, tools.sh, timeoutMs);
  const verdict = Object.freeze(probe.ok
    ? { available: true, backend: SANDBOX_BACKEND, missing: [], tools, reason: "user/mount/pid/net namespaces available" }
    : { available: false, backend: SANDBOX_BACKEND, missing: [], tools, reason: "namespace probe failed: " + probe.reason });
  if (cacheable) cached = verdict;
  return verdict;
}

/**
 * Count processes in the sandbox's process group. RLIMIT_NPROC is NOT reliable inside a new user
 * namespace (the namespace root gets its own accounting), so the host supervises the group and
 * kills it when the configured process ceiling is exceeded.
 */
async function countGroupProcesses(pgid) {
  let count = 0;
  let entries = [];
  try { entries = await fs.readdir("/proc"); } catch { return 0; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await fs.readFile("/proc/" + entry + "/stat", "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const fields = stat.slice(close + 2).split(" ");
      if (Number(fields[2]) === pgid) count += 1;
    } catch { /* process exited */ }
  }
  return count;
}

function hashOf(value) {
  return createHash("sha256").update(value || "").digest("hex");
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function copyAllowlistedSource(base, sourceDir, allowedPrefixes) {
  const checkout = path.join(base, "checkout");
  await fs.mkdir(checkout, { recursive: true });
  const copied = [];
  for (const prefix of allowedPrefixes) {
    const clean = String(prefix || "").replace(/^\/+|\/+$/g, "");
    if (!clean || clean.split("/").includes("..")) continue;
    const from = path.join(sourceDir, clean);
    const to = path.join(checkout, clean);
    try {
      await fs.cp(from, to, { recursive: true, dereference: false, force: true, errorOnExist: false, verbatimSymlinks: true });
      copied.push(clean);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { checkout, copied };
}

/**
 * Run one allowlisted command inside the sandbox.
 *
 * @param {object} options
 * @param {string} options.sourceDir       host directory to copy allowlisted prefixes from
 * @param {string[]} options.allowedPrefixes prefixes copied into the isolated checkout
 * @param {string} options.command         executable name resolved inside the sandbox PATH
 * @param {string[]} [options.args]
 * @param {number} options.timeoutMs
 * @returns {Promise<object>} result with exit code, duration, hashes and applied limits
 */
export async function runSandboxed({ sourceDir, allowedPrefixes, command, args = [], timeoutMs, limits: overrides = {} }) {
  const verdict = await detectSandbox();
  if (!verdict.available) {
    return { ok: false, code: "sandbox_unavailable", error: "Sandbox unavailable: " + verdict.reason, sandbox: verdict };
  }
  if (typeof command !== "string" || !command.trim()) return { ok: false, code: "sandbox_invalid_command", error: "Sandbox needs a command." };
  if (typeof sourceDir !== "string" || !sourceDir) return { ok: false, code: "sandbox_invalid_source", error: "Sandbox needs a source directory." };

  const cpuSeconds = Math.ceil(clamp(timeoutMs, 1000, 600000, 120000) / 1000) + 5;
  const limits = Object.freeze({
    ...SANDBOX_LIMITS,
    ...overrides,
    cpuSeconds: Math.max(cpuSeconds, Math.ceil(clamp(overrides.cpuSeconds || 0, 1, 600, 0))),
    timeoutMs: clamp(timeoutMs, 1000, 600000, 120000)
  });

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-sbx-"));
  const root = path.join(base, "root");
  let copied = [];
  try {
    await fs.mkdir(path.join(root, "usr"), { recursive: true });
    await fs.mkdir(path.join(root, "proc"), { recursive: true });
    await fs.mkdir(path.join(root, "dev"), { recursive: true });
    await fs.mkdir(path.join(root, "tmp"), { recursive: true });
    await fs.mkdir(path.join(root, "work"), { recursive: true });
    for (const [link, target] of [["bin", "usr/bin"], ["sbin", "usr/sbin"], ["lib", "usr/lib"], ["lib64", "usr/lib64"]]) {
      await fs.symlink(target, path.join(root, link)).catch(async error => { if (error.code !== "EEXIST") throw error; });
    }
    const nodeDir = path.dirname(process.execPath);
    const sandboxPath = [...new Set(["/usr/local/bin", "/usr/bin", "/bin", nodeDir])].join(":");
    // The chroot only exposes /usr, so a Node installed anywhere else (GitHub's tool cache, a
    // version manager, /opt) would be invisible and every repo.test would fail with exit 127.
    const runtimeDir = nodeDir === "/usr" || nodeDir.startsWith("/usr/") ? "" : nodeDir;
    const prepared = await copyAllowlistedSource(base, sourceDir, allowedPrefixes);
    copied = prepared.copied;

    const argsList = [
      "-r", "-m", "-p", "-f", "-n",
      "/bin/sh", SETUP_SCRIPT, base,
      String(limits.memoryBytes), String(limits.nproc), String(limits.fileBytes),
      String(limits.workBytes), String(limits.tmpBytes), String(limits.cpuSeconds), String(limits.openFiles),
      sandboxPath, runtimeDir, verdict.tools.chroot, verdict.tools.sh, command, ...args.map(String)
    ];

    return await new Promise(resolve => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let limitsExceeded = null;
      let settled = false;
      const child = spawn(verdict.tools.unshare, argsList, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" }
      });
      const finish = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearInterval(monitor);
        resolve({
          ok: exitCode === 0,
          exitCode: exitCode === null ? null : exitCode,
          signal: signal || null,
          timedOut,
          durationMs: Date.now() - started,
          stdoutSha256: hashOf(stdout),
          stderrSha256: hashOf(stderr),
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: Buffer.byteLength(stderr),
          isolatedPaths: copied,
          limitsExceeded,
          sandbox: verdict,
          limits
        });
      };
      const killTree = () => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      };
      const timer = setTimeout(() => { timedOut = true; killTree(); }, limits.timeoutMs);
      const monitor = setInterval(async () => {
        if (settled || timedOut) return;
        const count = await countGroupProcesses(child.pid);
        if (count > limits.pids) {
          limitsExceeded = "pids";
          killTree();
        }
      }, 100);
      if (typeof monitor.unref === "function") monitor.unref();
      child.stdout.on("data", chunk => { if (stdout.length < 2_000_000) stdout += chunk; });
      child.stderr.on("data", chunk => { if (stderr.length < 2_000_000) stderr += chunk; });
      child.on("error", error => { clearTimeout(timer); finish(97, String(error.code || error.message)); });
      child.on("close", (code, signal) => { clearTimeout(timer); finish(code, signal); });
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** Test helper: forget the cached capability verdict. */
export function resetSandboxDetection() {
  cached = null;
}
