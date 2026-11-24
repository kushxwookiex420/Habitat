#!/usr/bin/env node
/**
 * Mission 18 — live deployment readiness probe.
 *
 * Read-only. It never writes an objective, never changes configuration and never sends a credential.
 * It answers three questions with evidence:
 *
 *   1. What is actually deployed at the configured origin? (unauthenticated surface + route
 *      fingerprints: an authenticated route answers 401 when it exists and 404 when it does not);
 *   2. Is the repository schema compatible with the existing D1 database? (every referenced table
 *      must be created by an additive migration, and Mission 17 adds no table);
 *   3. Which owner actions still block a live autonomous mission?
 *
 * If HABITAT_AX_COMMAND_TOKEN is present in the environment, three authenticated reads are added
 * (presence, agent capability matrix, scheduler status). The token is never printed, persisted or
 * included in the evidence.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = String(process.env.HABITAT_PUBLIC_ORIGIN || "https://habitat-1-szzd.onrender.com").replace(/\/+$/, "");
const TOKEN = String(process.env.HABITAT_AX_COMMAND_TOKEN || "").trim();
const TIMEOUT_MS = 25_000;

function git(args) {
  return (spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout || "").trim();
}

async function probe(pathname, { method = "GET", authenticated = false, body = null } = {}) {
  const headers = { accept: "application/json" };
  if (authenticated && TOKEN) headers.authorization = "Bearer " + TOKEN;
  if (body !== null) headers["content-type"] = "application/json";
  try {
    const response = await fetch(ORIGIN + pathname, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is recorded as a snippet */ }
    return {
      path: pathname,
      method,
      status: response.status,
      ok: response.ok,
      json,
      snippet: json ? null : text.slice(0, 200)
    };
  } catch (error) {
    return {
      path: pathname,
      method,
      status: null,
      ok: false,
      error: String(error?.name || "fetch_failed") + ": " + String(error?.message || error).slice(0, 160)
    };
  }
}

function bodyShape(value, depth = 1) {
  if (value === null || typeof value !== "object") return typeof value;
  if (depth <= 0) return Array.isArray(value) ? "array" : "object";
  const entries = Object.entries(value).slice(0, 20).map(([key, item]) => [key, bodyShape(item, depth - 1)]);
  return Object.fromEntries(entries);
}

// ------------------------------------------------------------------------ live probes

const health = await probe("/health");
const openapi = await probe("/ax/command/openapi.json");
const presenceUnauthenticated = await probe("/ax/command/presence");
const agentsUnauthenticated = await probe("/ax/command/agents");
const missionWorkRoute = await probe("/ax/command/objectives/probe/work", { method: "POST", body: {} });
const missionStopRoute = await probe("/ax/command/objectives/probe/work/stop", { method: "POST", body: {} });
const revokeRoute = await probe("/ax/command/agents/revoke", { method: "POST", body: {} });

const authenticated = {};
if (TOKEN) {
  authenticated.presence = await probe("/ax/command/presence", { authenticated: true });
  authenticated.agents = await probe("/ax/command/agents", { authenticated: true });
  authenticated.scheduler = await probe("/ax/command/scheduler/status", { authenticated: true });
}

const operations = openapi.json?.paths
  ? Object.values(openapi.json.paths).flatMap(item => Object.keys(item)).filter(method => ["get", "post", "put", "patch", "delete"].includes(method))
  : [];

// ------------------------------------------------------------------- schema compatibility

const migrationDirectory = path.join(ROOT, "migrations");
let migrationFiles = [];
try { migrationFiles = (await readdir(migrationDirectory)).filter(name => name.endsWith(".sql")).sort(); } catch { migrationFiles = []; }
let migrationSql = "";
for (const file of migrationFiles) {
  try { migrationSql += "\n" + await readFile(path.join(migrationDirectory, file), "utf8"); } catch { /* recorded as empty */ }
}
const migrationTables = new Set([...migrationSql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z0-9_]+)/gi)].map(match => match[1]));
const destructive = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i.test(migrationSql);

// Some repositories create their own table idempotently at initialize(); those statements are
// part of the schema too. Index names (habitat_*_created_at) are not tables and must not count.
const sourceFiles = (await readdir(ROOT)).filter(name => name.endsWith(".mjs"));
const codeTables = new Set();
const referencedTables = new Set();
let codeCreateTable = 0;
let codeCreateTableIfNotExists = 0;
for (const file of sourceFiles) {
  let content = "";
  try { content = await readFile(path.join(ROOT, file), "utf8"); } catch { continue; }
  codeCreateTable += (content.match(/(?<!IF NOT EXISTS )CREATE TABLE(?! IF NOT EXISTS)/gi) || []).length;
  codeCreateTableIfNotExists += (content.match(/CREATE TABLE IF NOT EXISTS/gi) || []).length;
  for (const match of content.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(habitat_[a-z0-9_]+)/gi)) codeTables.add(match[1]);
  for (const match of content.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(habitat_[a-z0-9_]+)/gi)) referencedTables.add(match[1]);
  for (const match of content.matchAll(/\btable:\s*"(habitat_[a-z0-9_]+)"/g)) referencedTables.add(match[1]);
}
const createdTables = new Set([...migrationTables, ...codeTables]);
for (const table of createdTables) referencedTables.add(table);
const missingTables = [...referencedTables].filter(table => !createdTables.has(table)).sort();

