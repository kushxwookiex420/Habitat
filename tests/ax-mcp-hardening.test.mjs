import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createMcpRepository } from "../d1-mcp-repository.mjs";
import { createMcpEventsServer } from "../ax-mcp-events.mjs";
import { createSecretBox, secretBoxFromEnv, mcpSecretConfiguration, MCP_SECRET_KEY_ENV, MCP_SECRET_KEYS_ENV } from "../ax-secret-box.mjs";
import { createPinnedCallbackFetch, isPrivateAddress } from "../ax-callback-fetch.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const START = Date.parse("2026-11-24T18:00:00.000Z");
const KEY_ONE = Buffer.alloc(32, 3).toString("base64");
const KEY_TWO = Buffer.alloc(32, 5).toString("base64");
const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");

function db() {
  const database = new DatabaseSync(":memory:");
  const query = async (sql, params = []) => {
    const statement = database.prepare(sql);
    if (/^\s*select/i.test(sql)) return statement.all(...params);
    return [{ changes: Number(statement.run(...params).changes || 0) }];
  };
  return { database, query };
}

async function receiver({ delayMs = 0 } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (parsed?.type === "verification") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ challenge: parsed.challenge }));
      }
      received.push({ body, parsed, headers: req.headers });
      setTimeout(() => { res.writeHead(202); res.end("ok"); }, delayMs);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return { received, url: "http://127.0.0.1:" + server.address().port + "/callback", close: () => new Promise(resolve => server.close(resolve)) };
}

async function mcpHarness({ secretBox = null, owner = null } = {}) {
  const { database, query } = db();
  const clock = { value: START };
  const repo = createMcpRepository({ query, now: () => new Date(clock.value).toISOString(), secretBox });
  await repo.initialize();
  const server = createMcpEventsServer({ repository: repo, now: () => clock.value, allowInsecureCallbacks: true, retryBaseMs: 1000, log: quiet, owner: owner || undefined });
  return { database, query, repo, server, clock };
}

async function subscribe(server, url, secret = SECRET) {
  return server.handleRpc({
    jsonrpc: "2.0", id: 1, method: "events/subscribe",
    params: { name: "mission.completed", arguments: { project: "habitat" }, delivery: { mode: "webhook", url, secret }, cursor: null }
  }, { principal: "gw-alpha" });
}

test("secret configuration rejects weak, malformed and ambiguous keys", () => {
  assert.equal(mcpSecretConfiguration({ env: {} }).reason, "secret_encryption_not_configured");
  assert.equal(mcpSecretConfiguration({ env: { [MCP_SECRET_KEY_ENV]: "short" } }).reason, "secret_key_invalid");
  assert.equal(mcpSecretConfiguration({ env: { [MCP_SECRET_KEYS_ENV]: "{oops" } }).reason, "secret_keys_malformed");
  const twoActive = JSON.stringify([{ keyId: "a", key: KEY_ONE, status: "active" }, { keyId: "b", key: KEY_TWO, status: "active" }]);
  assert.equal(mcpSecretConfiguration({ env: { [MCP_SECRET_KEYS_ENV]: twoActive } }).reason, "secret_key_active_ambiguous");
  assert.equal(secretBoxFromEnv({ env: { [MCP_SECRET_KEY_ENV]: "short" } }).ok, false);
  assert.equal(secretBoxFromEnv({ env: { [MCP_SECRET_KEY_ENV]: KEY_ONE } }).ok, true);
});

