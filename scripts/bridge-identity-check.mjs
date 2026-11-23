import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * P0: Bridge reconciliation without touching the phone.
 *
 * The installed device is the source of truth. This module reads its package identity with `adb
 * shell dumpsys package` and compares it to the release that was audited. It has no install, push,
 * uninstall, clear or re-sign path: every command is validated against an allowlist before it runs,
 * and anything that could change device state is refused outright.
 *
 * When `adb` is absent or no device is attached, the answer is `verified: false` with an explicit
 * code. "Could not check" is never reported as "matches".
 */

export const EXPECTED_BRIDGE = Object.freeze({
  packageName: "com.habitat.axbridge",
  versionName: "0.8.7",
  versionCode: 87,
  minSdk: 26,
  targetSdk: 35,
  certificateSha256: "50:8C:5A:3E:4B:48:12:CB:FB:CA:2C:68:5F:5D:36:9F:DE:55:B3:BF:D8:64:72:73:40:03:8B:59:D1:4B:24:7C",
  apkSha256: "c0c5c2188d3bd9c701d9c38676f06cbbb076c0ca427d592c81ea83b9b4058dd0",
  apkBytes: 926998
});

/** Verbs that change the device, its packages or its signing state. Never allowed here. */
export const FORBIDDEN_ADB_VERBS = Object.freeze([
  "install",
  "install-multiple",
  "uninstall",
  "push",
  "pull",
  "reinstall",
  "restore",
  "backup",
  "clear",
  "pm",
  "am",
  "cmd",
  "input",
  "screencap",
  "screenrecord",
  "uiautomator",
  "settings",
  "wm",
  "svc",
  "kill-server",
  "start-server",
  "root",
  "unroot",
  "remount",
  "reboot",
  "disable-verity",
  "enable-verity",
  "logcat",
  "bugreport",
  "sideload",
  "sign"
]);

/** The only two shell entry points this check may use: both read state. */
const ALLOWED_SHELL_ENTRYPOINTS = Object.freeze(["dumpsys", "getprop"]);

export class BridgeCommandRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeCommandRefused";
    this.code = "bridge_command_refused";
  }
}

/**
 * Throw unless the argv is a pure read. This runs before every command, including the first one, so
 * a future edit cannot quietly add a mutating call.
 */
export function assertReadOnlyCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new BridgeCommandRefused("An adb command needs an argument list.");
  if (String(argv[0]) !== "adb") throw new BridgeCommandRefused("Only the adb binary may be executed by this check.");
  const tokens = argv.slice(1).map(token => String(token).toLowerCase());
  for (const token of tokens) {
    if (FORBIDDEN_ADB_VERBS.includes(token)) {
      throw new BridgeCommandRefused("Refused adb argument \"" + token + "\": this check is read-only.");
    }
  }
  const shellIndex = tokens.indexOf("shell");
  if (shellIndex !== -1) {
    const entrypoint = tokens[shellIndex + 1];
    if (!ALLOWED_SHELL_ENTRYPOINTS.includes(entrypoint)) {
      throw new BridgeCommandRefused("Refused adb shell entrypoint \"" + String(entrypoint || "") + "\": only dumpsys and getprop are read-only.");
    }
  }
  return true;
}

