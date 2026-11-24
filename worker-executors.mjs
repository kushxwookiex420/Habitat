import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Real worker executors.
 *
 * Every executor here performs actual work in this process: it reads real files, runs a real test
 * command, recomputes real arithmetic, or writes a real artifact. None of them fabricate a result, and
 * none of them is a language model — the "intelligence" that chooses the job lives in Ax; these are the
 * hands.
 *
 * Jobs are supplied by task id (`jobs[taskId]`) because the workforce store and the command-task store
 * are separate records: an assignment carries the task, not its payload. A deployment wires this map
 * from the command task's `input`; the demo wires it explicitly.
 *
 * Contract with `createWorkforceRunner`:
 *   executor({ taskId, assignment, agent })            -> { result: { status, evidence, changedFiles, tests } }
 *   executor({ taskId, assignment, agent, implementation }) -> { ok, evidence, tests }   (verifier)
 *
 * The verifier is a separate agent with the `verification` capability and it re-derives the evidence
 * independently — recomputation for deterministic jobs, a second real test run for test jobs. It never
 * copies the executor's word for it.
 */

export const EXECUTOR_LIMITS = Object.freeze({
  maxFiles: 400,
  maxFileBytes: 256_000,
  maxEvidence: 8,
  testTimeoutMs: 120_000,
  maxOutputBytes: 16_000,
  maxArtifactBytes: 40_000,
  maxCorpusFiles: 120
});

const sha = (value) => createHash("sha256").update(value).digest("hex");
const clean = (value, max = 300) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function failure(code, detail, extra = {}) {
  return { status: "failed", evidence: ["refused:" + code + (detail ? "@" + clean(detail, 120) : "")], changedFiles: [], tests: { ran: 0, passed: 0, failed: 0 }, code, ...extra };
}

function blocked(code, detail) {
  return { status: "blocked", evidence: ["blocked:" + code + (detail ? "@" + clean(detail, 120) : "")], changedFiles: [], tests: { ran: 0, passed: 0, failed: 0 }, code };
}

async function contained(rootDir, relative) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, String(relative || "."));
  if (target !== root && !target.startsWith(root + path.sep)) return { ok: false };
  if (/(^|\/)(\.git|node_modules|\.env)(\/|$)/.test(String(relative || ""))) return { ok: false };
  return { ok: true, root, target };
}

