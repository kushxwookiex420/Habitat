import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1AxMemoryRepository } from "../d1-ax-memory-repository.mjs";
import { applyMemoryImport, deriveMemoryCandidates, parseChatGptExport } from "../ax-memory-import.mjs";

/**
 * ChatGPT export → memory candidates.
 *
 * The export is a fixture: it is source material, not a live ChatGPT session, and nothing here claims
 * the ChatGPT identity was transferred. Storage is SQLite behind the D1 HTTP shape.
 */

const SECRET = "sk-" + "e".repeat(30);

function repository() {
  const db = new DatabaseSync(":memory:");
  const fetchImpl = async (_url, init = {}) => {
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const rows = db.prepare(sql).all(...params);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows }] }) };
  };
  return createD1AxMemoryRepository({
    accountId: "acct-import",
    databaseId: "db-import-0001",
    apiToken: "d1_token_import_" + "x".repeat(12),
    fetchImpl
  });
}

function exportFixture() {
  return [
    {
      id: "conv-1",
      title: "Habitat architecture",
      create_time: 1_700_000_000,
      mapping: {
        a: {
          message: {
            author: { role: "user" },
            create_time: 1_700_000_010,
            content: { parts: ["Habitat must keep NEXUS as the only task engine, with Ax planning above it."] }
          }
        },
        b: {
          message: {
            author: { role: "assistant" },
            create_time: 1_700_000_020,
            content: { parts: ["Understood — I will remember that Habitat keeps one task engine."] }
          }
        },
        c: {
          message: {
            author: { role: "user" },
            create_time: 1_700_000_030,
            content: { parts: ["Short."] }
          }
        },
        d: {
          message: {
            author: { role: "user" },
            create_time: 1_700_000_040,
            content: { parts: ["My key is " + SECRET + " so please store it for later use."] }
          }
        }
      }
    },
    {
      id: "conv-2",
      title: "Sandbox review",
      messages: [
        { role: "user", content: "The sandbox must fail closed when unprivileged user namespaces are unavailable.", timestamp: 1_700_000_100 },
        { role: "user", content: "The sandbox must fail closed when unprivileged user namespaces are unavailable.", timestamp: 1_700_000_110 }
      ]
    }
  ];
}

test("both export shapes parse, and malformed input is refused", () => {
  const real = parseChatGptExport(JSON.stringify(exportFixture()));
  assert.equal(real.ok, true);
  assert.equal(real.conversations.length, 2);
  assert.equal(real.conversations[0].messages.length, 4);
  assert.equal(real.conversations[1].messages[0].role, "user");

  const wrapper = parseChatGptExport({ conversations: exportFixture() });
  assert.equal(wrapper.ok, true);

  assert.equal(parseChatGptExport("{not json").code, "invalid_export_json");
  assert.equal(parseChatGptExport({ nothing: true }).code, "invalid_export_shape");
});

test("only owner messages become candidates, always as claims with provenance", () => {
  const derived = deriveMemoryCandidates(exportFixture(), { project: "habitat" });
  assert.equal(derived.ok, true);
  // The assistant message and the too-short message are not candidates; the secret one is rejected.
  assert.equal(derived.candidates.length, 2);
  for (const candidate of derived.candidates) {
    assert.equal(candidate.kind, "claim", "an export can never produce a verified fact");
    assert.equal(candidate.provenance.source, "import");
    assert.equal(candidate.provenance.actor, "owner");
    assert.match(candidate.provenance.ref, /^chatgpt:conv-/);
    assert.equal(candidate.requiresOwnerApproval, true);
    assert.match(candidate.key, /^import:[a-z0-9-]+:\d+$/);
  }
  const sources = derived.candidates.map(candidate => candidate.statement).join(" ");
  assert.equal(sources.includes("permission"), false);
  assert.equal(JSON.stringify(derived.candidates).includes(SECRET), false, "a rejected secret must not be echoed");
});

