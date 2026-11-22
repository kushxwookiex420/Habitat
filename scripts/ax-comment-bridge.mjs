#!/usr/bin/env node
/**
 * Ax comment bridge — one-pass responder for Ax messages posted on a pull request.
 *
 * Purpose: Ax (ChatGPT, through the connected GitHub integration) can only reach Habitat by
 * posting a PR comment. This bridge closes that loop at $0 with no new secret:
 *   - it lists the top-level comments on PR #93 with the Actions-provided GITHUB_TOKEN,
 *   - accepts only comments from the allowlisted owner account, refusing bridge replies,
 *     review comments and anything from another association,
 *   - treats the comment body strictly as data: intent is *classified* from a fixed vocabulary and
 *     nothing in the text is ever executed, evaluated, shelled out or sent to a model,
 *   - replies once with a correlated top-level comment carrying a durable processed marker.
 *
 * Exactly-once: the marker `<!-- nexus:processed:<id> -->` lives in the reply itself, so the PR
 * history is the durable store. A rerun, a retry or a duplicated event sees the marker and skips.
 * No D1 table, no second scheduler, no external state.
 *
 * Optional, off by default: if HABITAT_AX_COMMAND_TOKEN and HABITAT_BASE_URL are present, the
 * envelope is forwarded to the existing Ax channel through scripts/ax-relay.mjs. Without them the
 * bridge says it did not forward and still answers — it never asks for or invents a credential.
 *
 * This file is inert on a feature branch: GitHub runs `issue_comment` workflows only when the
 * workflow exists on the default branch. `--default-branch-active` is how the caller states which
 * case it is, so the reply never overclaims that a poller is running.
 *
 *   node scripts/ax-comment-bridge.mjs --dry-run
 *   node scripts/ax-comment-bridge.mjs --from-file comments.json --dry-run
 *   GITHUB_TOKEN=... node scripts/ax-comment-bridge.mjs
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAxRelay, redact } from "./ax-relay.mjs";

export const MARKER_PREFIX = "<!-- nexus:processed:";
export const REPLY_SIGNATURE = "NEXUS_AX_BRIDGE";
export const DEFAULT_OWNER = "kushxwookiex420";
export const DEFAULT_REPO = "Habitat";
export const DEFAULT_PULL = 93;
export const MAX_PER_RUN = 10;
/** A message bridge answers current messages; it must never backfill years of mission reports. */
export const DEFAULT_MAX_AGE_HOURS = 24;
export const LIMITS = Object.freeze({ excerpt: 280, reply: 4000, pages: 3, skippedReported: 25 });

/** A correlation id is derived from the comment id: unique per message and stable across runs. */
export function correlationIdFor(commentId) {
  const id = String(commentId ?? "").trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error("correlationIdFor needs a numeric comment id");
  const digest = createHash("sha256").update("ax-comment:" + id).digest("hex").slice(0, 12);
  return "ax-" + id + "-" + digest;
}

export function markerFor(commentId) {
  return MARKER_PREFIX + String(commentId) + " -->";
}

/** Any bridge reply carries a marker, so it can never be mistaken for an inbound Ax message. */
export function hasMarker(body) {
  return /<!--\s*nexus:processed:\d+\s*-->/.test(String(body ?? ""));
}

/** Durable processed set, read back out of the PR's own comment history. */
export function processedIds(comments) {
  const ids = new Set();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = String(comment?.body ?? "");
    for (const hit of body.matchAll(/<!--\s*nexus:processed:(\d+)\s*-->/g)) ids.add(Number(hit[1]));
  }
  return ids;
}

export const INTENTS = Object.freeze(["handshake", "status", "directive", "note"]);

/**
 * Classification only. The vocabulary exists to choose the reply's wording; it never selects code
 * to run. Anything unrecognised is a plain `note` and gets no special treatment.
 */
export function classifyIntent(body) {
  const text = String(body ?? "");
  if (/NEXUS_RECEIVED_AX_TEST_001|handshake/i.test(text)) return "handshake";
  if (/\b(status|health|readiness)\b/i.test(text)) return "status";
  if (/\b(directive|priority|implement|build|report|verify)\b/i.test(text)) return "directive";
  return "note";
}

