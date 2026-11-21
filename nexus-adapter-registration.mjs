/**
 * Registration for the read-only Nexus adapters.
 *
 * This module only builds the adapter map. It does not mount Nexus, start a worker, register a
 * route, read environment variables or perform any I/O. `device-command-bridge.mjs` calls it when
 * Nexus is enabled.
 *
 * Compatibility: `registerNexusRuntime({ adapters })` expects a plain object mapping adapter name
 * to `async (task) => ({ ok, summary, evidence?, error?, blockers? })`. createReadOnlyAdapters()
 * returns exactly that shape, so the returned map can be passed through unchanged.
 */

import { createReadOnlyAdapters } from "./nexus-adapters.mjs";

/**
 * Candidate mount set. `repo.test` is deliberately excluded until Ax accepts the namespace
 * isolation evidence; it stays available in nexus-adapters.mjs but is never registered here.
 */
export const READ_ONLY_ADAPTER_NAMES = Object.freeze([
  "repo.inspect",
  "task.inspect",
  "runtime.health"
]);
export const DISABLED_ADAPTER_NAMES = Object.freeze(["repo.test"]);

/**
 * Repository-relative prefixes the read-only adapters may read. Exported so the mounted runtime and
 * the one-shot tick use one allowlist instead of two copies that could drift.
 */
export const READ_ONLY_ADAPTER_PREFIXES = Object.freeze([
  "src",
  "tests",
  "docs",
  "app/src",
  "README.md",
  "package.json"
]);

/** Machine-readable contract for review and for the registration documentation. */
export const READ_ONLY_ADAPTER_SPECS = Object.freeze({
  "repo.inspect": Object.freeze({
    permissions: ["read:repo-files"],
    input: { path: "string — repository-relative, must resolve under an allowed prefix" },
    timeoutMs: "bounded by defaultTimeoutMs (default 120000, overridable at mount)",
    evidence: "repo.file:<path>#bytes=<start>-<end>@sha256:<hex> or repo.dir:<path>/@entries=<n>@sha256:<hex>"
  }),
  "repo.test": Object.freeze({
    enabled: false,
    note: "Not part of the candidate mount. Requires the Linux namespace sandbox and explicit approval.",
    permissions: ["exec:allowlisted"],
    input: { test: "string ≤ 80 chars — key of the host-provided allowlist" },
    timeoutMs: "per allowlist entry; defaultTimeoutMs when omitted (default 120000)",
    evidence: "test:<name>:exit=<code>:duration=<ms>:stdout_sha256:<hex>:stderr_sha256:<hex>@command=<cmd> <args>"
  }),
  "task.inspect": Object.freeze({
    permissions: ["read:tasks"],
    input: { taskId: "string; must equal the executing task id when supplied" },
    timeoutMs: "bounded by defaultTimeoutMs (default 120000, overridable at mount)",
    evidence: "task:<id>:status=<s>:attempts=<n>:owner=<id|none>:fence=<present|none>:lease=<iso|none>:history=<n>@observed=<iso>"
  }),
  "runtime.health": Object.freeze({
    permissions: ["read:health"],
    input: {},
    timeoutMs: "bounded by defaultTimeoutMs (default 120000, overridable at mount)",
    evidence: "runtime:workers=<n>:live=<n>:stale=<n>:stopped=<n>:working=<n>@observed=<iso>"
  })
});

function assertOptions(options) {
  const missing = [];
  if (typeof options.rootDir !== "string" || !options.rootDir.trim()) missing.push("rootDir");
  if (!options.taskRepository || typeof options.taskRepository.get !== "function") missing.push("taskRepository.get");
  if (typeof options.d1Query !== "function") missing.push("d1Query");
  if (!options.allowedPrefixes || !Array.isArray(options.allowedPrefixes) || options.allowedPrefixes.length === 0) missing.push("allowedPrefixes");

  if (missing.length) {
    throw new Error("Nexus read-only adapter registration is incomplete: " + missing.join(", "));
  }
}

/**
 * Build the adapter map handed to registerNexusRuntime.
 *
 * @param {object} options
 * @param {string} options.rootDir            absolute repository root; symlinks resolve outside it are refused
 * @param {string[]} options.allowedPrefixes  allowlisted path prefixes, e.g. ["src", "tests", "package.json"]
 * @param {{get: Function}} options.taskRepository  the existing habitat_command_tasks repository
 * @param {Function} options.d1Query          query(sql, params) -> D1 HTTP result rows
 * @param {number} [options.maxFileBytes]     refused above this size (default 262144)
 */
export function buildReadOnlyNexusAdapters(options = {}) {
  assertOptions(options);
  const adapters = createReadOnlyAdapters({
    rootDir: options.rootDir,
    allowedPrefixes: options.allowedPrefixes,
    repository: options.taskRepository,
    query: options.d1Query,
    // No test adapter is registered: repo.test is excluded from the candidate mount.
    allowedTests: {},
    maxFileBytes: options.maxFileBytes
  });
  return Object.freeze(Object.fromEntries(READ_ONLY_ADAPTER_NAMES.map(name => [name, adapters[name]])));
}