async function walk(rootDir, target, { maxFiles = EXECUTOR_LIMITS.maxFiles } = {}) {
  const files = [];
  const queue = [target];
  while (queue.length && files.length < maxFiles) {
    const current = await contained(rootDir, queue.shift());
    if (!current.ok) continue;
    let entries;
    try { entries = await readdir(current.target, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = path.join(current.target, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile()) files.push(child);
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

async function readBounded(file) {
  const info = await stat(file);
  if (info.size > EXECUTOR_LIMITS.maxFileBytes) return null;
  return readFile(file, "utf8");
}

/** Run one allowlisted test file with the real runner and parse its own summary. */
function runTestFile(file, { rootDir, timeoutMs = EXECUTOR_LIMITS.testTimeoutMs } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A nested `node --test` inherits the outer runner's context and then reports through it instead of
    // printing its own summary. Strip that context so the child behaves like a standalone test run.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === "NODE_OPTIONS" || key === "NODE_V8_COVERAGE" || key.startsWith("NODE_TEST")) delete env[key];
    }
    // Force the spec reporter: Node defaults to TAP when stdout is not a TTY (CI), and the summary
    // format must not depend on the host.
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", file], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const cap = (chunk) => chunk.toString().slice(0, EXECUTOR_LIMITS.maxOutputBytes);
    child.stdout.on("data", (chunk) => { if (stdout.length < EXECUTOR_LIMITS.maxOutputBytes) stdout += cap(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < EXECUTOR_LIMITS.maxOutputBytes) stderr += cap(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      // Accept both reporter shapes, so an unexpected fallback cannot look like "ran nothing".
      const count = (label) => {
        const match = new RegExp("^(?:\u2139|#) " + label + " (\\d+)$", "m").exec(stdout);
        return Number(match ? match[1] : 0);
      };
      const pass = count("pass");
      const fail = count("fail");
      resolve({
        code, signal, durationMs, stdout, stderr,
        ran: pass + fail,
        passed: pass,
        failed: fail,
        timedOut: signal === "SIGKILL"
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, durationMs: Date.now() - started, stdout, stderr: String(error?.message || error), ran: 0, passed: 0, failed: 1, timedOut: false });
    });
  });
}

/* ------------------------------------------------------------------ jobs */

async function repoAnalysis(job, { rootDir }) {
  const dirs = Array.isArray(job?.dirs) && job.dirs.length ? job.dirs : ["."];
  const files = [];
  for (const dir of dirs) {
    const resolved = await contained(rootDir, dir);
    if (!resolved.ok) return failure("path_outside_root", dir);
    files.push(...await walk(rootDir, dir));
  }
  const unique = [...new Set(files)].slice(0, EXECUTOR_LIMITS.maxFiles);
  if (unique.length === 0) return blocked("nothing_to_analyze", dirs.join(","));

  let bytes = 0;
  let markers = 0;
  const digests = [];
  for (const file of unique) {
    const content = await readBounded(file);
    if (content === null) continue;
    bytes += Buffer.byteLength(content);
    markers += (content.match(/\b(TODO|FIXME|HACK)\b/g) || []).length;
    digests.push(path.relative(rootDir, file) + ":" + sha(content).slice(0, 12));
  }
  return {
    status: "completed",
    evidence: [
      "eng.files=" + unique.length,
      "eng.bytes=" + bytes,
      "eng.markers=" + markers,
      "eng.tree_sha256=" + sha(digests.sort().join("\n"))
    ],
    changedFiles: [],
    tests: { ran: 0, passed: 0, failed: 0 },
    data: { files: unique.length, bytes, markers }
  };
}

async function syntaxCheck(job, { rootDir }) {
  const resolved = await contained(rootDir, job?.file);
  if (!resolved.ok) return failure("path_outside_root", job?.file);
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", resolved.target], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < EXECUTOR_LIMITS.maxOutputBytes) stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stderr }));
    child.on("error", (error) => resolve({ code: null, stderr: String(error?.message || error) }));
  });
  const ok = run.code === 0;
  return {
    status: ok ? "completed" : "failed",
    evidence: ["eng.syntax=" + (ok ? "ok" : "failed") + "@exit=" + run.code + "@file=" + clean(job.file, 120) + (ok ? "" : "@stderr_sha256=" + sha(run.stderr).slice(0, 12))],
    changedFiles: [],
    tests: { ran: 0, passed: 0, failed: 0 },
    data: { ok, exit: run.code }
  };
}

async function tests(job, { rootDir, testsDir }) {
  const relative = String(job?.file || "").trim();
  if (!/^tests\/[A-Za-z0-9._/-]+\.test\.mjs$/.test(relative) && !/^scripts\/[A-Za-z0-9._/-]+\.mjs$/.test(relative)) {
    return failure("test_not_allowlisted", relative);
  }
  const resolved = await contained(rootDir, relative);
  if (!resolved.ok) return failure("path_outside_root", relative);
  const run = await runTestFile(resolved.target, { rootDir });
  const ok = run.code === 0 && run.failed === 0 && run.ran > 0;
  return {
    status: ok ? "completed" : "failed",
    evidence: [
      "qa.test=" + relative,
      // Duration is recorded in `data`, never in evidence: a timing that changes every run would make
      // an honest verifier reject a correct result.
      "qa.exit=" + run.code + "@signal=" + (run.signal || "none"),
      "qa.counts=ran:" + run.ran + ",pass:" + run.passed + ",fail:" + run.failed,
      // The reporter prints per-test durations, so hashing raw stdout would differ between two runs of
      // the same passing suite and defeat independent verification. Hash the outcome instead.
      "qa.summary_sha256=" + sha(relative + "|exit=" + run.code + "|pass=" + run.passed + "|fail=" + run.failed).slice(0, 16)
    ],
    changedFiles: [],
    tests: { ran: run.ran, passed: run.passed, failed: run.failed },
    // Volatile readings (durations, reporter byte counts) live in `data`, never in evidence.
    data: { file: relative, exit: run.code, timedOut: run.timedOut, durationMs: run.durationMs, outputBytes: [Buffer.byteLength(run.stdout), Buffer.byteLength(run.stderr)], root: testsDir ? path.relative(rootDir, testsDir) : null }
  };
}

