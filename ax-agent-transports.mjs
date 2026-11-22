import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

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

  async function research({ objective, query = null } = {}) {
    const wanted = terms(query || objective);
    const files = await listTextFiles(root, maxFiles);
    const scored = [];
    for (const file of files) {
      let content;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (content.length > maxFileBytes) content = content.slice(0, maxFileBytes);
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

function runCommand({ command, args = [], cwd, timeoutMs = 60_000, env = {}, now }) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        env: { ...process.env, ...env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: String(error?.message || error), durationMs: 0, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    const append = (current, chunk) => (current + chunk.toString()).slice(-MAX_OUTPUT_TAIL);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stdout, stderr: append(stderr, String(error?.message || error)), durationMs: Date.now() - startedAt, timedOut: false });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === "number" ? code : null,
        signal: signal || null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut: signal === "SIGKILL" || Date.now() - startedAt >= timeoutMs,
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
    const absolute = path.resolve(resolvedRoot, relativePath);
    if (!within(resolvedRoot, absolute)) throw new Error("inspect_outside_root");
    const content = await readFile(absolute, "utf8");
    const bounded = content.slice(0, maxFileBytes);
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

  async function run({ objective } = {}) {
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
      const result = await runCommand({ command: check.command, args, cwd: resolvedRoot, timeoutMs: check.timeoutMs || timeoutMs, now });
      commands.push({
        name: check.name || (check.command + " " + args.join(" ")).trim(),
        command: (check.command + " " + args.join(" ")).trim(),
        exitCode: result.exitCode,
        signal: result.signal || null,
        timedOut: result.timedOut === true,
        stdoutTail: result.stdout ? result.stdout.slice(-1_200) : "",
        stderrTail: result.stderr ? result.stderr.slice(-1_200) : "",
        durationMs: result.durationMs
      });
    }
    const inspected = files.filter(item => item.digest);
    const failed = commands.filter(item => item.exitCode !== 0);
    return {
      ok: inspected.length > 0 && failed.length === 0,
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
  if (!root) return { research: null, engineering: null, reason: "AX_AGENT_LOCAL_ROOT is not set" };
  const testFiles = String(env.AX_AGENT_LOCAL_TESTS || "")
    .split(",")
    .map(item => item.trim())
    .filter(item => /^tests\/[A-Za-z0-9._/-]+\.test\.mjs$/.test(item))
    .slice(0, 3);
  try {
    const research = createRepositoryResearchTransport({ root });
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
    return { research, engineering, root: path.resolve(root), checks: checks.length };
  } catch (error) {
    return { research: null, engineering: null, reason: String(error?.message || error).slice(0, 160) };
  }
}