function defaultRun(argv) {
  return execFileSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/** Format a certificate digest the way `keytool` and the release notes do. */
export function certificateFingerprint(hexValue) {
  const hex = String(hexValue || "").replace(/[^0-9a-fA-F]/g, "");
  if (!hex || hex.length % 2 !== 0) return null;
  const digest = createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
  return digest.toUpperCase().match(/.{2}/g).join(":");
}

/**
 * Parse `adb shell dumpsys package <pkg>`. Only fields that are actually printed are returned; a
 * missing field stays null so the comparison reports a mismatch instead of inventing a value.
 */
export function parseDumpsysPackage(text) {
  const body = String(text || "");
  const packageName = /Package\s+\[([^\]]+)\]/.exec(body)?.[1] ?? null;
  const versionName = /versionName=(\S+)/.exec(body)?.[1] ?? null;
  const versionCodeMatch = /versionCode=(\d+)(?:\s+minSdk=(\d+))?(?:\s+targetSdk=(\d+))?/.exec(body);
  const signatures = /signatures=PackageSignatures\{[^\[]*\[([0-9a-fA-F,]+)\]/.exec(body);
  const firstCertificate = signatures ? signatures[1].split(",")[0].trim() : "";
  return {
    packageName,
    versionName,
    versionCode: versionCodeMatch ? Number(versionCodeMatch[1]) : null,
    minSdk: versionCodeMatch?.[2] ? Number(versionCodeMatch[2]) : null,
    targetSdk: versionCodeMatch?.[3] ? Number(versionCodeMatch[3]) : null,
    debuggable: /\bDEBUGGABLE\b/.test(body),
    certificateSha256: certificateFingerprint(firstCertificate)
  };
}

/** Compare an observed package record to the expected Bridge release. */
export function verifyBridgeIdentity({ observed, expected = EXPECTED_BRIDGE } = {}) {
  const seen = observed && typeof observed === "object" ? observed : {};
  const want = expected && typeof expected === "object" ? expected : EXPECTED_BRIDGE;
  const fields = ["packageName", "versionName", "versionCode", "minSdk", "targetSdk", "certificateSha256"];
  const mismatches = [];
  for (const field of fields) {
    if (String(seen[field] ?? "") !== String(want[field] ?? "")) {
      mismatches.push({ field, expected: want[field] ?? null, actual: seen[field] ?? null });
    }
  }
  return {
    ok: mismatches.length === 0,
    verified: mismatches.length === 0,
    checked: fields,
    mismatches
  };
}

/** SHA-256 of a local file, streamed so a large APK is not held in memory. */
export async function hashFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

/** Verify a local APK artifact without unpacking, re-signing or installing it. */
export async function verifyApkFile(filePath, expected = EXPECTED_BRIDGE) {
  const info = await stat(filePath);
  const sha256 = await hashFile(filePath);
  const mismatches = [];
  if (Number(info.size) !== Number(expected.apkBytes)) {
    mismatches.push({ field: "apkBytes", expected: expected.apkBytes, actual: Number(info.size) });
  }
  if (sha256 !== expected.apkSha256) {
    mismatches.push({ field: "apkSha256", expected: expected.apkSha256, actual: sha256 });
  }
  return { ok: mismatches.length === 0, verified: mismatches.length === 0, file: path.basename(filePath), bytes: Number(info.size), sha256, mismatches };
}

function firstAttachedDevice(listing) {
  const lines = String(listing || "").split(/\r?\n/).slice(1);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1] === "device") return parts[0];
  }
  return null;
}

/**
 * Run the read-only device check.
 *
 * Every command is validated first. A missing adb, no attached device, or an adb error is reported
 * as `verified: false` with a code — never as a pass.
 */
export async function runReadOnlyDeviceCheck({
  run = defaultRun,
  deviceId = null,
  expected = EXPECTED_BRIDGE,
  apkPath = null
} = {}) {
  const commandsRun = [];
  const exec = argv => {
    assertReadOnlyCommand(argv);
    commandsRun.push(argv.join(" "));
    return run(argv);
  };

  let listing;
  try {
    listing = exec(["adb", "devices"]);
  } catch (error) {
    if (error instanceof BridgeCommandRefused) throw error;
    return {
      ok: false,
      verified: false,
      readOnly: true,
      code: "adb_unavailable",
      error: "adb could not be run in this environment; nothing was read and nothing was changed.",
      commandsRun
    };
  }

  const target = String(deviceId || "").trim() || firstAttachedDevice(listing);
  if (!target) {
    return {
      ok: false,
      verified: false,
      readOnly: true,
      code: "device_unavailable",
      error: "No authorised Android device is attached; the installed Bridge identity is unverified.",
      commandsRun
    };
  }

  let dump;
  try {
    dump = exec(["adb", "-s", target, "shell", "dumpsys", "package", expected.packageName]);
  } catch (error) {
    if (error instanceof BridgeCommandRefused) throw error;
    return {
      ok: false,
      verified: false,
      readOnly: true,
      code: "package_unreadable",
      error: "The Bridge package could not be read on this device; it may not be installed.",
      deviceId: target,
      commandsRun
    };
  }

  const observed = parseDumpsysPackage(dump);
  if (!observed.packageName) {
    return {
      ok: false,
      verified: false,
      readOnly: true,
      code: "package_not_found",
      error: "dumpsys returned no package record for " + expected.packageName + ".",
      deviceId: target,
      commandsRun
    };
  }

  const identity = verifyBridgeIdentity({ observed, expected });
  const apk = apkPath ? await verifyApkFile(apkPath, expected) : null;
  return {
    ok: identity.ok && (!apk || apk.ok),
    verified: identity.ok && (!apk || apk.ok),
    readOnly: true,
    code: identity.ok ? "identity_matches" : "identity_mismatch",
    deviceId: target,
    observed,
    expected,
    mismatches: identity.mismatches,
    apk,
    commandsRun,
    note: "Read-only. No install, uninstall, re-sign, pairing or version change was performed."
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const apkFlag = args.indexOf("--apk");
  const apkPath = apkFlag !== -1 ? args[apkFlag + 1] || null : null;
  const deviceFlag = args.indexOf("--device");
  const deviceId = deviceFlag !== -1 ? args[deviceFlag + 1] || null : null;
  const report = await runReadOnlyDeviceCheck({ apkPath, deviceId }).catch(error => ({
    ok: false,
    verified: false,
    readOnly: true,
    code: error?.code || "check_failed",
    error: String(error?.message || error)
  }));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