test("AES-256-GCM encrypts, decrypts, binds AAD and detects tampering", () => {
  const box = createSecretBox({ keys: [{ keyId: "k1", key: KEY_ONE, status: "active" }] });
  const envelope = box.encrypt(SECRET, { aad: "mcp:sub_a:secret" });
  assert.match(envelope, /^v1:k1:/);
  assert.doesNotMatch(envelope, /whsec_/);
  assert.equal(box.decrypt(envelope, { aad: "mcp:sub_a:secret" }).plaintext, SECRET);
  assert.equal(box.decrypt(envelope, { aad: "mcp:sub_b:secret" }).code, "secret_decryption_failed");
  const parts = envelope.split(":");
  const tamperedCipher = [...parts]; tamperedCipher[4] = Buffer.from("not the ciphertext").toString("base64");
  assert.equal(box.decrypt(tamperedCipher.join(":"), { aad: "mcp:sub_a:secret" }).code, "secret_decryption_failed");
  const tamperedTag = [...parts]; tamperedTag[3] = Buffer.alloc(16, 1).toString("base64");
  assert.equal(box.decrypt(tamperedTag.join(":"), { aad: "mcp:sub_a:secret" }).code, "secret_decryption_failed");
  assert.equal(box.decrypt("not-an-envelope").code, "secret_ciphertext_invalid");
});

test("key rotation keeps old ciphertext readable and revocation refuses it", () => {
  const oldBox = createSecretBox({ keys: [{ keyId: "k1", key: KEY_ONE, status: "active" }] });
  const envelope = oldBox.encrypt(SECRET, { aad: "mcp:sub:secret" });

  const rotated = createSecretBox({
    keys: [{ keyId: "k1", key: KEY_ONE, status: "retired" }, { keyId: "k2", key: KEY_TWO, status: "active" }]
  });
  assert.equal(rotated.decrypt(envelope, { aad: "mcp:sub:secret" }).plaintext, SECRET);
  assert.equal(rotated.encrypt(SECRET, { aad: "mcp:sub:secret" }).split(":")[1], "k2");

  const revoked = createSecretBox({
    keys: [{ keyId: "k1", key: KEY_ONE, status: "active" }],
    revokedKeyIds: ["k1"]
  });
  assert.equal(revoked, null, "revoking the only active key leaves no signer");
  const revokedAfterRotation = createSecretBox({
    keys: [{ keyId: "k1", key: KEY_ONE, status: "retired" }, { keyId: "k2", key: KEY_TWO, status: "active" }],
    revokedKeyIds: ["k1"]
  });
  assert.equal(revokedAfterRotation.decrypt(envelope, { aad: "mcp:sub:secret" }).code, "secret_key_revoked");
});

test("subscription signing secrets are ciphertext at rest and unreadable with the wrong key", async () => {
  const box = createSecretBox({ keys: [{ keyId: "k1", key: KEY_ONE, status: "active" }] });
  const h = await mcpHarness({ secretBox: box });
  const receiverRef = await receiver();
  const subscribed = await subscribe(h.server, receiverRef.url);
  assert.equal(subscribed.error, undefined);

  const raw = h.database.prepare("SELECT secret, previous_secret FROM habitat_ax_mcp_subscriptions WHERE id = ?").get(subscribed.result.id);
  assert.match(raw.secret, /^v1:k1:/);
  assert.doesNotMatch(raw.secret, /whsec_/);
  const stored = await h.repo.getSubscription(subscribed.result.id);
  assert.equal(stored.secret, SECRET);
  assert.equal(stored.secretUnreadable, false);

  const wrong = createSecretBox({ keys: [{ keyId: "k1", key: KEY_TWO, status: "active" }] });
  const wrongRepo = createMcpRepository({ query: h.query, now: () => new Date(h.clock.value).toISOString(), secretBox: wrong });
  const wrongServer = createMcpEventsServer({ repository: wrongRepo, now: () => h.clock.value, allowInsecureCallbacks: true, log: quiet });
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_wrong_key" } });
  const result = await wrongServer.dispatch();
  assert.equal(result.dead, 1);
  const deliveries = await wrongRepo.listDeliveries({});
  assert.equal(deliveries[0].lastError, "signing_secret_unreadable");
  assert.equal(receiverRef.received.length, 0, "a secret that cannot decrypt must never be signed with");
  h.database.close();
  await receiverRef.close();
});

