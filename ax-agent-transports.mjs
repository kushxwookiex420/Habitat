import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createCompositeResearchTransport, createWebResearchTransport } from "./ax-web-research.mjs";

/**
 * Real, injectable transports for the research and engineering agents.
 *
 * These are deliberately local and read-only. They do not call a model, a search API or a deploy
 * tool. The research transport reads a bounded set of repository text files and returns file
 * citations with line numbers and digests; the engineering transport reads allowlisted files and
 * runs only the fixed commands the caller configured (never a shell string). An absent root means
 * the agents keep reporting `capability_unavailable`.
 */

const TEXT_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".json", ".md", ".txt", ".sql", ".kt", ".xml", ".yml", ".yaml", ".toml", ".sh"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".gradle", "build", "dist", "out", "target", "coverage"]);
const MAX_OUTPUT_TAIL = 4_000;
const SAFE_ENV_KEYS = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR"
]);

/**
 * Child processes never inherit credentials. Only the keys an interpreter needs to start are passed
 * through; a check's own `env` is filtered for credential-shaped names as well.
 */
export function filteredEnv(extra = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key)) safe[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (!/token|secret|passw|api[_-]?key|authorization|credential|cookie|session/i.test(key)) safe[key] = String(value);
  }
  safe.NO_COLOR = "1";
  return safe;
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function within(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function terms(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter(word => word.length >= 3)
    .slice(0, 12);
}

async function listTextFiles(root, maxFiles) {
  const found = [];
  async function walk(directory) {
    if (found.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

/**
 * Research over a repository snapshot. Every finding names a file, a line and a digest so a reader
 * can check it. Confidence is low when evidence is thin; an empty result is reported as empty rather
 * than padded with invented sources.
 */
export function createRepositoryResearchTransport({
  root,
  maxFiles = 250,
  maxFileBytes = 160_000,
  now = () => new Date().toISOString()
} = {}) {
  if (!root) throw new Error("The repository research transport needs a root directory.");

  async function research({ objective, query = null, signal = null } = {}) {
    if (signal?.aborted) return { ok: false, code: "aborted", summary: "Research was stopped before it read a file.", sources: [], confidence: 0, scanned: 0 };
    const wanted = terms(query || objective);
    const files = await listTextFiles(root, maxFiles);
    const scored = [];
    for (const file of files) {
      if (signal?.aborted) return { ok: false, code: "aborted", summary: "Research was stopped while scanning the repository.", sources: [], confidence: 0, scanned: files.length };
      let content;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > maxFileBytes) continue;
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      let score = 0;
      for (const term of wanted) {
        let index = lower.indexOf(term);
        while (index !== -1 && score < 200) {
          score += 1;
          index = lower.indexOf(term, index + term.length);
        }
      }
      if (score === 0) continue;
      const lines = content.split(/\r?\n/);
      let bestLine = 0;
      let bestHits = -1;
      for (const [index, line] of lines.entries()) {
        const lineLower = line.toLowerCase();
        const hits = wanted.reduce((count, term) => count + (lineLower.includes(term) ? 1 : 0), 0);
        if (hits > bestHits) { bestHits = hits; bestLine = index; }
      }
      scored.push({ file, score, lines, bestLine, content });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    const sources = top.map(item => {
      const relative = path.relative(root, item.file).split(path.sep).join("/");
      const start = Math.max(0, item.bestLine - 2);
      const excerpt = item.lines.slice(start, start + 5).join("\n").slice(0, 700);
      return {
        title: relative + "#L" + (item.bestLine + 1),
        url: "repo://" + relative + "#L" + (item.bestLine + 1),
        excerpt,
        digest: digest(item.content).slice(0, 32),
        retrievedAt: now()
      };
    });
    return {
      ok: true,
      summary: sources.length
        ? "Repository research matched " + sources.length + " file(s) for: " + (query || objective)
        : "No repository text matched: " + (query || objective) + ". This is a local repository search, not a web search.",
      sources,
      confidence: sources.length ? Math.min(0.85, 0.35 + sources.length * 0.1) : 0.15,
      scanned: files.length,
      limitations: [
        "Local repository snapshot only; no web access and no external verification.",
        "Citations are file paths and line numbers at retrieval time (" + now() + ")."
      ]
    };
  }

  research.kind = "repository";
  research.root = path.resolve(root);
  return research;
}

function runCommand({ command, args = [], cwd, timeoutMs = 60_000, env = {}, now, signal = null }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        env: filteredEnv(env),
        // Own process group on POSIX so a timeout can terminate grandchildren the check spawned.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: String(error?.message || error), durationMs: 0, timedOut: false });
      return;
    }
    const killTree = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      killTree();
    }, timeoutMs);
    const append = (current, chunk) => (current + chunk.toString()).slice(-MAX_OUTPUT_TAIL);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ exitCode: null, signal: null, stdout, stderr: append(stderr, String(error?.message || error)), durationMs: Date.now() - startedAt, timedOut: false, aborted });
    });
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode: typeof code === "number" ? code : null,
        signal: exitSignal || null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut: !aborted && (exitSignal === "SIGKILL" || Date.now() - startedAt >= timeoutMs),
        aborted,
        observedAt: now()
      });
    });
  });
}