/**
 * A comment is only a message for NEXUS if it says so: either it was written through the ChatGPT
 * connector app, or it opens a line with an addressing prefix. Without this, every owner mission
 * report on the PR would be answered as if Ax had asked something.
 */
export const ADDRESSING = /^(?:\/nexus\b|ax:|nexus:)/im;
export const AX_APP_SLUG = "chatgpt-codex-connector";

export function addressedToNexus(comment) {
  if (String(comment?.performed_via_github_app?.slug ?? "") === AX_APP_SLUG) return true;
  return ADDRESSING.test(String(comment?.body ?? ""));
}

/**
 * Accept a comment only if it is top-level, from an allowlisted login with an owner-level
 * association, addressed to NEXUS, not empty and not already a bridge reply.
 */
export function classifyComment(comment, { ownerLogin = DEFAULT_OWNER, allowedLogins = [] } = {}) {
  if (!comment || typeof comment !== "object") return { accepted: false, reason: "malformed_comment" };
  if (comment.pull_request_review_id) return { accepted: false, reason: "review_comment_not_top_level" };
  if (hasMarker(comment.body)) return { accepted: false, reason: "bridge_reply" };
  const login = String(comment.user?.login ?? "").trim();
  const allow = new Set([ownerLogin, ...allowedLogins].filter(Boolean).map(item => String(item).toLowerCase()));
  if (!login || !allow.has(login.toLowerCase())) return { accepted: false, reason: "sender_not_allowlisted" };
  const association = String(comment.author_association ?? "").trim().toUpperCase();
  if (association && association !== "OWNER" && association !== "MEMBER") {
    return { accepted: false, reason: "sender_not_owner" };
  }
  if (!String(comment.body ?? "").trim()) return { accepted: false, reason: "empty_body" };
  if (!addressedToNexus(comment)) return { accepted: false, reason: "not_addressed_to_nexus" };
  return { accepted: true, reason: "ok" };
}

/** Bounded, redacted, single-line excerpt: comments are data, and data can contain secrets. */
export function extractExcerpt(body, max = LIMITS.excerpt) {
  const flat = redact(String(body ?? "").replace(/\s+/g, " ").trim(), max + 32);
  if (flat.length <= max) return flat;
  return flat.slice(0, max).trimEnd() + " …";
}

/**
 * The reply is assembled from allowlisted fields only. No field of the source comment is copied
 * verbatim beyond the bounded excerpt, so a comment cannot smuggle formatting or instructions
 * into a future Ax read of this thread.
 */
export function buildReply({
  comment,
  correlationId,
  forwarded = null,
  defaultBranchActive = false,
  now = new Date().toISOString()
} = {}) {
  const id = Number(comment?.id);
  if (!Number.isFinite(id)) throw new Error("buildReply needs a comment id");
  const intent = classifyIntent(comment?.body);
  const login = String(comment?.user?.login ?? "unknown");
  const association = String(comment?.author_association ?? "NONE");
  const via = String(comment?.performed_via_github_app?.name ?? "none");
  const lines = [
    "### " + REPLY_SIGNATURE + " — reply to comment `" + id + "`",
    markerFor(id),
    "",
    "| field | value |",
    "| --- | --- |",
    "| source comment | `" + id + "` |",
    "| author | `@" + login + "` (" + association + ") |",
    "| posted via | " + redact(via, 80) + " |",
    "| correlation ID | `" + correlationId + "` |",
    "| classified intent | `" + intent + "` |",
    "| bridge run | " + now + " |",
    "",
    "**Excerpt (bounded, redacted):**",
    "",
    "> " + (extractExcerpt(comment?.body) || "(empty)"),
    ""
  ];
  if (intent === "handshake") {
    lines.push("**NEXUS_RECEIVED_AX_TEST_001** — correlation `" + correlationId + "`", "");
  }
  if (forwarded && forwarded.ok === true) {
    lines.push("**Runtime forward:** accepted by the Habitat Ax channel (task id `" + String(forwarded.taskId ?? "n/a") + "`, replayed: " + String(forwarded.replayed === true) + ").", "");
  } else if (forwarded && forwarded.ok === false) {
    lines.push("**Runtime forward:** attempted and refused — " + redact(forwarded.reason, 200) + ".", "");
  } else {
    lines.push("**Runtime forward:** not attempted — no `HABITAT_AX_COMMAND_TOKEN` is configured on this workflow, so nothing was sent to the Habitat service.", "");
  }
  lines.push("**No execution:** this comment's text was treated as data. The bridge runs no shell command, no code, no model and no paid call; the reply above is built only from allowlisted fields.", "");
  lines.push(defaultBranchActive
    ? "**Automatic polling:** this workflow runs from the default branch, so `issue_comment` events are delivered without owner action."
    : "**Automatic polling:** not active. This workflow file is not on the default branch (`main`), and GitHub delivers `issue_comment` only to workflows defined there. This reply proves receipt, not a running poller.", "");
  return redact(lines.join("\n"), LIMITS.reply);
}

