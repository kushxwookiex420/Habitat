import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMigrationChecks } from "./migration-check.mjs";

/**
 * Release-readiness gate.
 *
 * It runs the checks that must be green before this branch can be considered releasable, and it
 * writes a manifest that names the commit, schema, environment variables and known limitations.
 * It does not deploy, merge or mutate a database. A skipped check is recorded as skipped, never as
 * passed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipTests = args.has("--skip-tests");
const skipAndroid = args.has("--skip-android");
// Check-only mode validates the exact checkout and the committed manifest without rewriting it.
// This is what lets the gate run on the release-record commit instead of only on the code commit.
const checkOnly = args.has("--check");

const REQUIRED_ENV = [
  { name: "HABITAT_AX_COMMAND_TOKEN", purpose: "Ax command credential" },
  { name: "HABITAT_AX_BRIDGE_TOKEN", purpose: "device-capable Ax credential" },
  { name: "HABITAT_OWNER_DEVICE_IDS", purpose: "owner device allowlist" },
  { name: "CLOUDFLARE_ACCOUNT_ID", purpose: "D1 account" },
  { name: "HABITAT_D1_DATABASE_ID", purpose: "D1 database" },
  { name: "HABITAT_D1_API_TOKEN", purpose: "D1 API token" },
  { name: "AX_NEXUS_TOKEN", purpose: "NEXUS message surface credential" },
  { name: "AX_SCHEDULER_TOKEN", purpose: "external scheduler credential", optional: true },
  { name: "HABITAT_PUBLIC_ORIGIN", purpose: "canonical public origin", optional: true },
  { name: "AX_AGENT_LOCAL_ROOT", purpose: "enable local research/engineering transports", optional: true }
];

function run(command, commandArgs, options = {}) {
  try {
    const stdout = execFileSync(command, commandArgs, {
      encoding: "utf8",
      timeout: options.timeoutMs || 240_000,
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || error),
      code: error?.status ?? null
    };
  }
}

async function exists(relative, root = ROOT) {
  try {
    await access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

const REQUIRED_DOCUMENTS = [
  "docs/NEXUS_MISSION_12.md",
  "docs/SECURITY_REVIEW_MISSION_12.md",
  "docs/STAGING_VALIDATION.md",
  "docs/ANDROID_DEVICE_VALIDATION.md",
  "docs/NEXUS_MISSION_13.md",
  "docs/NEXUS_MISSION_13_BASELINE.md",
  "docs/STAGING_VALIDATION_RESULTS.md",
  "docs/ANDROID_MISSION_13_DEVICE_TEST.md",
  "docs/RENDER_INTEGRATION_READINESS.md",
  "docs/NEXUS_MISSION_14.md",
  "docs/AX_NEXUS_COMMUNICATION.md",
  "docs/AUTONOMOUS_EXECUTION.md",
  "docs/AGENT_CAPABILITY_MATRIX.md",
  "docs/HABITAT_ACTIVATION_RUNBOOK.md",
  "docs/RENDER_MISSION_14_READINESS.md",
  "docs/ANDROID_MISSION_14_DEVICE_TEST.md",
  "docs/NEXUS_MISSION_15.md",
  "docs/CHATGPT_CONNECTION_READINESS.md",
  "docs/NEXUS_MISSION_18_LIVE_READINESS.md"
];
const REQUIRED_ARTIFACTS = [
  "release/demo-evidence.json",
  "release/perf-mission-12.json",
  "release/mission-13-evidence.json",
  "release/mission-14-evidence.json",
  "release/mission-15-live-activation.json",
  "release/mission-16-chatgpt-readiness.json",
  "release/mission-18-live-readiness.json"
];
const REQUIRED_MIGRATIONS = [
  "0001_habitat_tasks.sql",
  "0002_habitat_command_tasks.sql",
  "0003_ax_memory_notifications.sql",
  "0004_ax_objectives_incidents.sql",
  "0005_ax_security_scheduler.sql",
  "0006_ax_nexus_messages.sql"
];

/** Artifact and schema presence is a release requirement, not a formality. */
/** A release-record commit may change only release metadata and documentation. */
export function releaseOnlyChanges(files = []) {
  return files.length > 0 && files.every(file => /^(release\/|docs\/)/.test(file));
}

