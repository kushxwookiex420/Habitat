import test from "node:test";
import assert from "node:assert/strict";
import { collectFindings, improvementPass, rankImprovements, SEVERITY_WEIGHTS } from "../ax-improvement.mjs";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

const cleanStatus = () => ({
  components: {
    workers: {
      execution: { configured: true, state: "configured", detail: "Executor mounted." },
      items: [
        { id: "habitat-qa-worker", state: "idle", configured: true, healthy: false },
        { id: "vicecity-topic-scout", state: "healthy", configured: true, healthy: true }
      ],
      counts: { healthy: 1, idle: 1 }
    },
    storage: { taskRepositoryReady: true, contentJobRepositoryReady: true, dispatchLeaseReady: true, secretVaultReady: true },
    device: { paired: 1, recentlySeen: true, lastSeenAt: "2026-11-24T11:59:00.000Z" }
  },
  requiredConfiguration: { allPresent: true, missing: [] }
});

test("a clean report produces no findings and says the signals were clean", () => {
  const result = collectFindings({ systemStatus: cleanStatus(), now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.counts.total, 0);
  assert.match(result.note, /not that the system is perfect/i);
});

test("no executor is a critical finding that blocks queued work", () => {
  const status = cleanStatus();
  status.components.workers.execution = { configured: false, state: "unavailable", detail: "No executor is mounted; queued work will not run." };
  const result = collectFindings({ systemStatus: status, now: NOW });
  const finding = result.findings.find(item => item.kind === "execution_blocked");
  assert.ok(finding);
  assert.equal(finding.severity, "critical");
  assert.ok(finding.evidence.some(item => item.includes("execution.configured=false")));
  assert.equal(result.counts.critical, 1);
});

test("an unavailable worker is reported with its identity as evidence", () => {
  const status = cleanStatus();
  status.components.workers.items.push({ id: "vicecity-publisher", state: "unavailable", configured: false, detail: "Missing channel token." });
  const result = collectFindings({ systemStatus: status, now: NOW });
  const finding = result.findings.find(item => item.kind === "capability_unavailable");
  assert.equal(finding.subject, "vicecity-publisher");
  assert.match(finding.detail, /Missing channel token/);
  assert.ok(finding.evidence.some(item => item.includes("state=unavailable")));
});

test("a store that is not ready is a durability finding naming every store", () => {
  const status = cleanStatus();
  status.components.storage.dispatchLeaseReady = false;
  status.components.storage.secretVaultReady = false;
  const result = collectFindings({ systemStatus: status, now: NOW });
  const finding = result.findings.find(item => item.kind === "durability_gap");
  assert.equal(finding.severity, "critical");
  assert.deepEqual(finding.evidence.sort(), ["storage.dispatchLeaseReady=false", "storage.secretVaultReady=false"]);
});

test("missing configuration is reported by name only", () => {
  const status = cleanStatus();
  status.requiredConfiguration = { allPresent: false, missing: ["GROQ_API_KEY", "NEXUS_RUNTIME_ENABLED"] };
  const result = collectFindings({ systemStatus: status, now: NOW });
  const finding = result.findings.find(item => item.kind === "configuration_missing");
  assert.match(finding.detail, /GROQ_API_KEY/);
  assert.ok(finding.evidence.every(item => item.startsWith("missing ")));
  assert.equal(JSON.stringify(finding).includes("sk-"), false);
});

test("paired devices that went silent are a medium finding with the last check-in", () => {
  const status = cleanStatus();
  status.components.device = { paired: 2, recentlySeen: false, lastSeenAt: "2026-11-20T08:00:00.000Z" };
  const result = collectFindings({ systemStatus: status, now: NOW });
  const finding = result.findings.find(item => item.kind === "device_silent");
  assert.equal(finding.severity, "medium");
  assert.ok(finding.evidence.includes("device.paired=2"));
  assert.ok(finding.evidence.some(item => item.includes("2026-11-20")));
});

test("only approvals that actually expired are reported", () => {
  const result = collectFindings({
    approvals: [
      { id: "ap_1", state: "pending", expiresAt: "2026-11-24T13:00:00.000Z" },
      { id: "ap_2", state: "pending", expiresAt: "2026-11-24T11:00:00.000Z" },
      { id: "ap_3", state: "approved", expiresAt: "2026-11-24T10:00:00.000Z" }
    ],
    now: NOW
  });
  const finding = result.findings.find(item => item.kind === "approval_expired");
  assert.equal(finding.evidence.length, 1);
  assert.match(finding.evidence[0], /ap_2/);
});

test("a queued task past the claim window is stale, a fresh one is not", () => {
  const result = collectFindings({
    tasks: [
      { id: "t_old", status: "queued", createdAt: "2026-11-24T10:00:00.000Z" },
      { id: "t_new", status: "queued", createdAt: "2026-11-24T11:55:00.000Z" },
      { id: "t_done", status: "verified", createdAt: "2026-11-24T09:00:00.000Z" }
    ],
    now: NOW
  });
  const finding = result.findings.find(item => item.kind === "task_stale");
  assert.equal(finding.evidence.length, 1);
  assert.match(finding.evidence[0], /t_old/);
});

test("a failed verification check is a high finding", () => {
  const result = collectFindings({
    checks: [{ name: "health", ok: true }, { name: "worker-claim", ok: false, detail: "No worker claimed the task." }],
    now: NOW
  });
  const finding = result.findings.find(item => item.kind === "check_failed");
  assert.equal(finding.severity, "high");
  assert.match(finding.title, /worker-claim/);
  assert.match(finding.detail, /No worker claimed/);
});

test("the same signal twice is one finding, and ids are deterministic", () => {
  const status = cleanStatus();
  status.components.workers.items.push({ id: "dup-worker", state: "unavailable", configured: false });
  status.components.workers.items.push({ id: "dup-worker", state: "unavailable", configured: false });
  const first = collectFindings({ systemStatus: status, now: NOW });
  const second = collectFindings({ systemStatus: status, now: NOW });
  assert.equal(first.findings.filter(item => item.kind === "capability_unavailable").length, 1);
  assert.equal(first.findings.find(item => item.kind === "capability_unavailable").id, second.findings.find(item => item.kind === "capability_unavailable").id);
});

test("no signals means no findings and an explicit reason", () => {
  const result = collectFindings({ now: NOW });
  assert.deepEqual(result.findings, []);
  assert.equal(result.ignored[0].code, "no_signals_supplied");
});

test("every finding carries evidence and a severity this engine knows", () => {
  const status = cleanStatus();
  status.components.workers.execution = { configured: false };
  status.components.storage = { taskRepositoryReady: false };
  status.requiredConfiguration.missing = ["CLOUDFLARE_API_TOKEN"];
  const result = improvementPass({ systemStatus: status, now: NOW });
  assert.ok(result.findings.length >= 3);
  for (const finding of result.findings) {
    assert.ok(SEVERITY_WEIGHTS[finding.severity] > 0);
    assert.ok(finding.evidence.length > 0, "a finding without evidence is not a finding");
    assert.match(finding.id, /^imp:[a-z_]+:[0-9a-f]{8}$/);
  }
});

test("ranking puts critical before medium and is labelled a heuristic, not a valuation", () => {
  const status = cleanStatus();
  status.components.device = { paired: 1, recentlySeen: false };
  status.components.workers.execution = { configured: false };
  const result = improvementPass({ systemStatus: status, now: NOW });
  assert.equal(result.next[0].severity, "critical");
  assert.equal(result.method, "severity weight divided by effort hours; a triage order, not a monetary valuation");
  assert.ok(result.next[0].score >= result.next[result.next.length - 1].score);
});

test("effort changes the triage order at equal severity", () => {
  const ranked = rankImprovements({
    findings: [
      { id: "a", severity: "high", evidence: ["e"], effortHours: 8 },
      { id: "b", severity: "high", evidence: ["e"], effortHours: 1 }
    ]
  });
  assert.deepEqual(ranked.ranked.map(item => item.id), ["b", "a"]);
  assert.equal(ranked.ranked[0].score, 3);
  assert.equal(ranked.ranked[1].score, 0.38);
});

test("a finding without evidence is refused at ranking, not ranked low", () => {
  const ranked = rankImprovements({ findings: [{ id: "x", severity: "critical", evidence: [] }] });
  assert.deepEqual(ranked.ranked, []);
  assert.match(ranked.note, /Nothing is invented/i);
});

test("maxItems bounds the next-work list without dropping the backlog", () => {
  const status = cleanStatus();
  status.components.workers.execution = { configured: false };
  status.components.storage = { taskRepositoryReady: false, dispatchLeaseReady: false };
  status.requiredConfiguration.missing = ["GROQ_API_KEY"];
  const result = improvementPass({ systemStatus: status, now: NOW, maxItems: 2 });
  assert.equal(result.next.length, 2);
  assert.ok(result.ranked.length > 2);
});
