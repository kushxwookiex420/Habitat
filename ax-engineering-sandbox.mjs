import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { filteredEnv } from "./ax-child-env.mjs";

/**
 * Approval-gated engineering sandbox.
 *
 * Agents may propose and test code changes here, never in the deployed checkout. The rules:
 *
 *   - the workspace is a fresh copy of the configured source root, not the source root itself;
 *   - a change is refused unless an injected approval verifier accepts the approval record for this
 *     exact objective and change set (an agent cannot approve itself);
 *   - paths are relative, contained, non-hidden and outside `.git`, `node_modules` and env files;
 *   - file count and bytes are capped, checks are allowlisted commands with a timeout and an output
 *     cap, and the child never inherits credentials;
 *   - a failed check keeps the workspace for inspection; `rollback` restores the copied originals and
 *     `discard` removes the workspace;
 *   - every proposal, approval, applied change, failed check and rollback is sent to the audit hook.
 *
 * `apply` returns a diff and check evidence. It never writes outside `workspace`.
 */

export const SANDBOX_LIMITS = Object.freeze({
  maxFiles: 10,
  maxFileBytes: 200_000,
  maxTotalBytes: 600_000,
  maxChecks: 6,
  checkTimeoutMs: 60_000,
  maxOutputBytes: 8_000,
  maxCopyFiles: 600,
  maxDiffLines: 400
});

const SKIP = new Set([".git", "node_modules", ".gradle", "build", "dist", "out", "target", "coverage", ".next"]);
const BLOCKED_PREFIX = [".env", ".git", "node_modules", "local.properties"];

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function within(root, candidate) {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function lineDiff(before, after, maxLines) {
  const left = String(before).split(/\r?\n/);
  const right = String(after).split(/\r?\n/);
  if (left.length > maxLines || right.length > maxLines) {
    return ["--- before (" + left.length + " lines)", "+++ after (" + right.length + " lines)", "@@ diff suppressed: files exceed the line limit @@"];
  }
  // LCS keeps the diff readable without a dependency. Bounded by maxLines above.
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = ["--- before", "+++ after"];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { lines.push(" " + left[i]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { lines.push("-" + left[i]); i += 1; }
    else { lines.push("+" + right[j]); j += 1; }
  }
  while (i < left.length) { lines.push("-" + left[i]); i += 1; }
  while (j < right.length) { lines.push("+" + right[j]); j += 1; }
  return lines.slice(0, 4_000);
}

async function copyTree(source, target, { maxFiles, maxBytes }) {
  let files = 0;
  let bytes = 0;
  async function walk(from, to) {
    const info = await stat(from);
    if (info.isFile()) {
      if (files >= maxFiles) throw new Error("copy_file_limit");
      const body = await readFile(from);
      if (bytes + body.length > maxBytes) throw new Error("copy_byte_limit");
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, body);
      files += 1;
      bytes += body.length;
      return;
    }
    if (!info.isDirectory()) return;
    await mkdir(to, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith(".env")) continue;
      await walk(path.join(from, entry.name), path.join(to, entry.name));
    }
  }
  await walk(source, target);
  return { files, bytes };
}

function runCheck({ command, args = [], cwd, timeoutMs, maxOutputBytes, env }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        env: filteredEnv(env),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: "", stderr: clean(error?.message, 300), durationMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already gone */ }
    }, timeoutMs);
    const append = (current, chunk) => (current + chunk.toString()).slice(-maxOutputBytes);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: clean(error?.message, 300), durationMs: Date.now() - startedAt });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: typeof code === "number" ? code : null, signal: signal || null, timedOut, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