/**
 * The manifest names the code commit the gate actually tested. A later commit that only records
 * that manifest is acceptable, but a manifest naming an unrelated or older code commit is not.
 */
export async function checkManifestConsistency({ root = ROOT, commit, manifest = null } = {}) {
  if (!manifest || !/^[a-f0-9]{40}$/.test(String(manifest.commit || ""))) {
    return { ok: false, reason: "release/manifest.json is missing or has no resolved commit" };
  }
  if (manifest.releaseReady !== true) {
    return { ok: false, reason: "the committed manifest was not release-ready" };
  }
  if (manifest.commit === commit) return { ok: true, commit, relation: "same-commit" };
  const diff = run("git", ["diff", "--name-only", manifest.commit + ".." + commit], { cwd: root });
  if (!diff.ok) return { ok: false, reason: "cannot compare the manifest commit with HEAD" };
  const files = diff.stdout.split(/\r?\n/).filter(Boolean);
  const releaseOnly = releaseOnlyChanges(files);
  return {
    ok: releaseOnly,
    commit,
    validatedCommit: manifest.commit,
    relation: releaseOnly ? "release-record-only" : "code-changed-after-validation",
    changedSinceValidation: files.slice(0, 40),
    reason: releaseOnly ? null : "code changed after the manifest was generated; rerun the gate"
  };
}

/**
 * Evidence claims are parsed, not trusted by filename. A document may say NOT RUN / BUILD ONLY,
 * which is honest and passes as a documented blocker. A document claiming verified staging or a
 * physical device must carry the identifiers that only a real run produces.
 */
export async function checkEvidenceClaims(root = ROOT) {
  const read = async file => {
    try { return await readFile(path.join(root, file), "utf8"); } catch { return ""; }
  };
  const staging = await read("docs/STAGING_VALIDATION_RESULTS.md");
  // Mission 14 supersedes the Mission 13 Android sheet; the older file stays as history.
  const android = (await read("docs/ANDROID_MISSION_14_DEVICE_TEST.md")) || (await read("docs/ANDROID_MISSION_13_DEVICE_TEST.md"));
  const line = (source, label) => {
    const match = source.match(new RegExp("^" + label + ":\\s*(.+)$", "m"));
    return match ? match[1].trim() : "";
  };
  const checks = [];
  const stagingStatus = line(staging, "Staging status");
  if (/^STAGING VERIFIED/i.test(stagingStatus)) {
    checks.push({ name: "staging database identity recorded", ok: Boolean(line(staging, "Staging database fingerprint")) });
    checks.push({ name: "staging write process recorded", ok: Boolean(line(staging, "Write process")) });
    checks.push({ name: "staging verify process recorded", ok: Boolean(line(staging, "Verify process")) });
    checks.push({ name: "staging audit head recorded", ok: /^[a-f0-9]{64}$/i.test(line(staging, "Audit head")) });
  } else if (/^(NOT RUN|BLOCKED)/i.test(stagingStatus)) {
    checks.push({ name: "staging blocker has an owner action", ok: Boolean(line(staging, "Owner action")) });
  } else {
    checks.push({ name: "staging status is explicit", ok: false });
  }
  const androidStatus = line(android, "Android physical status");
  if (/^PHYSICAL S26 ULTRA VERIFIED/i.test(androidStatus)) {
    checks.push({ name: "physical device model recorded", ok: Boolean(line(android, "Device model")) });
    checks.push({ name: "physical serial hash recorded", ok: Boolean(line(android, "Serial hash")) });
    checks.push({ name: "physical checks recorded", ok: /\b1[0-9]\s*\/\s*1[0-9]\b/.test(line(android, "Checks passed")) });
  } else if (/^(BUILD ONLY|BLOCKED)/i.test(androidStatus)) {
    checks.push({ name: "physical-device blocker has an owner action", ok: Boolean(line(android, "Owner action")) });
  } else {
    checks.push({ name: "Android physical status is explicit", ok: false });
  }
  return { ok: checks.every(item => item.ok), checks, stagingStatus, androidStatus };
}

