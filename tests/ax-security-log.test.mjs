import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityEventService, verifyEventChain, SECURITY_CATEGORIES } from "../ax-security-events.mjs";
import { createMemorySecurityEventRepository } from "../ax-security-event-repository.mjs";

function service(overrides = {}) {
  const repository = createMemorySecurityEventRepository();
  return { repository, service: createSecurityEventService({ repository, now: () => "2026-11-22T00:00:00.000Z", ...overrides }) };
}

test("events are append-only and hash-chained", async () => {
  const { repository, service: log } = service();
  assert.equal(typeof repository.update, "undefined");
  assert.equal(typeof repository.remove, "undefined");
  assert.equal(typeof repository.delete, "undefined");
  const first = await log.record({ category: "auth.failure", actor: "anonymous", summary: "bad token" });
  const second = await log.record({ category: "owner.authorization", severity: "info", outcome: "allowed", actor: "owner:phone-1", summary: "approved" });
  assert.equal(first.ok, true);
  assert.equal(first.event.seq, 1);
  assert.equal(second.event.seq, 2);
  assert.equal(second.event.prevHash, first.event.hash);
  const integrity = await log.integrity();
  assert.equal(integrity.ok, true);
  assert.equal(integrity.checked, 2);
  assert.equal(integrity.headHash, second.event.hash);
  assert.match(integrity.tamperEvidence, /not tamper-proof/i);
});

test("tampering with a stored event is detected at the exact link", async () => {
  const { repository, service: log } = service();
  await log.record({ category: "auth.failure", summary: "one" });
  await log.record({ category: "owner.authorization", summary: "two" });
  await log.record({ category: "device.pairing", summary: "three" });
  repository._rows[1].summary = "rewritten";
  const integrity = await log.integrity();
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, "hash_mismatch");
  assert.equal(integrity.index, 1);
});

test("concurrent appends receive unique sequences and still form one chain", async () => {
  const { service: log, repository } = service();
  await Promise.all(Array.from({ length: 25 }, (_, index) => log.record({
    category: SECURITY_CATEGORIES[index % SECURITY_CATEGORIES.length],
    summary: "concurrent event " + index
  })));
  const rows = repository._rows;
  assert.equal(rows.length, 25);
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.equal(verifyEventChain(rows).ok, true);
});

test("pagination is stable and reads newest first", async () => {
  const { service: log } = service();
  for (let index = 0; index < 7; index += 1) await log.record({ category: "command.unauthorized", summary: "event " + index });
  const pageOne = await log.list({ limit: 3 });
  assert.deepEqual(pageOne.events.map(event => event.seq), [7, 6, 5]);
  assert.equal(pageOne.nextBeforeSeq, 5);
  const pageTwo = await log.list({ limit: 3, beforeSeq: pageOne.nextBeforeSeq });
  assert.deepEqual(pageTwo.events.map(event => event.seq), [4, 3, 2]);
});

test("a category outside the allowlist is refused and secrets are redacted", async () => {
  const { service: log } = service();
  const refused = await log.record({ category: "made.up", summary: "no" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "invalid_security_category");
  const recorded = await log.record({ category: "secret.detected", summary: "found sk-abcdefgh12345678 in a prompt", evidence: "Bearer abcdefghijklmno" });
  assert.doesNotMatch(recorded.event.summary, /sk-abcdefgh/);
  assert.doesNotMatch(recorded.event.evidence, /abcdefghijklmno/);
});

test("the log is unavailable rather than in-memory when no repository is mounted", async () => {
  const log = createSecurityEventService({ repository: null });
  const outcome = await log.record({ category: "auth.failure" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "security_log_not_configured");
});