/**
 * Engineering over a repository snapshot.
 *
 * `checks` are fixed `{ name, command, args, when? }` entries. `{file}` inside an argument is
 * replaced with the inspected relative path, but the command itself is never built from user input.
 * No write, network or deploy command belongs in this list.
 */
export function createRepositoryEngineeringTransport({
  root,
  checks = [],
  inspectPaths = [],
  maxFileBytes = 120_000,
  timeoutMs = 60_000,
  now = () => new Date().toISOString()
} = {}) {
  if (!root) throw new Error("The repository engineering transport needs a root directory.");
  const resolvedRoot = path.resolve(root);

  async function inspect(relativePath) {
    const requested = String(relativePath || "");
    const absolute = path.resolve(resolvedRoot, requested);
    if (!requested || !within(resolvedRoot, absolute)) throw new Error("inspect_outside_root");
    // Hidden files are refused after containment, so `..` reports the traversal it actually is.
    if (requested.split(/[\\/]/).some(part => part.startsWith("."))) {
      throw new Error("inspect_hidden_path");
    }
    // `path.resolve` is not enough: a symlink inside the root can point outside it. Refuse links
    // outright and verify the real path is still contained before reading.
    const linkInfo = await lstat(absolute);
    if (linkInfo.isSymbolicLink()) throw new Error("inspect_symlink");
    const real = await realpath(absolute);
    if (!within(resolvedRoot, real)) throw new Error("inspect_symlink_escape");
    const info = await stat(real);
    if (!info.isFile()) throw new Error("inspect_not_a_file");
    if (info.size > maxFileBytes) throw new Error("inspect_file_too_large");
    const content = await readFile(real, "utf8");
    const bounded = content;
    const lines = bounded.split(/\r?\n/);
    const markers = [];
    for (const [index, line] of lines.entries()) {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) markers.push({ line: index + 1, text: line.trim().slice(0, 160) });
      if (markers.length >= 10) break;
    }
    return {
      path: path.relative(resolvedRoot, absolute).split(path.sep).join("/"),
      bytes: Buffer.byteLength(bounded),
      lines: lines.length,
      digest: digest(bounded),
      markers,
      head: lines.slice(0, 12).join("\n").slice(0, 900)
    };
  }

  function candidatePaths(objective) {
    if (inspectPaths.length) return inspectPaths.slice(0, 6);
    const matches = String(objective || "").match(/[A-Za-z0-9_./-]+\.(?:mjs|js|json|md|sql|kt|xml|yml|yaml)/g) || [];
    return [...new Set(matches)].slice(0, 6);
  }

  async function run({ objective, signal = null } = {}) {
    if (signal?.aborted) {
      return { ok: false, summary: "Engineering was stopped before it inspected a file.", confidence: 0, files: [], commands: [], aborted: true, limitations: ["The operator stopped this agent before it returned."] };
    }
    const files = [];
    for (const candidate of candidatePaths(objective)) {
      try {
        files.push(await inspect(candidate));
      } catch (error) {
        files.push({ path: candidate, error: String(error?.message || error).slice(0, 120) });
      }
    }
    const commands = [];
    for (const check of checks.slice(0, 8)) {
      const file = files.find(item => item.digest && !item.error)?.path || null;
      if (check.when === "file" && !file) continue;
      const args = (Array.isArray(check.args) ? check.args : []).map(value => String(value).replace("{file}", file || ""));
      const result = await runCommand({ command: check.command, args, cwd: resolvedRoot, timeoutMs: check.timeoutMs || timeoutMs, env: check.env || {}, now, signal });
      commands.push({
        name: check.name || (check.command + " " + args.join(" ")).trim(),
        command: (check.command + " " + args.join(" ")).trim(),
        exitCode: result.exitCode,
        signal: result.signal || null,
        timedOut: result.timedOut === true,
        stdoutTail: result.stdout ? result.stdout.slice(-1_200) : "",
        stderrTail: result.stderr ? result.stderr.slice(-1_200) : "",
        aborted: result.aborted === true,
        durationMs: result.durationMs
      });
    }
    const inspected = files.filter(item => item.digest);
    const failed = commands.filter(item => item.exitCode !== 0);
    const aborted = commands.some(item => item.aborted === true) || signal?.aborted === true;
    return {
      ok: !aborted && inspected.length > 0 && failed.length === 0,
      aborted,
      summary: "Inspected " + inspected.length + " file(s); ran " + commands.length + " allowlisted check(s); " + failed.length + " failed.",
      confidence: inspected.length === 0 ? 0.2 : failed.length === 0 ? 0.9 : 0.5,
      files,
      commands,
      limitations: [
        "Read-only local snapshot: no file is modified and nothing is deployed.",
        "Only the checks configured by the caller can run; there is no shell path."
      ]
    };
  }

  run.kind = "repository";
  run.root = resolvedRoot;
  return run;
}