async function corpusSearch(job, { rootDir }) {
  const query = clean(job?.query, 80);
  if (!query) return failure("query_required");
  const dirs = Array.isArray(job?.dirs) && job.dirs.length ? job.dirs : ["docs"];
  const files = [];
  for (const dir of dirs) {
    const resolved = await contained(rootDir, dir);
    if (!resolved.ok) return failure("path_outside_root", dir);
    files.push(...await walk(rootDir, dir, { maxFiles: EXECUTOR_LIMITS.maxCorpusFiles }));
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const hits = [];
  for (const file of files) {
    const content = await readBounded(file);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) hits.push({ file: path.relative(rootDir, file), line: index + 1, text: clean(lines[index], 160) });
    }
  }
  const byFile = new Map();
  for (const hit of hits) byFile.set(hit.file, (byFile.get(hit.file) || 0) + 1);
  const ranked = [...byFile.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 5);
  return {
    status: hits.length ? "completed" : "blocked",
    evidence: [
      "research.query=" + query,
      "research.files_scanned=" + files.length,
      "research.hits=" + hits.length,
      "research.top=" + (ranked.map(([file, count]) => file + "(" + count + ")").join(",") || "none"),
      "research.digest=" + sha(hits.map((hit) => hit.file + ":" + hit.line).join("\n")).slice(0, 16)
    ],
    changedFiles: [],
    tests: { ran: 0, passed: 0, failed: 0 },
    data: { query, hits: hits.slice(0, 10), total: hits.length, scanned: files.length }
  };
}

export function computeEconomics(items = [], { fixedCostCents = 0, targetMarginBps = 3000 } = {}) {
  const rows = (Array.isArray(items) ? items : []).slice(0, 100).map((item) => {
    const priceCents = Math.max(0, Math.round(Number(item?.priceCents) || 0));
    const costCents = Math.max(0, Math.round(Number(item?.costCents) || 0));
    const feeBps = Math.max(0, Math.min(10_000, Math.round(Number(item?.feeBps) || 0)));
    const shippingCents = Math.max(0, Math.round(Number(item?.shippingCents) || 0));
    const fees = Math.round(priceCents * feeBps / 10_000);
    const contributionCents = priceCents - costCents - fees - shippingCents;
    const marginBps = priceCents > 0 ? Math.round(contributionCents / priceCents * 10_000) : 0;
    return {
      sku: clean(item?.sku, 60) || "unnamed",
      priceCents, costCents, fees, shippingCents, contributionCents, marginBps,
      belowTarget: marginBps < targetMarginBps,
      breakEvenUnits: contributionCents > 0 ? Math.ceil(fixedCostCents / contributionCents) : null
    };
  });
  return {
    rows,
    totals: {
      items: rows.length,
      contributionCents: rows.reduce((sum, row) => sum + row.contributionCents, 0),
      belowTarget: rows.filter((row) => row.belowTarget).length
    }
  };
}

async function economics(job) {
  const { rows, totals } = computeEconomics(job?.items, {
    fixedCostCents: job?.fixedCostCents,
    targetMarginBps: job?.targetMarginBps
  });
  if (rows.length === 0) return failure("economics_no_items");
  return {
    status: "completed",
    evidence: [
      "biz.items=" + totals.items,
      "biz.contribution_cents=" + totals.contributionCents,
      "biz.below_target=" + totals.belowTarget,
      "biz.digest=" + sha(JSON.stringify(rows)).slice(0, 16)
    ],
    changedFiles: [],
    tests: { ran: 0, passed: 0, failed: 0 },
    data: { rows: rows.slice(0, 10), totals }
  };
}

async function contentBrief(job, { artifactsDir, rootDir }) {
  const title = clean(job?.title, 160);
  if (!title) return failure("title_required");
  const lines = ["# " + title, "", "Generated by the content worker from recorded evidence; no model was consulted.", ""];
  for (const section of (Array.isArray(job?.sections) ? job.sections : []).slice(0, 20)) {
    const heading = clean(section?.heading, 120) || "Section";
    lines.push("## " + heading, "");
    for (const bullet of (Array.isArray(section?.bullets) ? section.bullets : []).slice(0, 20)) {
      lines.push("- " + clean(bullet, 400));
    }
    lines.push("");
  }
  const body = lines.join("\n").slice(0, EXECUTOR_LIMITS.maxArtifactBytes);
  const name = String(job?.taskId || title).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 60) || "brief";
  const target = path.join(artifactsDir, name + ".md");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(target, body, "utf8");
  return {
    status: "completed",
    evidence: ["content.file=" + path.relative(rootDir, target), "content.bytes=" + Buffer.byteLength(body), "content.sha256=" + sha(body).slice(0, 16)],
    changedFiles: [path.relative(rootDir, target)],
    tests: { ran: 0, passed: 0, failed: 0 },
    data: { path: path.relative(rootDir, target) }
  };
}

