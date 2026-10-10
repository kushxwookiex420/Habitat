import test from "node:test";
import assert from "node:assert/strict";
import { createD1DispatchLeaseRepository } from "../d1-dispatch-lease-repository.mjs";

function fakeD1() {
  const rows = new Map();
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    calls.push({ sql, params });
    if (sql.startsWith("INSERT INTO habitat_dispatch_leases")) {
      const [scopeKey, leaseToken, claimedAt, expiresAt] = params;
      const current = rows.get(scopeKey);
      if (!current || current.expires_at <= claimedAt) {
        const next = { scope_key: scopeKey, lease_token: leaseToken, claimed_at: claimedAt, expires_at: expiresAt };
        rows.set(scopeKey, next);
        return response(true, [{ results: [{ scope_key: scopeKey, lease_token: leaseToken, expires_at: expiresAt }], meta: { changes: 1 } }]);
      }
      return response(true, [{ results: [], meta: { changes: 0 } }]);
    }
    if (sql.startsWith("DELETE FROM habitat_dispatch_leases")) {
      const [scopeKey, leaseToken] = params;
      const current = rows.get(scopeKey);
      const removed = Boolean(current && current.lease_token === leaseToken);
      if (removed) rows.delete(scopeKey);
      return response(true, [{ meta: { changes: removed ? 1 : 0 } }]);
    }
    return response(true, [{ results: [{ ok: 1 }], meta: { changes: 0 } }]);
  };
  return { fetchImpl, rows, calls };
}

function response(success, result) {
  return {
    ok: success,
    status: success ? 200 : 400,
    async json() { return { success, result }; }
  };
}

const config = { accountId: "account", databaseId: "database", apiToken: "test-only-token" };

test("D1 dispatch lease repository requires durable storage credentials", () => {
  assert.throws(() => createD1DispatchLeaseRepository({}), /CLOUDFLARE_ACCOUNT_ID/);
});

test("only one claimant can hold a scope until expiry", async () => {
  const fake = fakeD1();
  const repoA = createD1DispatchLeaseRepository({ ...config, fetchImpl: fake.fetchImpl });
  const repoB = createD1DispatchLeaseRepository({ ...config, fetchImpl: fake.fetchImpl });
  await repoA.initialize();

  const attempts = await Promise.all([
    repoA.acquire({
      scopeKey: "DropPilotAI:tiktok:2026-10-10T18:00Z",
      leaseToken: "token-a",
      nowIso: "2026-10-10T17:59:00.000Z",
      expiresAt: "2026-10-10T18:10:00.000Z"
    }),
    repoB.acquire({
      scopeKey: "DropPilotAI:tiktok:2026-10-10T18:00Z",
      leaseToken: "token-b",
      nowIso: "2026-10-10T17:59:00.000Z",
      expiresAt: "2026-10-10T18:10:00.000Z"
    })
  ]);

  assert.equal(attempts.filter(attempt => attempt.acquired).length, 1);
  assert.equal(attempts.filter(attempt => !attempt.acquired && attempt.reason === "lease_already_held").length, 1);
});

test("expired lease can be reclaimed but an old owner cannot release the new lease", async () => {
  const fake = fakeD1();
  const repo = createD1DispatchLeaseRepository({ ...config, fetchImpl: fake.fetchImpl });
  const scopeKey = "ViceCityFiles:tiktok:2026-10-10T18:00Z";
  await repo.acquire({ scopeKey, leaseToken: "old", nowIso: "2026-10-10T17:00:00.000Z", expiresAt: "2026-10-10T17:05:00.000Z" });
  const replacement = await repo.acquire({ scopeKey, leaseToken: "new", nowIso: "2026-10-10T17:05:00.000Z", expiresAt: "2026-10-10T17:10:00.000Z" });

  assert.equal(replacement.acquired, true);
  assert.equal(await repo.release({ scopeKey, leaseToken: "old" }), false);
  assert.equal(await repo.release({ scopeKey, leaseToken: "new" }), true);
});

test("project/platform/window keys are isolated and invalid lease input is rejected", async () => {
  const fake = fakeD1();
  const repo = createD1DispatchLeaseRepository({ ...config, fetchImpl: fake.fetchImpl });
  const common = { nowIso: "2026-10-10T17:00:00.000Z", expiresAt: "2026-10-10T17:05:00.000Z" };
  const a = await repo.acquire({ ...common, scopeKey: "DropPilotAI:tiktok:18:00", leaseToken: "a" });
  const b = await repo.acquire({ ...common, scopeKey: "ViceCityFiles:tiktok:18:00", leaseToken: "b" });

  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true);
  await assert.rejects(repo.acquire({ ...common, scopeKey: "bad", leaseToken: "expired", expiresAt: common.nowIso }), /expiry must be later/);
});

test("lease health check uses D1 without exposing credentials in SQL", async () => {
  const fake = fakeD1();
  const repo = createD1DispatchLeaseRepository({ ...config, fetchImpl: fake.fetchImpl });
  assert.equal((await repo.healthCheck()).durable, true);
  assert.ok(fake.calls.every(call => !JSON.stringify(call).includes(config.apiToken)));
});
