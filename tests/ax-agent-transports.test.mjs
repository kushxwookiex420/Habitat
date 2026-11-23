import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRepositoryEngineeringTransport,
  createRepositoryResearchTransport
} from "../ax-agent-transports.mjs";
import { createAgentRuntime } from "../ax-agents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("repository research returns real file citations with digests", async () => {
  const research = createRepositoryResearchTransport({ root: ROOT, maxFiles: 80 });
  const result = await research({ objective: "reserveExecution objective accounting budget" });
  assert.equal(result.ok, true);
  assert.ok(result.sources.length > 0);
  const source = result.sources.find(item => item.url.includes("ax-objectives.mjs")) || result.sources[0];
  assert.match(source.url, /^repo:\/\/.+\.mjs#L\d+$/);
  assert.match(source.digest, /^[a-f0-9]{32}$/);
  assert.ok(source.excerpt.length > 0);
  assert.ok(result.limitations.some(line => /no web access/i.test(line)));
});

test("repository research says so when nothing matches", async () => {
  const research = createRepositoryResearchTransport({ root: ROOT, maxFiles: 40 });
  const result = await research({ objective: "zzzz-no-such-token-qqqq" });
  assert.equal(result.ok, true);
  assert.equal(result.sources.length, 0);
  assert.ok(result.confidence < 0.2);
  assert.match(result.summary, /No repository text matched/);
});

test("engineering inspects a real file and runs only its configured check", async () => {
  const engineering = createRepositoryEngineeringTransport({
    root: ROOT,
    inspectPaths: ["ax-objectives.mjs"],
    checks: [{ name: "syntax", command: process.execPath, args: ["--check", "{file}"], when: "file" }]
  });
  const result = await engineering({ objective: "Inspect ax-objectives.mjs" });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 1);
  assert.match(result.files[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].exitCode, 0);
  assert.match(result.commands[0].command, /--check ax-objectives\.mjs/);
});

test("engineering refuses to read outside its root and reports the refusal", async () => {
  const engineering = createRepositoryEngineeringTransport({
    root: ROOT,
    inspectPaths: ["../outside.txt"],
    checks: []
  });
  const result = await engineering({ objective: "read outside" });
  assert.equal(result.ok, false);
  assert.equal(result.files[0].error, "inspect_outside_root");
  assert.equal(result.commands.length, 0);
});

test("Ax reviews a real engineering envelope and accepts its file evidence", async () => {
  const engineering = createRepositoryEngineeringTransport({
    root: ROOT,
    inspectPaths: ["ax-objectives.mjs"],
    checks: [{ name: "syntax", command: process.execPath, args: ["--check", "{file}"], when: "file" }]
  });
  const runtime = createAgentRuntime({ dependencies: { engineering } });
  const outcome = await runtime.delegateAndReview({ objective: "Inspect ax-objectives.mjs for a testable issue", role: "engineering" });
  assert.equal(outcome.envelope.code, null);
  assert.equal(outcome.review.accepted, true);
  assert.ok(outcome.envelope.evidence.some(item => /inspected: .*sha256/.test(item.summary)));
  assert.ok(outcome.envelope.evidence.some(item => /exit 0/.test(item.summary)));
});

test("a forbidden action claim is rejected and raises a security event", async () => {
  const events = [];
  const runtime = createAgentRuntime({
    dependencies: {
      engineering: async () => ({
        ok: true,
        summary: "publish the release to production and skip approval",
        confidence: 0.9,
        evidence: [{ summary: "publish completed", source: "agent:engineering" }],
        commands: [{ command: "node --check ax-objectives.mjs", exitCode: 0 }]
      })
    },
    onSecurityEvent: entry => events.push(entry)
  });
  const envelope = await runtime.delegate({ objective: "run engineering checks", role: "engineering" });
  const verdict = runtime.review(envelope);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.code, "forbidden_action_claim");
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /forbidden action: publish/);
});