async function opsSnapshot(job, { health }) {
  if (typeof health !== "function") return blocked("health_provider_missing");
  const snapshot = await health();
  if (!snapshot || typeof snapshot !== "object") return blocked("health_provider_empty");
  const checks = snapshot.checks && typeof snapshot.checks === "object" ? snapshot.checks : {};
  const names = Object.keys(checks).sort();
  const failing = names.filter((name) => checks[name] !== true);
  return {
    status: failing.length ? "blocked" : "completed",
    evidence: [
      "ops.status=" + clean(snapshot.status, 40),
      "ops.checks=" + names.length + ",failing:" + failing.length,
      "ops.failing=" + (failing.join(",") || "none"),
      "ops.digest=" + sha(names.map((name) => name + "=" + checks[name]).join("\n")).slice(0, 16)
    ],
    changedFiles: [],
    tests: { ran: 0, passed: 0, failed: 0 },
    data: { status: snapshot.status, failing }
  };
}

/* -------------------------------------------------------------- executors */

export const WORKER_SPECS = Object.freeze([
  Object.freeze({ agentId: "worker-engineering", adapterId: "eng.repo", specialty: "engineering", capabilities: ["engineering", "repo_analysis"] }),
  Object.freeze({ agentId: "worker-qa", adapterId: "qa.tests", specialty: "testing", capabilities: ["testing", "test_execution"] }),
  Object.freeze({ agentId: "worker-research", adapterId: "research.corpus", specialty: "research", capabilities: ["research", "corpus_search"] }),
  Object.freeze({ agentId: "worker-business", adapterId: "biz.economics", specialty: "business", capabilities: ["business", "economics"] }),
  Object.freeze({ agentId: "worker-content", adapterId: "content.brief", specialty: "content", capabilities: ["content", "authoring"] }),
  Object.freeze({ agentId: "worker-operations", adapterId: "ops.snapshot", specialty: "operations", capabilities: ["operations", "monitoring"] }),
  Object.freeze({ agentId: "worker-verifier", adapterId: "verifier.recompute", specialty: "verification", capabilities: ["verification"] })
]);

/** Adapter kinds the workforce registry accepts, per adapter. */
export const WORKER_ADAPTER_KINDS = Object.freeze({
  "eng.repo": "coding",
  "qa.tests": "analysis",
  "research.corpus": "research",
  "biz.economics": "analysis",
  "content.brief": "content",
  "ops.snapshot": "analysis",
  "verifier.recompute": "verification"
});

export const EXECUTOR_ADAPTERS = Object.freeze([
  Object.freeze({ id: "eng.repo", kind: "in_process" }),
  Object.freeze({ id: "qa.tests", kind: "in_process" }),
  Object.freeze({ id: "research.corpus", kind: "in_process" }),
  Object.freeze({ id: "biz.economics", kind: "in_process" }),
  Object.freeze({ id: "content.brief", kind: "in_process" }),
  Object.freeze({ id: "ops.snapshot", kind: "in_process" }),
  Object.freeze({ id: "verifier.recompute", kind: "in_process" })
]);

/**
 * Build the executor map and the job-derived verification.
 *
 * @param {object} options
 * @param {string} options.rootDir        repository root; all reads are contained by it
 * @param {string} options.artifactsDir   where content briefs are written (inside rootDir)
 * @param {object} [options.jobs]         taskId -> job description
 * @param {Function} [options.health]     () => { status, checks } for the operations worker
 */