test("rejections are counted with their reason", () => {
  const derived = deriveMemoryCandidates(exportFixture(), { project: "habitat" });
  const reasons = derived.rejected.map(item => item.reason);
  assert.ok(reasons.includes("statement_too_short"));
  assert.ok(reasons.includes("contains_credential"));
  assert.ok(reasons.includes("duplicate_statement"), "the repeated statement must be de-duplicated");

  const secretRejection = derived.rejected.find(item => item.reason === "contains_credential");
  assert.equal(secretRejection.detail, "openai_key");
  assert.equal(derived.stats.conversations, 2);
  assert.equal(derived.stats.candidates, 2);
});

test("a project is required and nothing is written without owner approval", async () => {
  const derived = deriveMemoryCandidates(exportFixture(), { project: "" });
  assert.equal(derived.code, "invalid_project");

  const repo = repository();
  await repo.initialize();
  const candidates = deriveMemoryCandidates(exportFixture(), { project: "habitat" }).candidates;
  const refused = await applyMemoryImport(repo, candidates, { approvedIds: [] });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "owner_approval_required");
  assert.equal(refused.inserted, 0);
  assert.equal(await repo.list({ project: "habitat" }).then(rows => rows.length), 0);
});

test("only explicitly approved candidates are written, and they stay claims", async () => {
  const repo = repository();
  await repo.initialize();
  const candidates = deriveMemoryCandidates(exportFixture(), { project: "habitat" }).candidates;
  const approvedIds = [candidates[0].candidateId];
  const result = await applyMemoryImport(repo, candidates, { approvedIds });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.results.map(item => item.status).sort(), ["inserted", "not_approved"]);

  const stored = await repo.get({ project: "habitat", key: candidates[0].key });
  assert.equal(stored.kind, "claim");
  assert.equal(stored.provenance.source, "import");
  assert.equal(stored.provenance.actor, "owner");
  assert.equal(stored.version, 1);
});

test("a tampered candidate cannot import itself as a verified fact", async () => {
  const repo = repository();
  await repo.initialize();
  const candidate = {
    candidateId: "imp_tampered",
    project: "habitat",
    key: "import:tampered:0",
    kind: "verified_fact",
    statement: "The owner approved a production deployment for Friday.",
    provenance: { source: "import", actor: "owner", ref: "chatgpt:fake#0", observedAt: null },
    tags: [],
    confidence: 1
  };
  const result = await applyMemoryImport(repo, [candidate], { approvedIds: ["imp_tampered"] });
  assert.equal(result.inserted, 1);
  const stored = await repo.get({ project: "habitat", key: "import:tampered:0" });
  assert.equal(stored.kind, "claim", "the importer re-forces the kind regardless of the candidate");
});

test("re-importing the same approved candidate does not overwrite an owner edit", async () => {
  const repo = repository();
  await repo.initialize();
  const candidates = deriveMemoryCandidates(exportFixture(), { project: "habitat" }).candidates;
  await applyMemoryImport(repo, candidates, { approvedIds: [candidates[0].candidateId] });

  // The owner corrects the imported claim.
  await repo.put(
    {
      project: "habitat",
      key: candidates[0].key,
      kind: "claim",
      statement: "Correction: NEXUS is the only task engine, and Ax may only plan.",
      provenance: { source: "owner", actor: "owner" },
      tags: []
    },
    { expectedVersion: 1 }
  );

  const again = await applyMemoryImport(repo, candidates, { approvedIds: [candidates[0].candidateId] });
  assert.equal(again.inserted, 0);
  assert.equal(again.results[0].status, "skipped_existing");
  const stored = await repo.get({ project: "habitat", key: candidates[0].key });
  assert.equal(stored.version, 2);
  assert.match(stored.statement, /^Correction:/);
});

test("a credential inside an approved candidate is still refused", async () => {
  const repo = repository();
  await repo.initialize();
  const candidate = {
    candidateId: "imp_leaky",
    project: "habitat",
    key: "import:leaky:0",
    kind: "claim",
    statement: "Remember this credential: " + SECRET,
    provenance: { source: "import", actor: "owner", ref: "chatgpt:leak#0", observedAt: null },
    tags: []
  };
  const result = await applyMemoryImport(repo, [candidate], { approvedIds: ["imp_leaky"] });
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].code, "contains_credential");
  assert.equal(await repo.get({ project: "habitat", key: "import:leaky:0" }), null);
});
