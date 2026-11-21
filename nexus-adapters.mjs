import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runSandboxed } from "./nexus-sandbox.mjs";

/**
 * READ-ONLY Nexus adapters.
 *
 * These adapters inspect and test; they never write, publish, purchase, deploy or delete. Every
 * "ok" result carries evidence produced by the operation itself (a path with a content hash, a real
 * process exit code, a read-back task record, a heartbeat query). Failures return ok:false with the
 * real error; the worker then fails the task instead of completing it.
 *
 * Guards:
 *  - repo.inspect is confined to `rootDir` (symlink-escape checked with realpath) and to
 *    `allowedPrefixes`, so a task cannot read outside the repository or into excluded paths.
 *  - repo.test runs only named commands from `allowedTests` inside the Linux user/mount/PID/net
 *    namespace sandbox in nexus-sandbox.mjs. It never executes in the host namespace: if the
 *    sandbox is unavailable the adapter fails closed and the task fails.
 *  - Every operation is bounded by a timeout; a hung command is killed and reported as timed out.
 */

const DEFAULT_ALLOWED_PREFIXES = Object.freeze(["src", "tests", "docs", "app/src", "README.md", "package.json"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_READ_BYTES = 64 * 1024;
const MAX_DIR_ENTRIES = 200;

function failure(error, extra = {}) {
  return { ok: false, error: String(error).slice(0, 1000), ...extra };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRel(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function within(prefixes, rel) {
  return prefixes.some(prefix => rel === prefix || rel.startsWith(prefix + "/"));
}

export function createReadOnlyAdapters({
  rootDir,
  repository = null,
  query = null,
  allowedPrefixes = DEFAULT_ALLOWED_PREFIXES,
  allowedTests = {},
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  sandboxRunner = runSandboxed,
  now = () => new Date().toISOString()
} = {}) {
  if (!rootDir) throw new Error("Read-only adapters need a rootDir.");
  const root = path.resolve(rootDir);
  const prefixes = allowedPrefixes.map(normalizeRel).filter(Boolean);

  /** Resolve a task-supplied path inside root and inside the allowlist, following symlinks. */
  async function resolveInside(relPath) {
    const rel = normalizeRel(relPath);
    if (!rel) return failure("A relative path is required.");
    if (path.isAbsolute(rel) || rel.split("/").includes("..")) return failure("Path must stay inside the repository.");
    if (!within(prefixes, rel)) return failure('Path "' + rel + '" is not in the inspectable allowlist.');
    const realRoot = await fs.realpath(root);
    let real;
    try {
      real = await fs.realpath(path.resolve(realRoot, rel));
    } catch {
      return failure('Path "' + rel + '" does not exist.');
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return failure("Path resolves outside the repository.");
    const realRel = normalizeRel(path.relative(realRoot, real));
    if (!within(prefixes, realRel)) return failure("Resolved path is outside the inspectable allowlist.");
    return { rel: realRel, real };
  }

  async function repoInspect(task) {
    const requested = task?.input?.path ?? task?.input?.dir ?? task?.objective ?? "";
    const resolved = await resolveInside(requested);
    if (resolved.ok === false) return resolved;
    const { rel, real } = resolved;
    try {
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        const entries = (await fs.readdir(real, { withFileTypes: true }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, MAX_DIR_ENTRIES)
          .map(entry => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
        const digest = sha256(JSON.stringify(entries));
        return {
          ok: true,
          summary: "Listed " + entries.length + " entries under " + rel + "/ (read-only).",
          decisions: [],
          blockers: [],
          evidence: ["repo.dir:" + rel + "/@entries=" + entries.length + "@sha256:" + digest]
        };
      }
      const handle = await fs.open(real, "r");
      try {
        const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, Number(stat.size) || 0));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, bytesRead).toString("utf8");
        const lines = content.split("\n").length;
        const truncated = stat.size > bytesRead;
        return {
          ok: true,
          summary: "Read " + rel + " (" + lines + " line" + (lines === 1 ? "" : "s") + ", " + bytesRead + " of " + stat.size + " bytes" + (truncated ? ", truncated" : "") + ").",
          decisions: [],
          blockers: [],
          evidence: [
            "repo.file:" + rel + "#bytes=0-" + bytesRead + (truncated ? ":truncated" : "") + "@sha256:" + sha256(buffer.subarray(0, bytesRead))
          ]
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      return failure("repo.inspect failed: " + String(error?.message || error));
    }
  }

  async function repoTest(task) {
    const name = String(task?.input?.test || task?.input?.suite || "").trim();
    if (!name) return failure("input.test must name an allowed test.");
    if (name.length > 80) return failure("input.test is too long.");
    const spec = allowedTests[name];
    if (!spec) return failure('Test "' + name + '" is not in the allowed test list.');
    if (typeof spec.command !== "string" || !spec.command.trim()) {
      return failure('Test "' + name + '" has no executable command in the allowlist.');
    }
    const timeoutMs = Math.max(1000, Math.min(Number(spec.timeoutMs) || defaultTimeoutMs, 10 * 60 * 1000));
    const command = [spec.command, ...(spec.args || [])].join(" ");
    let result;
    try {
      result = await sandboxRunner({
        sourceDir: root,
        allowedPrefixes: prefixes,
        command: spec.command,
        args: [...(spec.args || [])],
        timeoutMs
      });
    } catch (error) {
      return failure("Sandbox runner failed: " + String(error?.message || error), {
        evidence: ["sandbox:runner_error@" + command]
      });
    }
    if (result?.code) {
      return failure(result.error || "Sandbox refused to run the test.", {
        evidence: ["sandbox:" + result.code + "@" + command]
      });
    }
    if (result?.limitsExceeded) {
      return failure('Test "' + name + '" exceeded the sandbox ' + result.limitsExceeded + ' limit and its process tree was killed.', {
        evidence: ["test:" + name + ":limit=" + result.limitsExceeded + ":sandbox=" + (result.sandbox?.backend || "unknown") + "@command=" + command]
      });
    }
    if (result?.timedOut) {
      return failure('Test "' + name + '" timed out after ' + timeoutMs + 'ms and its process tree was killed.', {
        evidence: [
          "test:" + name + ":timeout=" + timeoutMs + "ms:duration=" + result.durationMs + "ms:sandbox=" + (result.sandbox?.backend || "unknown") + "@command=" + command
        ]
      });
    }
    // Output content is never returned: a test could print a secret, and this summary is stored in
    // the task record. Only hashes, exit code and duration are exposed.
    const evidence = [
      "test:" + name + ":exit=" + result.exitCode + ":duration=" + result.durationMs + "ms:stdout_sha256=" + (result.stdoutSha256 || sha256("")) +
        ":stderr_sha256=" + (result.stderrSha256 || sha256("")) + ":isolated=" + (result.isolatedPaths || []).length +
        ":sandbox=" + (result.sandbox?.backend || "unknown") + "@command=" + command
    ];
    if (result.exitCode !== 0) {
      return failure(
        'Test "' + name + '" exited with ' + (result.exitCode === null ? "signal " + result.signal : "code " + result.exitCode) + ".",
        { evidence }
      );
    }
    return {
      ok: true,
      summary: 'Test "' + name + '" passed with exit code 0 in ' + result.durationMs + "ms inside an isolated sandbox (" + command + ").",
      decisions: [],
      blockers: [],
      evidence
    };
  }

  async function taskInspect(task) {
    if (!repository || typeof repository.get !== "function") return failure("task.inspect needs a task repository.");
    const taskId = String(task?.input?.taskId || task?.id || "").trim();
    if (!taskId) return failure("No task id is available to inspect.");
    let record;
    try {
      record = await repository.get(taskId);
    } catch (error) {
      return failure("task.inspect could not read the task: " + String(error?.message || error));
    }
    if (!record) return failure('No task "' + taskId + '" exists.');
    const history = Array.isArray(record.statusHistory) ? record.statusHistory.length : 0;
    const approvals = Array.isArray(record.approvals)
      ? record.approvals.map(entry => entry.state || "unknown").join(",")
      : "none";
    const evidence = [
      "task:" + taskId + ":status=" + String(record.status || "unknown") +
      ":attempts=" + Number(record.attempts || 0) +
      ":owner=" + String(record.claimedBy || "none") +
      ":fence=" + (record.fence ? "present" : "none") +
      ":lease=" + String(record.leaseUntil || "none") +
      ":history=" + history +
      "@observed=" + now()
    ];
    return {
      ok: true,
      summary: "Task " + taskId + " is " + String(record.status || "unknown") + " (attempts " + Number(record.attempts || 0) + ", approvals: " + approvals + ").",
      decisions: [],
      blockers: [],
      evidence
    };
  }

  async function runtimeHealth() {
    if (typeof query !== "function") return failure("runtime.health needs a D1 query function.");
    let workers;
    let working;
    try {
      workers = (await query("SELECT worker_id, heartbeat_at, state, claimed, completed, failed FROM habitat_nexus_workers ORDER BY heartbeat_at DESC LIMIT 10"))?.[0]?.results || [];
      working = (await query("SELECT COUNT(*) AS n FROM habitat_command_tasks WHERE status = 'working'"))?.[0]?.results?.[0]?.n || 0;
    } catch (error) {
      return failure("runtime.health could not read worker state: " + String(error?.message || error));
    }
    const at = Date.now();
    const classify = row => {
      const age = at - Date.parse(row.heartbeat_at);
      if (row.state === "stopped") return "stopped";
      return age > 120_000 ? "stale" : "live";
    };
    const counts = workers.reduce((acc, row) => {
      acc[classify(row)] += 1;
      return acc;
    }, { live: 0, stale: 0, stopped: 0 });
    return {
      ok: true,
      summary: "Workers: " + counts.live + " live, " + counts.stale + " stale, " + counts.stopped + " stopped; " + Number(working) + " task(s) in working state.",
      decisions: [],
      blockers: [],
      evidence: [
        "runtime:workers=" + workers.length + ":live=" + counts.live + ":stale=" + counts.stale +
        ":stopped=" + counts.stopped + ":working=" + Number(working) + "@observed=" + now()
      ]
    };
  }

  return Object.freeze({
    "repo.inspect": repoInspect,
    "repo.test": repoTest,
    "task.inspect": taskInspect,
    "runtime.health": runtimeHealth
  });
}