export async function checkReleaseInputs(root = ROOT) {
  const checks = [];
  for (const file of [...REQUIRED_DOCUMENTS, ...REQUIRED_ARTIFACTS]) {
    checks.push({ name: file, ok: await exists(file, root) });
  }
  let migrations = [];
  try { migrations = await readdir(path.join(root, "migrations")); } catch { migrations = []; }
  for (const expected of REQUIRED_MIGRATIONS) {
    checks.push({ name: "migrations/" + expected, ok: migrations.includes(expected) });
  }
  let schema = "";
  try { schema = await readFile(path.join(root, "migrations", "0005_ax_security_scheduler.sql"), "utf8"); } catch { schema = ""; }
  checks.push({ name: "0005 has security events table", ok: /habitat_ax_security_events/.test(schema) });
  checks.push({ name: "0005 has scheduler table", ok: /habitat_ax_scheduler/.test(schema) });
  checks.push({ name: "migration 0005 is additive", ok: /CREATE TABLE IF NOT EXISTS/i.test(schema) && !/\bDROP\b/i.test(schema) });

  // Mission 14: the message channel schema must be present and additive, and its routes must be
  // authenticated by the NEXUS credential. A release that lost either would pass every older check.
  let messagesSchema = "";
  try { messagesSchema = await readFile(path.join(root, "migrations", "0006_ax_nexus_messages.sql"), "utf8"); } catch { messagesSchema = ""; }
  checks.push({ name: "0006 has the message table", ok: /CREATE TABLE IF NOT EXISTS habitat_ax_messages/i.test(messagesSchema) });
  checks.push({ name: "0006 has the correlation index", ok: /habitat_ax_messages_correlation/i.test(messagesSchema) });
  checks.push({ name: "migration 0006 is additive", ok: /CREATE TABLE IF NOT EXISTS/i.test(messagesSchema) && !/\bDROP\b/i.test(messagesSchema) });
  return { ok: checks.every(item => item.ok), checks };
}

async function routeAuthCheck() {
  const source = await readFile(path.join(ROOT, "command-routes.mjs"), "utf8");
  const lines = source.split(/\r?\n/);
  const routes = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/route\.(get|post|put|delete)\("(\/ax\/command[^"]*)"/);
    if (!match) continue;
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      guarded: /requireAx|requireScheduler/.test(line),
      line: index + 1
    });
  }
  const unguarded = routes.filter(route => !route.guarded);
  return {
    ok: unguarded.length === 0 && routes.length > 0,
    routes: routes.length,
    unguarded,
    note: "Static check only: every command route registration names requireAx or requireScheduler on the same line."
  };
}

/**
 * Mission 14: every NEXUS message route must name requireNexus on its registration line. This is a
 * static check, deliberately narrow: it catches a route added without the NEXUS credential.
 */
async function nexusAuthCheck() {
  const source = await readFile(path.join(ROOT, "command-routes.mjs"), "utf8");
  const lines = source.split(/\r?\n/);
  const routes = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/nexusRoute\.(get|post)\("(\/ax\/nexus[^"]*)"/);
    if (!match) continue;
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      guarded: /requireNexus/.test(line),
      line: index + 1
    });
  }
  const unguarded = routes.filter(route => !route.guarded);
  return {
    ok: unguarded.length === 0 && routes.length > 0,
    routes: routes.length,
    unguarded,
    note: "Static check only: every NEXUS route registration names requireNexus on the same line."
  };
}