// Mission 17 is deliberately schema-neutral: it reuses the Mission 14-16 stores.
const mission17Files = ["ax-work-cycle.mjs", "ax-agents.mjs", "ax-mission-plan.mjs"];
const mission17Tables = new Set();
for (const file of mission17Files) {
  let content = "";
  try { content = await readFile(path.join(ROOT, file), "utf8"); } catch { continue; }
  for (const match of content.matchAll(/\bhabitat_[a-z0-9_]+/g)) mission17Tables.add(match[0]);
}
const mission17NewTables = [...mission17Tables].filter(table => !createdTables.has(table));

// --------------------------------------------------------------------------- verdict

const healthBody = health.json || {};
const nexusConfigured = healthBody.nexus?.configured === true;
const mission17Deployed = missionWorkRoute.status === 401 && revokeRoute.status === 401;
const deployedGeneration = mission17Deployed ? "mission-17" : presenceUnauthenticated.status === 401 ? "mission-14-to-16" : "unknown";
const blocking = [];
if (!mission17Deployed) blocking.push("Mission 17 code is not deployed at this origin (work/revoke routes answer 404).");
if (!nexusConfigured) blocking.push("The deployed service reports nexus.configured=false (disabled_by_config).");
if (missingTables.length) blocking.push("Referenced tables without a migration: " + missingTables.join(", "));
if (destructive) blocking.push("A migration contains a destructive statement; review before deploying.");
if (codeCreateTable > 0) blocking.push("Repository code contains a non-idempotent CREATE TABLE; every table must be created with IF NOT EXISTS.");
if (!TOKEN) blocking.push("No authenticated token was supplied, so presence, agent capabilities and scheduler state were not read.");
if (authenticated.agents?.json?.agents && Array.isArray(authenticated.agents.json.agents)) {
  const names = authenticated.agents.json.agents.map(agent => agent.id);
  if (!names.includes("director") || !names.includes("verification")) blocking.push("Deployed agent registry has no Director/Verification role.");
  const available = authenticated.agents.json.agents.filter(agent => agent.available).map(agent => agent.id);
  if (!available.includes("research") || !available.includes("engineering")) {
    blocking.push("Research/engineering capabilities are unavailable on the deployed service (check AX_AGENT_LOCAL_ROOT).");
  }
}

const evidence = {
  schemaVersion: 1,
  mission: "18",
  kind: "live-deployment-readiness",
  generatedAt: new Date().toISOString(),
  origin: ORIGIN,
  repository: {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: git(["status", "--porcelain", "--untracked-files=no"]).length > 0
  },
  live: {
    health: { status: health.status, fields: health.json ? Object.keys(health.json).sort() : null, version: healthBody.version || null, nexus: healthBody.nexus || null },
    openapi: { status: openapi.status, operations: operations.length },
    unauthenticated: {
      presence: presenceUnauthenticated.status,
      agents: agentsUnauthenticated.status
    },
    routeFingerprint: {
      missionWork: missionWorkRoute.status,
      missionStop: missionStopRoute.status,
      agentsRevoke: revokeRoute.status,
      interpretation: "401 means the authenticated route exists; 404 means the deployed build does not register it"
    },
    deployedGeneration,
    nexusConfigured
  },
  authenticated: TOKEN ? {
    supplied: true,
    presence: authenticated.presence ? { status: authenticated.presence.status, shape: bodyShape(authenticated.presence.json) } : null,
    agents: authenticated.agents ? {
      status: authenticated.agents.status,
      count: Array.isArray(authenticated.agents.json?.agents) ? authenticated.agents.json.agents.length : null,
      available: Array.isArray(authenticated.agents.json?.agents) ? authenticated.agents.json.agents.filter(agent => agent.available).map(agent => agent.id) : null,
      unavailable: Array.isArray(authenticated.agents.json?.agents) ? authenticated.agents.json.agents.filter(agent => !agent.available).map(agent => agent.id) : null
    } : null,
    scheduler: authenticated.scheduler ? {
      status: authenticated.scheduler.status,
      state: authenticated.scheduler.json?.scheduler?.status || null,
      healthy: authenticated.scheduler.json?.scheduler?.healthy ?? null,
      lastSuccessAt: authenticated.scheduler.json?.scheduler?.lastSuccessAt || null
    } : null
  } : { supplied: false, note: "Set HABITAT_AX_COMMAND_TOKEN in the environment to add authenticated reads. It is never written to this file." },
  schema: {
    migrations: migrationFiles,
    tablesCreatedByMigration: [...migrationTables].sort(),
    tablesCreatedInCode: [...codeTables].sort(),
    tablesReferenced: [...referencedTables].sort(),
    missingTables,
    additiveOnly: !destructive,
    codeDdlAdditive: codeCreateTable === 0,
    mission17Tables: [...mission17Tables].sort(),
    mission17NewTables,
    note: "Mission 17 writes only to existing tables through the existing repositories; no migration is added."
  },
  blocking,
  status: blocking.length === 0
    ? "READY_FOR_LIVE_MISSION"
    : mission17Deployed
      ? "DEPLOYED_NOT_CONFIGURED"
      : "BLOCKED_ON_OWNER_DEPLOY",
  secretsExposed: false
};

await mkdir(path.join(ROOT, "release"), { recursive: true });
await writeFile(path.join(ROOT, "release", "mission-18-live-readiness.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");

console.log(JSON.stringify({
  status: evidence.status,
  origin: ORIGIN,
  deployedGeneration,
  nexusConfigured,
  openapiOperations: operations.length,
  schema: { missingTables: missingTables.length, mission17NewTables: mission17NewTables.length, additiveOnly: !destructive, codeDdlAdditive: codeCreateTable === 0 },
  blocking: blocking.length
}));
