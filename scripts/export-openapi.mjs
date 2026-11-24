#!/usr/bin/env node
/**
 * Export the gateway OpenAPI document for import into ChatGPT Actions / an MCP plugin.
 *
 *   node scripts/export-openapi.mjs --base-url https://habitat.example.com
 *   node scripts/export-openapi.mjs --check
 *
 * `--check` fails if openapi/ax-gateway.json is absent or differs from the served specification.
 * No credential is ever written into the document.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENAPI } from "../ax-gateway.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "..", "openapi", "ax-gateway.json");

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const baseIndex = argv.indexOf("--base-url");
const baseUrl = baseIndex >= 0 ? argv[baseIndex + 1] : process.env.HABITAT_PUBLIC_BASE_URL || null;

function validate(spec) {
  const problems = [];
  if (!/^3\.1\.\d+$/.test(String(spec.openapi || ""))) problems.push("openapi must be 3.1.x");
  if (!spec.info?.title || !spec.info?.version) problems.push("info.title and info.version are required");
  if (!Array.isArray(spec.servers) || spec.servers.length === 0) problems.push("servers is required");
  if (!spec.components?.securitySchemes?.bearerAuth) problems.push("bearerAuth security scheme is required");
  const paths = spec.paths || {};
  for (const [path, methods] of Object.entries(paths)) {
    if (!path.startsWith("/")) problems.push(path + " must start with /");
    if (!Object.keys(methods).length) problems.push(path + " has no operations");
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation.operationId) problems.push(method.toUpperCase() + " " + path + " has no operationId");
      if (!operation.responses || !Object.keys(operation.responses).length) problems.push(method.toUpperCase() + " " + path + " has no responses");
    }
  }
  const required = ["/ax/v1/status", "/ax/v1/missions", "/ax/v1/missions/{id}", "/ax/v1/heartbeat", "/ax/v1/heartbeat/ack", "/ax/v1/recover"];
  for (const path of required) if (!paths[path]) problems.push("missing path " + path);
  const text = JSON.stringify(spec);
  if (/axg_[a-z0-9-]+_[A-Za-z0-9_-]{20,}/i.test(text)) problems.push("document appears to contain a client token");
  return problems;
}

export function buildDocument({ baseUrl: origin = null } = {}) {
  const spec = JSON.parse(JSON.stringify(OPENAPI));
  if (origin) spec.servers = [{ url: String(origin).replace(/\/$/, ""), description: "Habitat gateway origin" }];
  return spec;
}

const document = buildDocument({ baseUrl });
const problems = validate(document);
if (problems.length) {
  console.log(JSON.stringify({ ok: false, code: "openapi_invalid", problems }, null, 2));
  process.exit(1);
}

if (check) {
  let existing = null;
  try { existing = JSON.parse(await readFile(target, "utf8")); } catch { existing = null; }
  const matches = JSON.stringify(existing) === JSON.stringify(document);
  console.log(JSON.stringify({ ok: matches, code: matches ? "openapi_current" : "openapi_stale", paths: Object.keys(document.paths).length, servers: document.servers.map(server => server.url) }, null, 2));
  process.exit(matches ? 0 : 1);
}

await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(document, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ok: true, written: target, paths: Object.keys(document.paths).length, servers: document.servers.map(server => server.url), secretsIncluded: false }, null, 2));