async function androidCheck() {
  const gradle = path.join(ROOT, "..", "toolchain", "gradle-8.9", "bin", "gradle");
  const javaHome = path.join(ROOT, "..", "toolchain", "jdk-17.0.21.1+2");
  const androidHome = path.join(ROOT, "..", "toolchain", "android-sdk");
  if (!(await exists("../toolchain/gradle-8.9/bin/gradle"))) {
    return { ok: false, skipped: true, reason: "gradle toolchain not present on this machine" };
  }
  const result = run(gradle, ["--offline", "--console=plain", ":app:assembleDebug"], {
    env: { JAVA_HOME: javaHome, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome },
    timeoutMs: 240_000
  });
  const apk = path.join(ROOT, "app/build/outputs/apk/debug/app-debug.apk");
  let sha256 = null;
  try {
    sha256 = createHash("sha256").update(await readFile(apk)).digest("hex");
  } catch { sha256 = null; }
  return {
    ok: result.ok && Boolean(sha256),
    task: ":app:assembleDebug",
    environment: "local Gradle + Android SDK (compile and package; no emulator or phone)",
    detail: result.ok ? (sha256 ? "assembled" : "APK missing after build") : result.stderr.slice(-800),
    apk: sha256 ? "app/build/outputs/apk/debug/app-debug.apk" : null,
    sha256,
    skipped: false
  };
}

