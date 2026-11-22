import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityEventService, verifyEventChain } from "../ax-security-events.mjs";
import { createMemorySecurityEventRepository } from "../ax-security-event-repository.mjs";

function logAt(now) {
  const repository = createMemorySecurityEventRepository();
  return { repository, log: createSecurityEventService({ repository, now }) };
}

test("100 concurrent appends produce one contiguous chain and no duplicate ids", async () => {
  const { repository, log } = logAt();
  const outcomes = await Promise.all(Array.from({ length: 100 }, (_, index) => log.record({
    category: "command.unauthorized",
    summary: "event " + index
  })));
  assert.equal(outcomes.every(item => item.ok), true);
  const rows = repository._rows;
  assert.equal(rows.length, 100);
  assert.equal(new Set(rows.map(row => row.id)).size, 100);
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(verifyEventChain(rows).ok, true);
  assert.equal((await log.integrity()).ok, true);
});

test("a replayed event id with different content is refused by the store", async () => {
  const { repository } = logAt();
  const event = { id: "sec_fixed", category: "auth.failure", severity: "low", outcome: "denied", createdAt: "2026-11-22T00:00:00.000Z", summary: "one" };
  await repository.append(event);
  await assert.rejects(() => repository.append({ ...event, summary: "two" }), /security_event_id_conflict/);
  assert.equal(repository._rows.length, 1);
});

test("edited content, a broken previous hash, a missing event and reordering are each detected", async () => {
  const { repository, log } = logAt();
  for (let index = 0; index < 5; index += 1) await log.record({ category: "auth.failure", summary: "event " + index });
  const original = repository._rows.map(row => ({ ...row }));

  repository._rows[2].summary = "rewritten";
  let integrity = await log.integrity();
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, "hash_mismatch");
  assert.equal(integrity.index, 2);
  repository._rows.splice(0, repository._rows.length, ...original.map(row => ({ ...row })));

  repository._rows[3].prevHash = "f".repeat(64);
  integrity = await log.integrity();
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, "prev_hash_mismatch");
  repository._rows.splice(0, repository._rows.length, ...original.map(row => ({ ...row })));

  repository._rows.splice(2, 1);
  integrity = await log.integrity();
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, "sequence_gap");
  repository._rows.splice(0, repository._rows.length, ...original.map(row => ({ ...row })));

  [repository._rows[1], repository._rows[2]] = [repository._rows[2], repository._rows[1]];
  integrity = await log.integrity();
  assert.equal(integrity.ok, false);
  assert.equal(integrity.reason, "sequence_gap");
});

test("pagination is stable while new events are appended", async () => {
  const { log } = logAt();
  for (let index = 0; index < 10; index += 1) await log.record({ category: "auth.failure", summary: "old " + index });
  const first = await log.list({ limit: 4 });
  assert.deepEqual(first.events.map(row => row.seq), [10, 9, 8, 7]);
  for (let index = 0; index < 5; index += 1) await log.record({ category: "auth.failure", summary: "new " + index });
  const second = await log.list({ limit: 4, beforeSeq: first.nextBeforeSeq });
  assert.deepEqual(second.events.map(row => row.seq), [6, 5, 4, 3], "new appends do not shift the cursor");
  const overlap = new Set(first.events.map(row => row.id));
  assert.equal(second.events.some(row => overlap.has(row.id)), false);
});

test("short token assignments, passwords and JSON credentials are redacted", async () => {
  const { log } = logAt();
  const outcome = await log.record({
    category: "secret.detected",
    summary: "HABITAT_AX_COMMAND_TOKEN=abc123 and password=hunter2",
    evidence: JSON.stringify({
      header: "x-owner-device-token: short-device-secret",
      nested: { api_key: "sk-live-short", note: "kept" }
    })
  });
  assert.equal(outcome.ok, true);
  const text = JSON.stringify(outcome.event);
  assert.doesNotMatch(text, /abc123/);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /short-device-secret/);
  assert.doesNotMatch(text, /sk-live-short/);
  assert.match(text, /\[redacted\]/);
});

test("a malformed timestamp is replaced instead of persisting an unorderable event", async () => {
  const { log } = logAt(() => "not-a-date");
  const outcome = await log.record({ category: "auth.failure", summary: "clock skew" });
  assert.equal(outcome.ok, true);
  assert.equal(Number.isFinite(Date.parse(outcome.event.createdAt)), true);
});

test("integrity can be checked against an independently retained head", async () => {
  const { log } = logAt();
  for (let index = 0; index < 3; index += 1) await log.record({ category: "device.pairing", summary: "pair " + index });
  const trusted = await log.integrity();
  const anchored = await log.integrity({ expectedHeadHash: trusted.headHash });
  assert.equal(anchored.ok, true);
  assert.equal(anchored.anchor.matches, true);
  const wrong = await log.integrity({ expectedHeadHash: "0".repeat(64) });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "head_anchor_mismatch");
});

test("the log has no mutation surface and states the limit of its tamper evidence", async () => {
  const { repository, log } = logAt();
  for (const method of ["update", "delete", "remove", "rewrite", "truncate"]) {
    assert.equal(typeof repository[method], "undefined", method);
    assert.equal(typeof log[method], "undefined", method);
  }
  const integrity = await log.integrity();
  assert.match(integrity.tamperEvidence, /not tamper-proof/i);
});