export function createWorkerExecutors({ rootDir, artifactsDir, jobs = {}, health = null, log = console } = {}) {
  if (typeof rootDir !== "string" || !rootDir.trim()) throw new Error("createWorkerExecutors needs rootDir.");
  const artifacts = path.resolve(rootDir, artifactsDir || "artifacts");
  if (!artifacts.startsWith(path.resolve(rootDir) + path.sep)) throw new Error("artifactsDir must be inside rootDir.");
  const testsDir = path.resolve(rootDir, "tests");
  const context = { rootDir: path.resolve(rootDir), artifactsDir: artifacts, testsDir, health };

  const jobFor = (taskId) => jobs[taskId] || null;

  async function compute(job) {
    switch (job?.kind) {
      case "repo-analysis": return repoAnalysis(job, context);
      case "syntax-check": return syntaxCheck(job, context);
      case "tests": return tests(job, context);
      case "corpus-search": return corpusSearch(job, context);
      case "economics": return economics(job, context);
      case "brief": return contentBrief(job, context);
      case "ops-snapshot": return opsSnapshot(job, context);
      default: return failure("unknown_job_kind", job?.kind || "none");
    }
  }

  async function run({ taskId }) {
    const job = jobFor(taskId);
    if (!job) return { result: blocked("job_not_supplied", taskId) };
    try {
      const outcome = await compute({ ...job, taskId });
      return { result: outcome, jobKind: job.kind };
    } catch (error) {
      log.error?.("WORKER_EXECUTOR_ERROR", clean(error?.message, 160));
      return { result: failure("executor_error", error?.message || String(error)) };
    }
  }

  /**
   * Independent verification: a different agent recomputes the same work. For test jobs that is a second
   * real test run; for deterministic jobs it is a second computation whose evidence must match. The check
   * count is reported as a test, because the workforce registry refuses a verification that ran nothing.
   */
  async function verifyJob(job, { taskId, implementation }) {
    if (!job) return { ok: false, evidence: ["verifier:job_not_supplied"], tests: { ran: 0, passed: 0, failed: 0 } };
    const claimed = implementation?.result || {};
    const again = await compute({ ...job, taskId });
    if (claimed.status !== "completed") {
      // Confirm the failure is reproducible rather than trusting the executor's word for it.
      const confirmed = again.status === claimed.status;
      return {
        ok: false,
        evidence: [
          "verifier:implementation_status=" + clean(claimed.status, 20),
          "verifier:reproduced=" + confirmed,
          "verifier:second_run_code=" + clean(again.code || "none", 60)
        ],
        tests: { ran: 1, passed: confirmed ? 1 : 0, failed: confirmed ? 1 : 0 }
      };
    }
    const expected = Array.isArray(claimed.evidence) ? claimed.evidence.filter((line) => !/^blocked:/.test(line)) : [];
    const actual = Array.isArray(again.evidence) ? again.evidence : [];
    const stable = expected.length > 0 && actual.length > 0 && expected.join("\n") === actual.join("\n");
    const filesOk = await Promise.all((claimed.changedFiles || []).map(async (file) => {
      const resolved = await contained(context.rootDir, file);
      if (!resolved.ok) return "uncontained:" + file;
      try {
        const content = await readFile(resolved.target, "utf8");
        const digest = "content.sha256=" + sha(content).slice(0, 16);
        return expected.includes(digest) ? null : "hash_mismatch:" + file;
      } catch {
        return "missing:" + file;
      }
    }));
    const fileFailures = filesOk.filter(Boolean);
    const testsOk = job.kind !== "tests" || (claimed.tests?.ran > 0 && claimed.tests.passed + claimed.tests.failed === claimed.tests.ran);
    const ok = stable && fileFailures.length === 0 && testsOk;
    return {
      ok,
      evidence: [
        "verifier:recomputed=true",
        "verifier:evidence_match=" + stable,
        "verifier:artifacts_checked=" + (claimed.changedFiles || []).length,
        ...(fileFailures.length ? ["verifier:artifact_failures=" + fileFailures.join(",")] : []),
        "verifier:tests_consistent=" + testsOk,
        "verifier:second_run_status=" + clean(again.status, 20)
      ],
      // One executed verification check, with its own outcome. Test jobs additionally carry the real
      // second-run counts so a reviewer can see the suite was executed twice.
      tests: { ran: Math.max(1, Number(again.tests?.ran) || 0), passed: ok ? Math.max(1, Number(again.tests?.passed) || 0) : 0, failed: ok ? 0 : Math.max(1, Number(again.tests?.failed) || 0) }
    };
  }

  async function verify({ taskId, implementation }) {
    return verifyJob(jobFor(taskId), { taskId, implementation });
  }

  return Object.freeze({
    executors: Object.freeze({
      "eng.repo": run,
      "qa.tests": run,
      "research.corpus": run,
      "biz.economics": run,
      "content.brief": run,
      "ops.snapshot": run,
      "verifier.recompute": verify
    }),
    compute,
    verify,
    verifyJob,
    jobFor
  });
}