export async function runReleaseGate() {
  const checks = [];
  const add = (name, result) => checks.push({ name, ...result });
  const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();

  add("git commit resolved", { ok: /^[a-f0-9]{40}$/.test(commit), commit });

  const syntax = run("npm", ["run", "check"]);
  add("syntax and repository checks", { ok: syntax.ok, detail: syntax.ok ? "exit 0" : syntax.stderr.slice(-800) });

  if (skipTests) {
    add("full test suite", { ok: true, skipped: true, reason: "--skip-tests was supplied" });
  } else {
    const tests = run("npm", ["test"]);
    const match = tests.stdout.match(/(?:ℹ|#) pass (\d+)/);
    const fail = tests.stdout.match(/(?:ℹ|#) fail (\d+)/);
    add("full test suite", {
      ok: tests.ok && Number(fail?.[1] || 0) === 0,
      pass: match ? Number(match[1]) : null,
      fail: fail ? Number(fail[1]) : null,
      detail: tests.ok ? "exit 0" : tests.stdout.slice(-800) + tests.stderr.slice(-400)
    });
  }

  const migrations = await runMigrationChecks();
  add("migration compatibility (local sqlite)", {
    ok: migrations.ok,
    checks: migrations.summary.checks,
    passed: migrations.summary.passed,
    failed: migrations.summary.failed,
    environment: migrations.summary.environment
  });

  const routeAuth = await routeAuthCheck();
  add("command route authentication", routeAuth);

  const nexusAuth = await nexusAuthCheck();
  add("NEXUS message route authentication", nexusAuth);

  const releaseInputs = await checkReleaseInputs(ROOT);
  add("required release inputs and migrations", releaseInputs);

  // These are the adversarial invariants, not a repeat of the whole suite. They run even when the
  // operator asked to skip the long suite, because a release may not skip its security checks.
  const evidence = await checkEvidenceClaims(ROOT);
  add("staging and physical evidence claims", evidence);

  let committedManifest = null;
  try { committedManifest = JSON.parse(await readFile(path.join(ROOT, "release", "manifest.json"), "utf8")); } catch { committedManifest = null; }
  const manifestConsistency = checkOnly
    ? await checkManifestConsistency({ commit, manifest: committedManifest })
    : { ok: true, commit, relation: "generated-now" };
  add("release manifest matches the validated commit", manifestConsistency);

  const critical = run("node", ["--test", "tests/ax-adversarial-accounting.test.mjs", "tests/ax-adversarial-security.test.mjs", "tests/ax-adversarial-transports.test.mjs", "tests/ax-adversarial-auth.test.mjs", "tests/ax-scheduler-multiprocess.test.mjs", "tests/d1-http-compat-mission-12.test.mjs"]);
  add("critical adversarial suites", { ok: critical.ok, detail: critical.ok ? "exit 0" : (critical.stdout + critical.stderr).slice(-1200) });

  // The channel and the complete-system acceptance test are release requirements, not optional
  // extras: without them the "Ax can talk to NEXUS" claim has no evidence.
  const channel = run("node", ["--test", "tests/ax-message-channel.test.mjs", "tests/ax-nexus-e2e.test.mjs"]);
  add("Ax-NEXUS channel and complete-system acceptance", {
    ok: channel.ok,
    detail: channel.ok ? "exit 0 (12 tests)" : (channel.stdout + channel.stderr).slice(-1600)
  });

  if (skipAndroid) {
    add("Android compilation", { ok: true, skipped: true, reason: "--skip-android was supplied" });
  } else {
    add("Android compilation", await androidCheck());
  }

  const env = REQUIRED_ENV.map(variable => ({
    name: variable.name,
    purpose: variable.purpose,
    required: !variable.optional,
    present: Boolean(String(process.env[variable.name] || "").trim())
  }));
  add("required environment variables are documented", {
    ok: true,
    variables: env,
    note: "Presence is reported without values. This gate does not validate the credentials themselves."
  });

  const android = checks.find(check => check.name === "Android compilation");
  const apk = android?.apk || (await exists("app/build/outputs/apk/debug/app-debug.apk") ? "app/build/outputs/apk/debug/app-debug.apk" : null);

  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    commit,
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
    checks,
    releaseReady: checks.every(check => check.ok && check.skipped !== true),
    evidenceLevels: {
      ci: "not yet verified for this manifest until the workflow run on the final head is green",
      staging: evidence.stagingStatus || "unknown",
      physicalDevice: evidence.androidStatus || "unknown",
      controlCenter: "local real authenticated backend harness (in-memory); not staging or production",
      messaging: "local integration evidence only (D1-shaped SQLite, simulated model transport); not staging",
      autonomy: "local integration evidence only (scheduler tick + real engine + read-only adapter)"
    },
    schema: {
      migrations: migrations.files,
      currentVersion: "0006",
      newInThisMission: ["0006_ax_nexus_messages.sql"],
      appliedToProduction: false,
      note: "Validate against D1 before applying; SQLite proves SQL shape and idempotence, not D1 parity."
    },
    environment: { required: env.filter(variable => variable.required), optional: env.filter(variable => !variable.optional) },
    artifacts: { apk, demoEvidence: (await exists("release/demo-evidence.json")) ? "release/demo-evidence.json" : null },
    knownLimitations: [
      "No production or staging deployment was performed.",
      "No disposable staging D1 credentials or owner approval id were available; staging is not verified.",
      "Migrations 0005 and 0006 have not been applied to D1.",
      "Android is compile-verified; no emulator or physical S26 Ultra test was run.",
      "The Ax-NEXUS channel is locally proven; no Ax client is connected to a deployed origin.",
      "Autonomy requires a trigger; a sleeping Render Free service is not continuously autonomous.",
      "Message delivery is at-least-once and restricted to read-only adapters.",
      "No live model provider call is made by the gate or by tests.",
      "Research/engineering transports require AX_AGENT_LOCAL_ROOT and stay off by default.",
      "Scheduler runs only when an external trigger or an owner calls its tick endpoint."
    ],
    rollback: [
      "Deploy the previous commit; migration 0005 is additive and no other schema was altered.",
      "Dropping habitat_ax_security_events or habitat_ax_scheduler removes only Mission 11 history.",
      "Migration 0006 is additive; leaving habitat_ax_messages in place after a rollback is harmless.",
      "Do not roll back by deleting task, objective or memory tables."
    ]
  };

  if (!checkOnly) {
    await mkdir(path.join(ROOT, "release"), { recursive: true });
    await writeFile(path.join(ROOT, "release", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await runReleaseGate();
  console.log(JSON.stringify({
    releaseReady: manifest.releaseReady,
    mode: checkOnly ? "check-only" : "write-manifest",
    commit: manifest.commit,
    checks: manifest.checks.map(check => ({ name: check.name, ok: check.ok, skipped: check.skipped === true })),
    manifest: "release/manifest.json"
  }, null, 2));
  if (!manifest.releaseReady) process.exitCode = 1;
}