/**
 * Resolve transports from the environment. Off unless an explicit local root is configured, and
 * never able to run an arbitrary command: the checks below are the only ones mounted.
 */
export function resolveAgentTransports(env = process.env) {
  const root = String(env.AX_AGENT_LOCAL_ROOT || "").trim();
  const webEnabled = String(env.AX_WEB_RESEARCH_ENABLED || "").trim().toLowerCase() === "true";
  if (!root && !webEnabled) return { research: null, engineering: null, reason: "AX_AGENT_LOCAL_ROOT is not set" };
  const testFiles = String(env.AX_AGENT_LOCAL_TESTS || "")
    .split(",")
    .map(item => item.trim())
    .filter(item => /^tests\/[A-Za-z0-9._/-]+\.test\.mjs$/.test(item))
    .slice(0, 3);
  try {
    const web = webEnabled
      ? createWebResearchTransport({ allowLoopback: String(env.AX_WEB_RESEARCH_ALLOW_LOOPBACK || "").toLowerCase() === "true" })
      : null;
    if (!root) {
      return {
        research: web,
        engineering: null,
        root: null,
        checks: 0,
        web: true,
        reason: "AX_AGENT_LOCAL_ROOT is not set; web research is mounted without repository access"
      };
    }
    const repository = createRepositoryResearchTransport({ root });
    const checks = [
      { name: "syntax-check", command: process.execPath, args: ["--check", "{file}"], when: "file" },
      ...testFiles.map(file => ({
        name: "test:" + file,
        command: process.execPath,
        args: ["--test", file],
        timeoutMs: 120_000
      }))
    ];
    const engineering = createRepositoryEngineeringTransport({ root, checks });
    const research = web ? createCompositeResearchTransport({ repository, web }) : repository;
    return { research, engineering, root: path.resolve(root), checks: checks.length, web: Boolean(web) };
  } catch (error) {
    return { research: null, engineering: null, reason: String(error?.message || error).slice(0, 160) };
  }
}
