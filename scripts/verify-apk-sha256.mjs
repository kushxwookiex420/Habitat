#!/usr/bin/env node
/**
 * Verify a release APK against its published SHA-256 before it is installed.
 *
 * This is deliberately dependency-free and offline: it reads the file, hashes it, and compares the
 * result with either an expected digest argument or a `.sha256` sidecar file. It never installs,
 * signs, or modifies anything.
 *
 * Usage:
 *   node scripts/verify-apk-sha256.mjs app.apk <expected-sha256>
 *   node scripts/verify-apk-sha256.mjs app.apk --sidecar app.apk.sha256
 *
 * Exit codes: 0 match, 1 mismatch, 2 unreadable/invalid input.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

export function normaliseDigest(value) {
  return String(value || "").trim().toLowerCase().replace(/^sha-?256[:=\s]+/i, "");
}

export async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Parse `<digest>  <filename>` or a bare digest. */
export function parseSidecar(text) {
  const first = String(text || "").trim().split(/\r?\n/)[0] || "";
  const match = first.match(/^([0-9a-f]{64})\b/i);
  return match ? match[1].toLowerCase() : "";
}

/** Pure comparison helper so the rules can be tested without the filesystem. */
export function verifyDigest(actual, expected) {
  const left = normaliseDigest(actual);
  const right = normaliseDigest(expected);
  if (!/^[0-9a-f]{64}$/.test(left)) return { ok: false, reason: "actual digest is not valid sha-256", actual: left, expected: right };
  if (!/^[0-9a-f]{64}$/.test(right)) return { ok: false, reason: "expected digest is not valid sha-256", actual: left, expected: right };
  return left === right
    ? { ok: true, actual: left, expected: right }
    : { ok: false, reason: "digest mismatch — do not install this artifact", actual: left, expected: right };
}

function parseArgs(argv) {
  const args = { file: null, expected: null, sidecar: null };
  const rest = [...argv];
  while (rest.length) {
    const token = rest.shift();
    if (token === "--sidecar") args.sidecar = rest.shift();
    else if (!args.file) args.file = token;
    else if (!args.expected) args.expected = token;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("usage: verify-apk-sha256.mjs <apk> <expected-sha256> | --sidecar <file>");
    process.exitCode = 2;
    return;
  }
  try {
    const info = await stat(args.file);
    if (!info.isFile() || info.size === 0) throw new Error("not a non-empty file");
    let expected = args.expected;
    if (!expected && args.sidecar) expected = parseSidecar(await readFile(args.sidecar, "utf8"));
    if (!expected) throw new Error("an expected digest or --sidecar is required");
    const result = verifyDigest(await sha256File(args.file), expected);
    console.log("file:     " + args.file);
    console.log("size:     " + info.size + " bytes");
    console.log("actual:   " + result.actual);
    console.log("expected: " + result.expected);
    console.log(result.ok ? "RESULT: PASS" : "RESULT: FAIL — " + result.reason);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error("verify-apk-sha256: " + String(error?.message || error));
    process.exitCode = 2;
  }
}

if (import.meta.url === "file://" + process.argv[1]) {
  main();
}
