import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTikTokAuthorizationUrl,
  buildTikTokOAuthStatus,
  registerTikTokOAuth,
  TIKTOK_REDIRECT_URI,
  TIKTOK_SCOPES
} from "../tiktok-oauth.mjs";

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectUrl = url; return this; }
  };
}

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(path, handler); }
  };
}

function fakeVault() {
  const records = new Map();
  return {
    durable: true,
    records,
    async set(key, value) { records.set(key, structuredClone(value)); return { ok: true }; },
    async get(key) { return records.has(key) ? structuredClone(records.get(key)) : null; },
    async delete(key) { records.delete(key); return { ok: true }; }
  };
}

test("TikTok authorization URL uses the registered callback and requested scopes", () => {
  const url = new URL(buildTikTokAuthorizationUrl({ clientKey: "client-key", state: "nonce" }));
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("client_key"), "client-key");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), TIKTOK_REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), "nonce");
  assert.deepEqual(url.searchParams.get("scope").split(","), TIKTOK_SCOPES);
});

test("TikTok status reports durable connection state without exposing tokens or secrets", () => {
  const status = buildTikTokOAuthStatus({
    clientKey: "private-client-key",
    clientSecret: "private-client-secret",
    tokens: { access_token: "private-access-token", scope: "user.info.basic,video.upload", connected_at: "2026-10-12T00:00:00Z" },
    vaultReady: true
  });
  assert.equal(status.configured, true);
  assert.equal(status.canConnect, true);
  assert.equal(status.connected, true);
  assert.equal(status.tokenStorage, "cloudflare-d1-aes-256-gcm");
  assert.deepEqual(status.scopes, ["user.info.basic", "video.upload"]);
  assert.deepEqual(status.requiredScopes, TIKTOK_SCOPES);
  assert.deepEqual(status.missingScopes, ["video.publish"]);
  assert.equal(status.scopesReady, false);
  assert.match(status.note, /missing required scopes.*video\.publish/i);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes("private-access-token"));
  assert.ok(!serialized.includes("private-client-secret"));
});

test("Connect TikTok persists single-use OAuth state in the durable vault", async () => {
  const oldKey = process.env.TIKTOK_CLIENT_KEY;
  const oldSecret = process.env.TIKTOK_CLIENT_SECRET;
  process.env.TIKTOK_CLIENT_KEY = "test-client-key";
  process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
  try {
    const app = fakeApp();
    const vault = fakeVault();
    registerTikTokOAuth(app, vault);
    const res = fakeResponse();
    await app.routes.get("/auth/tiktok")({ headers: {}, query: {} }, res);
    assert.equal(res.statusCode, 302);
    assert.match(res.headers["Set-Cookie"], /HttpOnly; Secure; SameSite=Lax/);
    const url = new URL(res.redirectUrl);
    const state = url.searchParams.get("state");
    assert.ok(state);
    assert.equal(url.searchParams.get("client_key"), "test-client-key");
    assert.ok(vault.records.has("tiktok_oauth_state:" + state));
    assert.equal(vault.records.get("tiktok_oauth_state:" + state).state, state);
  } finally {
    if (oldKey === undefined) delete process.env.TIKTOK_CLIENT_KEY; else process.env.TIKTOK_CLIENT_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.TIKTOK_CLIENT_SECRET; else process.env.TIKTOK_CLIENT_SECRET = oldSecret;
  }
});

test("TikTok callback rejects missing or mismatched OAuth state before token exchange", async () => {
  const app = fakeApp();
  registerTikTokOAuth(app, fakeVault());
  const res = fakeResponse();
  await app.routes.get("/auth/tiktok/callback")({ headers: { cookie: "habitat_tiktok_state=wrong" }, query: { code: "test-code", state: "different" } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /state check failed/i);
});

test("TikTok callback preserves missing granted scopes instead of assuming requested scopes were granted", async () => {
  const oldKey=process.env.TIKTOK_CLIENT_KEY,oldSecret=process.env.TIKTOK_CLIENT_SECRET;
  process.env.TIKTOK_CLIENT_KEY="test-client-key";process.env.TIKTOK_CLIENT_SECRET="test-client-secret";
  try {
    const app=fakeApp(),vault=fakeVault(),state="scope-state";
    await vault.set("tiktok_oauth_state:"+state,{state,expiresAt:Date.now()+60000});
    registerTikTokOAuth(app,vault);
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({access_token:"private-access-token",refresh_token:"refresh",expires_in:3600})});
    try {
      const res=fakeResponse();
      await app.routes.get("/auth/tiktok/callback")({headers:{cookie:"habitat_tiktok_state="+state},query:{code:"valid-code",state}},res);
      assert.equal(res.statusCode,200);
      const saved=await vault.get("tiktok_tokens");
      assert.equal(saved.scope,"");
      const status=buildTikTokOAuthStatus({clientKey:"test-client-key",clientSecret:"test-client-secret",tokens:saved,vaultReady:true});
      assert.equal(status.connected,true);
      assert.equal(status.scopesReady,false);
      assert.deepEqual(status.missingScopes,TIKTOK_SCOPES);
    } finally {globalThis.fetch=originalFetch;}
  } finally {if(oldKey===undefined)delete process.env.TIKTOK_CLIENT_KEY;else process.env.TIKTOK_CLIENT_KEY=oldKey;if(oldSecret===undefined)delete process.env.TIKTOK_CLIENT_SECRET;else process.env.TIKTOK_CLIENT_SECRET=oldSecret;}
});

test("TikTok profile verification fails closed when the basic profile scope is absent", async () => {
  const app = fakeApp();
  const vault = fakeVault();
  vault.records.set("tiktok_tokens", {
    access_token: "private-access-token",
    scope: "video.upload,video.publish"
  });
  registerTikTokOAuth(app, vault);
  const res = fakeResponse();
  await app.routes.get("/auth/tiktok/profile")({ headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.missingScope, "user.info.basic");
  assert.ok(!JSON.stringify(res.body).includes("private-access-token"));
});