test("pinned fetch rejects private, loopback, link-local, metadata and mapped addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "2001:db8::1", "not-an-ip"]) {
    assert.equal(isPrivateAddress(address), true, address + " must be refused");
  }
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("pinned fetch resolves once, refuses a private result and never follows redirects", async () => {
  let lookups = 0;
  const pinned = createPinnedCallbackFetch({
    allowInsecure: false,
    resolveHost: async () => { lookups += 1; return [{ address: "127.0.0.1", family: 4 }]; }
  });
  await assert.rejects(() => pinned("https://callback.example/events", { body: "{}" }), /private_address_forbidden/);
  assert.equal(lookups, 1);

  const redirectServer = createServer((req, res) => { res.writeHead(302, { location: "https://evil.example/steal" }); res.end(); });
  await new Promise(resolve => redirectServer.listen(0, "127.0.0.1", resolve));
  redirectServer.unref();
  const localPinned = createPinnedCallbackFetch({ allowInsecure: true });
  await assert.rejects(() => localPinned("http://127.0.0.1:" + redirectServer.address().port + "/cb", { body: "{}" }), /redirect_forbidden/);
  await new Promise(resolve => redirectServer.close(resolve));

  await assert.rejects(() => pinned("https://user:pass@callback.example/events", { body: "{}" }), /url_credentials_forbidden/);
  await assert.rejects(() => pinned("https://callback.example/events#frag", { body: "{}" }), /url_fragment_forbidden/);
  await assert.rejects(() => createPinnedCallbackFetch({ allowInsecure: false })("http://callback.example/events", { body: "{}" }), /https_required/);
});

test("pinned fetch delivers to a public-style pinned address and preserves the request", async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { received.push({ body, headers: req.headers }); res.writeHead(200); res.end("ok"); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const pinned = createPinnedCallbackFetch({ allowInsecure: true });
  const response = await pinned("http://127.0.0.1:" + server.address().port + "/cb", { headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) });
  assert.equal(response.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].body, JSON.stringify({ hello: "world" }));
  assert.match(received[0].headers.host, /^127\.0\.0\.1:/);
  await new Promise(resolve => server.close(resolve));
});

test("concurrent workers claim each delivery once", async () => {
  const h = await mcpHarness();
  const receiverRef = await receiver({ delayMs: 40 });
  await subscribe(h.server, receiverRef.url);
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_concurrent" } });
  const workerA = createMcpEventsServer({ repository: h.repo, now: () => h.clock.value, allowInsecureCallbacks: true, owner: "worker-a", log: quiet });
  const workerB = createMcpEventsServer({ repository: h.repo, now: () => h.clock.value, allowInsecureCallbacks: true, owner: "worker-b", log: quiet });
  const results = await Promise.all([workerA.dispatch(), workerB.dispatch()]);
  const delivered = results.reduce((total, result) => total + result.delivered, 0);
  assert.equal(delivered, 1);
  assert.equal(receiverRef.received.length, 1);
  h.database.close();
  await receiverRef.close();
});

test("a live lease blocks another worker; an expired lease is reclaimed after a crash", async () => {
  const h = await mcpHarness();
  const receiverRef = await receiver();
  await subscribe(h.server, receiverRef.url);
  await h.server.emit({ name: "mission.completed", data: { project: "habitat", missionId: "msn_lease" } });
  const [delivery] = await h.repo.dueDeliveries({ at: new Date(h.clock.value).toISOString() });
  const claimed = await h.repo.claimDelivery(delivery.id, { owner: "worker-a", leaseMs: 60_000, at: new Date(h.clock.value).toISOString() });
  assert.equal(claimed.claimed, true);
  const blocked = await h.repo.claimDelivery(delivery.id, { owner: "worker-b", leaseMs: 60_000, at: new Date(h.clock.value).toISOString() });
  assert.equal(blocked.claimed, false);

  // Worker A crashed without delivering. After the lease expires, a new worker resumes it.
  h.clock.value += 61_000;
  const workerB = createMcpEventsServer({ repository: h.repo, now: () => h.clock.value, allowInsecureCallbacks: true, owner: "worker-b", log: quiet });
  const result = await workerB.dispatch();
  assert.equal(result.delivered, 1);
  assert.equal(receiverRef.received.length, 1);
  assert.equal((await h.repo.getDelivery(delivery.id)).status, "delivered");
  h.database.close();
  await receiverRef.close();
});