async function gh(fetchImpl, method, url, { token, body = null } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "user-agent": "habitat-ax-comment-bridge",
      ...(body === null ? {} : { "content-type": "application/json" })
    },
    ...(body === null ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const header = name => {
    if (typeof response.headers?.get === "function") return response.headers.get(name);
    return response.headers?.[name] ?? null;
  };
  return {
    ok: response.status >= 200 && response.status < 300,
    status: Number(response.status),
    json,
    text: text.slice(0, 500),
    remaining: Number(header("x-ratelimit-remaining") ?? NaN),
    retryAfter: Number(header("retry-after") ?? NaN)
  };
}

/**
 * One pass. Reads the thread, answers every eligible unanswered comment at most once, and stops on
 * a rate limit instead of retrying in a loop.
 */
export async function runBridge({
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
  pullNumber = DEFAULT_PULL,
  token = process.env.GITHUB_TOKEN || "",
  fetchImpl = globalThis.fetch,
  dryRun = false,
  defaultBranchActive = false,
  ownerLogin = DEFAULT_OWNER,
  allowedLogins = [],
  relay = null,
  limit = MAX_PER_RUN,
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  now = () => Date.now(),
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const api = "https://api.github.com/repos/" + owner + "/" + repo + "/issues/" + pullNumber;
  const comments = [];
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: owner + "/" + repo + "#" + pullNumber,
    dryRun: Boolean(dryRun),
    defaultBranchActive: Boolean(defaultBranchActive),
    maxAgeHours: Number(maxAgeHours),
    inspected: 0,
    alreadyProcessed: [],
    skipped: [],
    skippedTotal: 0,
    planned: [],
    posted: [],
    forwards: [],
    rateLimited: false,
    blockers: []
  };

  const needsToken = !(dryRun && Array.isArray(fetchImpl?.offlineComments));
  if (needsToken && !String(token || "").trim()) {
    const error = new Error("GITHUB_TOKEN is required to read and reply on the pull request");
    error.code = "missing_token";
    throw error;
  }

  // Listing is read-only, so it is allowed in dry-run only when a real token exists.
  if (!Array.isArray(fetchImpl?.offlineComments)) {
    for (let page = 1; page <= LIMITS.pages; page += 1) {
      const listed = await gh(fetchImpl, "GET", api + "/comments?per_page=100&page=" + page, { token });
      if (!listed.ok) {
        report.blockers.push("listing comments failed with HTTP " + listed.status);
        if (listed.status === 403 || listed.status === 429) report.rateLimited = true;
        break;
      }
      const batch = Array.isArray(listed.json) ? listed.json : [];
      comments.push(...batch);
      if (Number.isFinite(listed.remaining) && listed.remaining <= 1) break;
      if (batch.length < 100) break;
    }
  } else {
    comments.push(...fetchImpl.offlineComments);
  }
  report.inspected = comments.length;

  const processed = processedIds(comments);
  report.alreadyProcessed = [...processed].sort((a, b) => a - b);

  const inbound = comments
    .filter(comment => {
      const skip = reason => {
        report.skippedTotal += 1;
        if (report.skipped.length < LIMITS.skippedReported) report.skipped.push({ id: Number(comment?.id) || null, reason });
        return false;
      };
      const verdict = classifyComment(comment, { ownerLogin, allowedLogins });
      if (!verdict.accepted) return skip(verdict.reason);
      if (processed.has(Number(comment.id))) return skip("already_processed");
      const created = Date.parse(String(comment.created_at ?? ""));
      if (Number.isFinite(maxAgeHours) && maxAgeHours > 0) {
        if (!Number.isFinite(created)) return skip("missing_created_at");
        if (now() - created > maxAgeHours * 3_600_000) return skip("older_than_window");
      }
      return true;
    })
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, Math.max(1, limit));

  for (const comment of inbound) {
    const correlationId = correlationIdFor(comment.id);
    let forwarded = null;
    if (relay) {
      try {
        const outcome = await relay.send({
          kind: "note",
          body: [
            "Ax comment " + comment.id + " on " + report.target,
            "correlation " + correlationId,
            "intent " + classifyIntent(comment.body),
            "excerpt: " + extractExcerpt(comment.body)
          ].join("\n").slice(0, 4000),
          correlationId
        });
        forwarded = { ok: true, taskId: outcome?.taskId ?? null, replayed: outcome?.replayed === true };
      } catch (error) {
        forwarded = { ok: false, reason: String(error?.message ?? error) };
      }
      report.forwards.push({ id: Number(comment.id), correlationId, ...forwarded });
    }

    const body = buildReply({ comment, correlationId, forwarded, defaultBranchActive });
    report.planned.push({ id: Number(comment.id), correlationId });

    if (dryRun) continue;

    const created = await gh(fetchImpl, "POST", api + "/comments", { token, body: { body } });
    if (created.ok) {
      report.posted.push({
        id: Number(comment.id),
        correlationId,
        replyId: created.json?.id ?? null,
        url: created.json?.html_url ?? null
      });
      continue;
    }
    report.blockers.push("replying to " + comment.id + " failed with HTTP " + created.status);
    if (created.status === 403 || created.status === 429) {
      report.rateLimited = true;
      if (Number.isFinite(created.retryAfter) && created.retryAfter > 0 && created.retryAfter <= 30) {
        await sleepImpl(created.retryAfter * 1000);
      }
      break;
    }
  }

  report.ok = report.blockers.length === 0;
  return report;
}

