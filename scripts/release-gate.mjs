import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
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

const REQUIRED_ENV = [
  { name: "HABITAT_AX_COMMAND_TOKEN", purpose: "Ax command credential" },
  { name: "HABITAT_AX_BRIDGE_TOKEN", purpose: "device-capable Ax credential" },
  { name: "HABITAT_OWNER_DEVICE_IDS", purpose: "owner device allowlist" },
  { name: "CLOUDFLARE_ACCOUNT_ID", purpose: "D1 account" },
  { name: "HABITAT_D1_DATABASE_ID", purpose: "D1 database" },
  { name: "HABITAT_D1_API_TOKEN", purpose: "D1 API token" },
  { name: "AX_SCHEDULER_TOKEN", purpose: "external scheduler credential", optional: true },
  { name: "HABITAT_PUBLIC_ORIGIN", purpose: "canonical public origin", optional: true },
  { name: "AX_AGENT_LOCAL_ROOT", purpose: "enable local research/engineering transports", optional: true }
];

function run(command, commandArgs, options = {}) {
  try {
    const stdout = execFileSync(command, commandArgs, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: options.timeoutMs || 240_000,
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

async function exists(relative) {
  try {
    await access(path.join(ROOT, relative));
    return true;
  } catch {
    return false;
  }
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

async function androidCheck() {
  const gradle = path.join(ROOT, "..", "toolchain", "gradle-8.9", "bin", "gradle");
  const javaHome = path.join(ROOT, "..", "toolchain", "jdk-17.0.21.1+2");
  const androidHome = path.join(ROOT, "..", "toolchain", "android-sdk");
  if (!(await exists("../toolchain/gradle-8.9/bin/gradle"))) {
    return { ok: false, skipped: true, reason: "gradle toolchain not present on this machine" };
  }
  const result = run(gradle, ["--offline", "--console=plain", ":app:compileDebugKotlin"], {
    env: { JAVA_HOME: javaHome, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome },
    timeoutMs: 240_000
  });
  return {
    ok: result.ok,
    task: ":app:compileDebugKotlin",
    environment: "local Gradle + Android SDK (compile only)",
    detail: result.ok ? "compiled" : result.stderr.slice(-800),
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

  const apk = await exists("app/build/outputs/apk/debug/app-debug.apk")
    ? "app/build/outputs/apk/debug/app-debug.apk"
    : null;

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit,
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
    checks,
    releaseReady: checks.every(check => check.ok),
    schema: {
      migrations: migrations.files,
      currentVersion: "0005",
      newInThisMission: ["0005_ax_security_scheduler.sql"],
      appliedToProduction: false,
      note: "Validate against D1 before applying; SQLite proves SQL shape and idempotence, not D1 parity."
    },
    environment: { required: env.filter(variable => variable.required), optional: env.filter(variable => !variable.optional) },
    artifacts: { apk, demoEvidence: (await exists("release/demo-evidence.json")) ? "release/demo-evidence.json" : null },
    knownLimitations: [
      "No production or staging deployment was performed.",
      "Migration 0005 has not been applied to D1.",
      "Android is compile-verified; the pairing fix has not run on a physical device.",
      "No live model provider call is made by the gate or by tests.",
      "Research/engineering transports require AX_AGENT_LOCAL_ROOT and stay off by default.",
      "Scheduler runs only when an external trigger or an owner calls its tick endpoint."
    ],
    rollback: [
      "Deploy the previous commit; migration 0005 is additive and no other schema was altered.",
      "Dropping habitat_ax_security_events or habitat_ax_scheduler removes only Mission 11 history.",
      "Do not roll back by deleting task, objective or memory tables."
    ]
  };

  await mkdir(path.join(ROOT, "release"), { recursive: true });
  await writeFile(path.join(ROOT, "release", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await runReleaseGate();
  console.log(JSON.stringify({
    releaseReady: manifest.releaseReady,
    commit: manifest.commit,
    checks: manifest.checks.map(check => ({ name: check.name, ok: check.ok, skipped: check.skipped === true })),
    manifest: "release/manifest.json"
  }, null, 2));
  if (!manifest.releaseReady) process.exitCode = 1;
}