export function createEngineeringSandbox({
  sourceRoot,
  workspaceParent = os.tmpdir(),
  approvalVerifier = null,
  allowedCommands = [process.execPath],
  checks = [],
  limits = {},
  audit = null,
  env = {},
  log = console,
  now = () => new Date().toISOString()
} = {}) {
  const config = { ...SANDBOX_LIMITS, ...limits };
  if (!sourceRoot) throw new Error("The engineering sandbox needs a source root.");
  const root = path.resolve(sourceRoot);
  let workspace = null;
  let prepared = null;
  const backups = new Map();
  const applied = [];
  const auditEntries = [];

  function record(entry) {
    const event = { at: now(), ...entry };
    auditEntries.push(event);
    try {
      const outcome = audit?.(event);
      if (outcome && typeof outcome.catch === "function") outcome.catch(() => {});
    } catch {
      // Audit failure never decides whether a change is safe.
    }
  }

  async function initialize() {
    if (workspace) return { ok: true, workspace };
    workspace = await mkdtemp(path.join(workspaceParent, "nexus-sandbox-"));
    try {
      prepared = await copyTree(root, workspace, { maxFiles: config.maxCopyFiles, maxBytes: config.maxTotalBytes * 10 });
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      workspace = null;
      return { ok: false, code: "workspace_copy_failed", error: clean(error?.message, 200) };
    }
    return { ok: true, workspace, copied: prepared };
  }

  function validateChanges(changes) {
    const list = Array.isArray(changes) ? changes : [];
    if (!list.length) return { ok: false, code: "changes_required" };
    if (list.length > config.maxFiles) return { ok: false, code: "too_many_files", maxFiles: config.maxFiles };
    let total = 0;
    const normalized = [];
    for (const change of list) {
      const relative = String(change?.path || "").replace(/\\/g, "/").trim();
      if (!relative || path.isAbsolute(relative)) return { ok: false, code: "path_must_be_relative", path: relative };
      if (relative.split("/").some(part => part === ".." || part === "" || part.startsWith("."))) {
        return { ok: false, code: "path_not_allowed", path: relative };
      }
      if (BLOCKED_PREFIX.some(prefix => relative === prefix || relative.startsWith(prefix + "/"))) {
        return { ok: false, code: "path_not_allowed", path: relative };
      }
      const content = String(change?.content ?? "");
      const bytes = Buffer.byteLength(content);
      if (bytes > config.maxFileBytes) return { ok: false, code: "file_too_large", path: relative, maxFileBytes: config.maxFileBytes };
      total += bytes;
      if (total > config.maxTotalBytes) return { ok: false, code: "change_set_too_large", maxTotalBytes: config.maxTotalBytes };
      normalized.push({ path: relative, content, bytes });
    }
    return { ok: true, changes: normalized, bytes: total };
  }

  /**
   * Apply a change set after approval, then run the configured checks. Nothing is written when
   * approval is absent or refused.
   */
  async function apply({ objective, changes, checks: requestedChecks = null, approval = null } = {}) {
    const validation = validateChanges(changes);
    if (!validation.ok) {
      record({ category: "sandbox.refusal", outcome: "denied", summary: validation.code, objective: clean(objective, 200) });
      return validation;
    }
    if (typeof approvalVerifier !== "function") {
      record({ category: "sandbox.refusal", outcome: "denied", summary: "approval_verifier_not_configured", objective: clean(objective, 200) });
      return { ok: false, code: "approval_verifier_not_configured" };
    }
    let verdict;
    try {
      verdict = await approvalVerifier(approval, {
        objective: clean(objective, 500),
        paths: validation.changes.map(change => change.path),
        digests: validation.changes.map(change => digest(change.content))
      });
    } catch {
      verdict = { ok: false, code: "approval_verifier_failed" };
    }
    if (verdict?.ok !== true) {
      record({ category: "sandbox.refusal", outcome: "denied", summary: verdict?.code || "approval_required", objective: clean(objective, 200) });
      return { ok: false, code: verdict?.code || "approval_required" };
    }

    const init = await initialize();
    if (!init.ok) return init;
    record({ category: "sandbox.approved", outcome: "allowed", summary: "approved by " + clean(verdict.approvedBy, 120), objective: clean(objective, 200) });

    const diffs = [];
    try {
      for (const change of validation.changes) {
        const target = path.resolve(workspace, change.path);
        if (!within(workspace, target)) return { ok: false, code: "path_escaped_workspace", path: change.path };
        const existing = existsSync(target) ? await readFile(target, "utf8") : "";
        if (!backups.has(change.path)) backups.set(change.path, existsSync(target) ? existing : null);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, change.content, "utf8");
        applied.push(change.path);
        diffs.push({ path: change.path, digestBefore: digest(existing), digestAfter: digest(change.content), diff: lineDiff(existing, change.content, config.maxDiffLines) });
      }
    } catch (error) {
      record({ category: "sandbox.refusal", outcome: "failed", summary: "write_failed", objective: clean(objective, 200) });
      return { ok: false, code: "write_failed", error: clean(error?.message, 200) };
    }

    const configured = Array.isArray(requestedChecks) && requestedChecks.length ? requestedChecks : checks;
    const checkList = configured.slice(0, config.maxChecks);
    const results = [];
    for (const check of checkList) {
      const command = String(check?.command || "");
      if (!allowedCommands.includes(command)) {
        results.push({ name: clean(check?.name, 120) || command, command, exitCode: null, refused: true, stderr: "command_not_allowlisted" });
        continue;
      }
      const args = (Array.isArray(check.args) ? check.args : []).map(value => String(value));
      const outcome = await runCheck({
        command,
        args,
        cwd: workspace,
        timeoutMs: Math.min(Number(check.timeoutMs) || config.checkTimeoutMs, config.checkTimeoutMs),
        maxOutputBytes: config.maxOutputBytes,
        env
      });
      results.push({ name: clean(check?.name, 120) || (command + " " + args.join(" ")).trim(), command: (command + " " + args.join(" ")).trim(), ...outcome });
    }
    const failed = results.filter(result => result.refused === true || result.exitCode !== 0);
    const verified = results.length > 0 && failed.length === 0;
    record({
      category: verified ? "sandbox.applied" : "sandbox.check_failed",
      outcome: verified ? "allowed" : "failed",
      summary: "checks=" + results.length + " failed=" + failed.length,
      objective: clean(objective, 200)
    });
    return {
      ok: true,
      approved: true,
      verified,
      workspace,
      proposalId: "sbx_" + digest(JSON.stringify(validation.changes) + now()).slice(0, 20),
      changes: diffs,
      checks: results,
      evidence: results.map(result => result.name + " → exit " + Number(result.exitCode ?? -1) + (result.refused ? " (refused)" : "")),
      limitations: [
        "The workspace is a copy; the deployed checkout was never written.",
        "Checks run only from the configured allowlist and never receive credentials."
      ]
    };
  }

  async function rollback() {
    if (!workspace) return { ok: false, code: "no_workspace" };
    for (const [relative, original] of backups.entries()) {
      const target = path.resolve(workspace, relative);
      if (!within(workspace, target)) continue;
      if (original === null) await rm(target, { force: true });
      else await writeFile(target, original, "utf8");
    }
    const count = backups.size;
    backups.clear();
    applied.length = 0;
    record({ category: "sandbox.rolled_back", outcome: "recorded", summary: "restored " + count + " file(s)" });
    return { ok: true, restored: count, workspace };
  }

  async function discard() {
    if (!workspace) return { ok: true, discarded: false };
    await rm(workspace, { recursive: true, force: true });
    const removed = workspace;
    workspace = null;
    backups.clear();
    applied.length = 0;
    record({ category: "sandbox.discarded", outcome: "recorded", summary: "workspace removed" });
    return { ok: true, discarded: true, removed };
  }

  return Object.freeze({
    sourceRoot: root,
    initialize,
    apply,
    rollback,
    discard,
    auditEntries: () => auditEntries.slice(),
    state: () => ({ workspace, applied: applied.slice(), backups: backups.size }),
    limits: Object.freeze({ ...config })
  });
}