function parseArgs(argv) {
  const args = {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    pullNumber: DEFAULT_PULL,
    dryRun: false,
    defaultBranchActive: false,
    fromFile: null,
    limit: MAX_PER_RUN,
    maxAgeHours: Number(process.env.AX_BRIDGE_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--owner") args.owner = argv[++index];
    else if (item === "--repo") args.repo = argv[++index];
    else if (item === "--pr") args.pullNumber = Number(argv[++index]);
    else if (item === "--limit") args.limit = Number(argv[++index]);
    else if (item === "--max-age-hours") args.maxAgeHours = Number(argv[++index]);
    else if (item === "--dry-run") args.dryRun = true;
    else if (item === "--default-branch-active") args.defaultBranchActive = true;
    else if (item === "--from-file") args.fromFile = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let fetchImpl = globalThis.fetch;
  if (args.fromFile) {
    const raw = JSON.parse(await readFile(path.resolve(args.fromFile), "utf8"));
    const offlineComments = Array.isArray(raw) ? raw : Array.isArray(raw?.comments) ? raw.comments : [];
    fetchImpl = Object.assign(async () => { throw new Error("offline mode never performs network calls"); }, { offlineComments });
    if (!args.dryRun) {
      process.stderr.write("ax-comment-bridge: --from-file requires --dry-run\n");
      process.exitCode = 2;
      return;
    }
  }
  const relay = process.env.HABITAT_AX_COMMAND_TOKEN && process.env.HABITAT_BASE_URL
    ? createAxRelay({ baseUrl: process.env.HABITAT_BASE_URL, token: process.env.HABITAT_AX_COMMAND_TOKEN })
    : null;
  const report = await runBridge({
    owner: args.owner,
    repo: args.repo,
    pullNumber: args.pullNumber,
    dryRun: args.dryRun,
    defaultBranchActive: args.defaultBranchActive,
    relay,
    limit: args.limit,
    maxAgeHours: args.maxAgeHours,
    fetchImpl
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write("ax-comment-bridge: " + redact(error?.message || error, 300) + "\n");
    process.exitCode = error?.code === "missing_token" ? 2 : 1;
  }
}
