#!/usr/bin/env node
/**
 * Print the SHA-256 fingerprint of an APK's signing certificate, without a JDK.
 *
 * Why this exists: comparing an APK's certificate with the one installed on a phone is the
 * precondition for `adb install -r`. `keytool` and `apksigner` are not always available (they are
 * not available in the development workspace), and a debug build signed with the v2 scheme carries no
 * `META-INF/*.RSA` to inspect, so the certificate has to come out of the APK Signing Block.
 *
 * Only scheme v2 (block id 0x71098 71a) is parsed. If an APK is v1-only or v3-only this exits 3 and
 * says so rather than printing a fingerprint it did not verify.
 *
 * Usage: node scripts/apk-cert-fingerprint.mjs app-debug.apk
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const V2_BLOCK_ID = 0x7109871a;
const MAGIC = Buffer.from("APK Sig Block 42", "utf8");

function parse(buffer) {
  // The End of Central Directory record sits at the very end, before an optional comment (max 64 KiB).
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  const magicAt = centralDirectoryOffset - 16;
  if (magicAt < 0 || !buffer.subarray(magicAt, magicAt + 16).equals(MAGIC)) {
    throw new Error("no APK Signing Block (the APK is not v2-signed)");
  }
  // The size field appears twice (before the pairs and just before the magic) and both copies count
  // the pairs plus the trailing size field plus the 16-byte magic: size = pairs + 8 + 16.
  const blockSize = Number(buffer.readBigUInt64LE(magicAt - 8));
  const blockStart = magicAt + 8 - blockSize;
  if (blockStart < 0) throw new Error("APK Signing Block is malformed");

  let cursor = blockStart + 8; // skip the leading size field
  const end = magicAt - 8;
  while (cursor + 12 <= end) {
    const length = Number(buffer.readBigUInt64LE(cursor));
    const id = buffer.readUInt32LE(cursor + 8);
    const valueStart = cursor + 12;
    const valueEnd = valueStart + length - 4;
    if (valueEnd > end) throw new Error("APK Signing Block entry overruns the block");
    if (id === V2_BLOCK_ID) return buffer.subarray(valueStart, valueEnd);
    cursor = valueStart + (length - 4);
  }
  throw new Error("no v2 signature block (the APK may be v1- or v3-signed only)");
}

function readLengthPrefixed(buffer, offset) {
  const length = buffer.readUInt32LE(offset);
  return { value: buffer.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length };
}

function firstCertificate(v2) {
  // v2 value: signers (length-prefixed sequence) -> signer -> signed data -> digests, certificates.
  const signers = readLengthPrefixed(v2, 0).value;
  const signer = readLengthPrefixed(signers, 0).value;
  const signedData = readLengthPrefixed(signer, 0).value;
  const digests = readLengthPrefixed(signedData, 0);
  const certificates = readLengthPrefixed(signedData, digests.next);
  // certificates is a length-prefixed sequence of DER certificates.
  const sequence = readLengthPrefixed(certificates.value, 0);
  if (sequence.value.length === 0) throw new Error("v2 block lists no certificate");
  return sequence.value;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apk-cert-fingerprint.mjs <apk>");
  process.exitCode = 2;
} else {
  try {
    const certificate = firstCertificate(parse(readFileSync(file)));
    const digest = createHash("sha256").update(certificate).digest("hex");
    console.log("certificate-sha256=" + digest);
    console.log("certificate-bytes=" + certificate.length);
  } catch (error) {
    console.error("could not read the signing certificate: " + String(error?.message || error));
    process.exitCode = 3;
  }
}
