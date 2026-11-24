import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeCommandRefused,
  assertReadOnlyCommand,
  certificateFingerprint,
  parseDumpsysPackage,
  runReadOnlyDeviceCheck,
  verifyBridgeIdentity,
  EXPECTED_BRIDGE
} from "../scripts/bridge-identity-check.mjs";

const CERT_HEX = "a1b2c3d4e5f6";
const EXPECTED = Object.freeze({ ...EXPECTED_BRIDGE, certificateSha256: certificateFingerprint(CERT_HEX) });

const DUMPSYS = [
  "Packages:",
  "  Package [com.habitat.axbridge] (2f4a1c):",
  "    userId=10123",
  "    pkg=Package{8f1c2a3b com.habitat.axbridge}",
  "    codePath=/data/app/~~abc/com.habitat.axbridge-1/base.apk",
  "    versionCode=87 minSdk=26 targetSdk=35",
  "    versionName=0.8.7",
  "    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]",
  "    signatures=PackageSignatures{2f4a1c [" + CERT_HEX + "]}",
  ""
].join("\n");

test("parses package identity from dumpsys output", () => {
  const observed = parseDumpsysPackage(DUMPSYS);
  assert.equal(observed.packageName, "com.habitat.axbridge");
  assert.equal(observed.versionName, "0.8.7");
  assert.equal(observed.versionCode, 87);
  assert.equal(observed.minSdk, 26);
  assert.equal(observed.targetSdk, 35);
  assert.equal(observed.debuggable, true);
  assert.equal(observed.certificateSha256, EXPECTED.certificateSha256);
});

test("reports a matching identity and lists every mismatched field", () => {
  const observed = parseDumpsysPackage(DUMPSYS);
  const matches = verifyBridgeIdentity({ observed, expected: EXPECTED });
  assert.equal(matches.ok, true);
  assert.deepEqual(matches.mismatches, []);

  const older = verifyBridgeIdentity({ observed: { ...observed, versionName: "0.8.6", versionCode: 86 }, expected: EXPECTED });
  assert.equal(older.ok, false);
  assert.equal(older.verified, false);
  assert.deepEqual(older.mismatches.map(item => item.field), ["versionName", "versionCode"]);

  const differentKey = verifyBridgeIdentity({ observed, expected: { ...EXPECTED, certificateSha256: certificateFingerprint("ff00") } });
  assert.equal(differentKey.ok, false);
  assert.equal(differentKey.mismatches[0].field, "certificateSha256");
});

test("refuses every command that could change the device", () => {
  for (const argv of [
    ["adb", "install", "bridge.apk"],
    ["adb", "uninstall", "com.habitat.axbridge"],
    ["adb", "push", "a.apk", "/data/local/tmp/a.apk"],
    ["adb", "shell", "pm", "clear", "com.habitat.axbridge"],
    ["adb", "shell", "am", "force-stop", "com.habitat.axbridge"],
    ["adb", "shell", "input", "tap", "100", "200"],
    ["adb", "reboot"]
  ]) {
    assert.throws(() => assertReadOnlyCommand(argv), BridgeCommandRefused, argv.join(" "));
  }
  assert.equal(assertReadOnlyCommand(["adb", "devices"]), true);
  assert.equal(assertReadOnlyCommand(["adb", "-s", "emulator-5554", "shell", "dumpsys", "package", "com.habitat.axbridge"]), true);
});

test("runs only read commands and verifies the attached device", async () => {
  const seen = [];
  const run = argv => {
    seen.push(argv.join(" "));
    if (argv[1] === "devices") return "List of devices attached\nR58M12345\tdevice\n";
    return DUMPSYS;
  };
  const report = await runReadOnlyDeviceCheck({ run, expected: EXPECTED });
  assert.equal(report.ok, true);
  assert.equal(report.verified, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.deviceId, "R58M12345");
  assert.equal(report.commandsRun.length, 2);
  assert.equal(seen.some(command => /\b(install|uninstall|push|pm|am|input)\b/.test(command)), false);
});

test("reports missing adb and missing device as unverified, never as a pass", async () => {
  const noAdb = await runReadOnlyDeviceCheck({
    run: () => {
      const error = new Error("spawn adb ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    expected: EXPECTED
  });
  assert.equal(noAdb.ok, false);
  assert.equal(noAdb.verified, false);
  assert.equal(noAdb.code, "adb_unavailable");

  const noDevice = await runReadOnlyDeviceCheck({
    run: argv => (argv[1] === "devices" ? "List of devices attached\n" : ""),
    expected: EXPECTED
  });
  assert.equal(noDevice.ok, false);
  assert.equal(noDevice.code, "device_unavailable");
});

test("reports a version mismatch from the device instead of accepting it", async () => {
  const run = argv => (argv[1] === "devices"
    ? "List of devices attached\nR58M12345\tdevice\n"
    : DUMPSYS.replace("versionName=0.8.7", "versionName=0.8.6").replace("versionCode=87", "versionCode=86"));
  const report = await runReadOnlyDeviceCheck({ run, expected: EXPECTED });
  assert.equal(report.ok, false);
  assert.equal(report.code, "identity_mismatch");
  assert.deepEqual(report.mismatches.map(item => item.field), ["versionName", "versionCode"]);
});

test("a signature block without a same-line certificate yields no fingerprint", () => {
  // A greedy cross-line match would reach the bracket on the next line and hash the wrong value,
  // reporting a confidently wrong identity. The parser must return null instead.
  const text = [
    "Package [com.habitat.axbridge]",
    "    versionCode=87 minSdk=26 targetSdk=35",
    "    versionName=0.8.7",
    "    signatures=PackageSignatures{2f4a1c",
    "    later [deadbeef]"
  ].join("\n");
  const observed = parseDumpsysPackage(text);
  assert.equal(observed.certificateSha256, null);
});

test("a shell-like device id stays a single argv element and cannot inject a verb", async () => {
  const seen = [];
  const run = argv => {
    seen.push(argv);
    if (argv[1] === "devices") return "List of devices attached\nsemi;colon\tdevice\n";
    return DUMPSYS;
  };
  const report = await runReadOnlyDeviceCheck({ run, expected: EXPECTED, deviceId: "semi;colon" });
  assert.equal(report.readOnly, true);
  const dumpsys = seen[1];
  assert.deepEqual(dumpsys.slice(0, 3), ["adb", "-s", "semi;colon"]);
  assert.equal(dumpsys.length, 7);
  assert.equal(seen.every(argv => argv.every(token => !["install", "uninstall", "push", "reboot"].includes(String(token).toLowerCase()))), true);
});

test("getprop is allowed but settings and input are refused", () => {
  assert.equal(assertReadOnlyCommand(["adb", "-s", "X", "shell", "getprop", "ro.build.version.sdk"]), true);
  assert.throws(() => assertReadOnlyCommand(["adb", "shell", "settings", "put", "global", "a", "b"]), BridgeCommandRefused);
  assert.throws(() => assertReadOnlyCommand(["adb", "-s", "X", "shell", "input", "keyevent", "26"]), BridgeCommandRefused);
});
