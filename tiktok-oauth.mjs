import crypto from "node:crypto";

export const TIKTOK_REDIRECT_URI = "https://habitat-1-szzd.onrender.com/auth/tiktok/callback";
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload", "video.publish"];

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const STATE_TTL_MS = 10 * 60 * 1000;

function readCookie(req, name) {
  const cookies = String(req.headers?.cookie || "").split(";");
  for (const item of cookies) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) {
      try { return decodeURIComponent(item.slice(index + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

function writeStateCookie(res, state) {
  res.setHeader("Set-Cookie", `habitat_tiktok_state=${encodeURIComponent(state)}; Max-Age=600; Path=/auth/tiktok; HttpOnly; Secure; SameSite=Lax`);
}

function clearStateCookie(res) {
  res.setHeader("Set-Cookie", "habitat_tiktok_state=; Max-Age=0; Path=/auth/tiktok; HttpOnly; Secure; SameSite=Lax");
}

export function buildTikTokAuthorizationUrl({ clientKey, state, redirectUri = TIKTOK_REDIRECT_URI }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_key", String(clientKey || "").trim());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", String(state || ""));
  return url.toString();
}

export function buildTikTokOAuthStatus({ clientKey, clientSecret, tokens, vaultReady }) {
  const credentialsConfigured = Boolean(String(clientKey || "").trim() && String(clientSecret || "").trim());
  const tokenPresent = Boolean(tokens?.access_token || String(process.env.TIKTOK_ACCESS_TOKEN || "").trim());
  const grantedScopes = tokens?.scope ? String(tokens.scope).split(/[ ,]+/).filter(Boolean) : [];
  const missingScopes = tokenPresent
    ? TIKTOK_SCOPES.filter(scope => !grantedScopes.includes(scope))
    : [];
  return {
    ok: true,
    configured: credentialsConfigured,
    credentialsConfigured,
    durableStorageReady: vaultReady === true,
    canConnect: credentialsConfigured && vaultReady === true,
    connected: tokenPresent,
    redirectUri: TIKTOK_REDIRECT_URI,
    scopes: tokenPresent ? grantedScopes : TIKTOK_SCOPES,
    requiredScopes: TIKTOK_SCOPES,
    missingScopes,
    scopesReady: tokenPresent && missingScopes.length === 0,
    tokenStorage: vaultReady === true ? "cloudflare-d1-aes-256-gcm" : tokenPresent ? "environment-only" : "unavailable",
    connectedAt: tokens?.connected_at || null,
    accessTokenExpiresAt: tokens?.access_token_expires_at ? Number(tokens.access_token_expires_at) : null,
    note: !credentialsConfigured
      ? "TikTok client credentials are missing."
      : vaultReady !== true
        ? "Durable encrypted token storage is unavailable; connect is disabled."
        : tokenPresent && missingScopes.length > 0
          ? "The saved TikTok authorization is missing required scopes: " + missingScopes.join(", ") + ". Reconnect after enabling every required scope in TikTok Developer settings."
          : tokenPresent
            ? "All required scopes are granted. Run creator-info preflight before attempting to publish."
            : "Ready to begin TikTok authorization; provider approval and account eligibility still apply."
  };
}

export function registerTikTokOAuth(app, secretVault = null) {
  const vaultReady = secretVault?.durable === true &&
    typeof secretVault.get === "function" &&
    typeof secretVault.set === "function" &&
    typeof secretVault.delete === "function";

  app.get("/auth/tiktok/status", async (_req, res) => {
    try {
      const tokens = vaultReady ? await secretVault.get("tiktok_tokens") : null;
      return res.json(buildTikTokOAuthStatus({
        clientKey: process.env.TIKTOK_CLIENT_KEY,
        clientSecret: process.env.TIKTOK_CLIENT_SECRET,
        tokens,
        vaultReady
      }));
    } catch (error) {
      console.error("TIKTOK_OAUTH_STATUS_FAILED", String(error?.message || error));
      return res.status(503).json({
        ok: false,
        configured: Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),
        connected: false,
        tokenStorage: "unavailable",
        error: "TikTok connection status could not be read from durable storage."
      });
    }
  });

  app.get("/auth/tiktok/profile", async (_req, res) => {
    if (!vaultReady) return res.status(503).json({ ok:false, error:"Encrypted TikTok token storage is unavailable." });
    try {
      const tokens = await secretVault.get("tiktok_tokens");
      const token = String(tokens?.access_token || process.env.TIKTOK_ACCESS_TOKEN || "").trim();
      if (!token) return res.status(401).json({ ok:false, error:"TikTok is not connected." });
      const grantedScopes = String(tokens?.scope || "").split(/[ ,]+/).filter(Boolean);
      if (!grantedScopes.includes("user.info.basic")) {
        return res.status(403).json({ ok:false, error:"The saved TikTok authorization is missing user.info.basic. Reconnect after enabling that scope.", missingScope:"user.info.basic" });
      }
      const fields = "open_id,display_name,avatar_url";
      const response = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=" + encodeURIComponent(fields), {
        method: "GET",
        headers: { "Authorization": "Bearer " + token }
      });
      const raw = await response.text();
      let payload = {};
      try { payload = JSON.parse(raw); } catch {}
      if (!response.ok || (payload?.error?.code && payload.error.code !== "ok")) {
        const errorCode = payload?.error?.code || "http_error";
        return res.status(response.status >= 400 ? response.status : 502).json({
          ok:false,
          error:"TikTok profile lookup failed",
          code:errorCode,
          detail:String(payload?.error?.message || raw || response.statusText).slice(0, 300)
        });
      }
      const data = payload?.data?.user || {};
      return res.json({
        ok:true,
        profile: {
          displayName: data.display_name || null,
          avatarUrl: data.avatar_url || null
        },
        scopeUsed:"user.info.basic"
      });
    } catch (error) {
      console.error("TIKTOK_PROFILE_LOOKUP_FAILED", String(error?.message || error));
      return res.status(502).json({ ok:false, error:"TikTok profile lookup failed. Check the live server logs." });
    }
  });

  app.get("/auth/tiktok", async (req, res) => {
    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
    if (!clientKey || !clientSecret) {
      return res.status(503).type("text/plain").send("TikTok client key or secret is missing from Habitat runtime configuration.");
    }
    if (!vaultReady) {
      return res.status(503).type("text/plain").send("Habitat durable encrypted token storage is unavailable. TikTok connection was not started.");
    }

    const state = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + STATE_TTL_MS;
    try {
      await secretVault.set("tiktok_oauth_state:" + state, { state, expiresAt });
      writeStateCookie(res, state);
      return res.redirect(302, buildTikTokAuthorizationUrl({ clientKey, state }));
    } catch (error) {
      console.error("TIKTOK_OAUTH_STATE_SAVE_FAILED", String(error?.message || error));
      return res.status(503).type("text/plain").send("Habitat could not securely save the authorization state. Please retry after storage recovers.");
    }
  });

  app.get("/auth/tiktok/callback", async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query || {};
    clearStateCookie(res);
    if (error) {
      return res.status(400).type("text/plain").send("TikTok authorization failed: " + String(errorDescription || error).slice(0, 300));
    }
    if (!vaultReady) {
      return res.status(503).type("text/plain").send("Habitat durable encrypted token storage is unavailable; authorization cannot be completed safely.");
    }
    const expectedState = readCookie(req, "habitat_tiktok_state");
    if (!code || !state || String(state) !== expectedState) {
      return res.status(400).type("text/plain").send("TikTok authorization state check failed. Please restart Connect TikTok from Habitat.");
    }

    const stateKey = "tiktok_oauth_state:" + String(state);
    let savedState;
    try {
      savedState = await secretVault.get(stateKey);
      await secretVault.delete(stateKey);
    } catch (storageError) {
      console.error("TIKTOK_OAUTH_STATE_READ_FAILED", String(storageError?.message || storageError));
      return res.status(503).type("text/plain").send("Habitat could not verify the authorization state in durable storage.");
    }
    if (!savedState || savedState.state !== String(state) || !Number.isFinite(Number(savedState.expiresAt)) || Date.now() > Number(savedState.expiresAt)) {
      return res.status(400).type("text/plain").send("TikTok authorization state expired or was already used. Please restart Connect TikTok.");
    }

    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
    if (!clientKey || !clientSecret) {
      return res.status(503).type("text/plain").send("TikTok client key or secret is missing from Habitat runtime configuration.");
    }

    try {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code: String(code),
          grant_type: "authorization_code",
          redirect_uri: TIKTOK_REDIRECT_URI
        }),
        signal: AbortSignal.timeout(20000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error || !payload?.access_token) {
        console.error("TIKTOK_TOKEN_EXCHANGE_FAILED", JSON.stringify({
          httpStatus: response.status,
          error: payload?.error || null,
          description: payload?.error_description || payload?.message || null,
          logId: payload?.log_id || null
        }));
        return res.status(502).type("text/plain").send("TikTok authorization returned, but token exchange failed. Check Habitat Render logs for TIKTOK_TOKEN_EXCHANGE_FAILED.");
      }

      const now = Date.now();
      const bundle = {
        access_token: String(payload.access_token),
        refresh_token: payload.refresh_token ? String(payload.refresh_token) : null,
        access_token_expires_at: payload.expires_in ? String(now + Number(payload.expires_in) * 1000) : null,
        refresh_token_expires_at: payload.refresh_expires_in ? String(now + Number(payload.refresh_expires_in) * 1000) : null,
        open_id: payload.open_id ? String(payload.open_id) : null,
        scope: payload.scope ? String(payload.scope) : TIKTOK_SCOPES.join(","),
        token_type: payload.token_type ? String(payload.token_type) : null,
        connected_at: new Date(now).toISOString()
      };
      await secretVault.set("tiktok_tokens", bundle);
      process.env.TIKTOK_ACCESS_TOKEN = bundle.access_token;
      if (bundle.refresh_token) process.env.TIKTOK_REFRESH_TOKEN = bundle.refresh_token;
      if (bundle.access_token_expires_at) process.env.TIKTOK_ACCESS_TOKEN_EXPIRES_AT = bundle.access_token_expires_at;
      if (bundle.refresh_token_expires_at) process.env.TIKTOK_REFRESH_TOKEN_EXPIRES_AT = bundle.refresh_token_expires_at;
      console.log("TIKTOK_OAUTH_CONNECTED", JSON.stringify({
        openIdPresent: Boolean(bundle.open_id),
        scopes: String(bundle.scope).split(/[ ,]+/).filter(Boolean),
        accessTokenExpiresAt: bundle.access_token_expires_at,
        refreshTokenPresent: Boolean(bundle.refresh_token)
      }));
      return res.type("text/html").send("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Habitat connected</title></head><body style=\"font-family:system-ui;max-width:640px;margin:48px auto;padding:20px\"><h1>Habitat authorization completed</h1><p>TikTok returned an access token and Habitat stored it encrypted. Run creator-info preflight before attempting to publish.</p><p><a href=\"/auth/tiktok/status\">Check connection status</a></p></body></html>");
    } catch (err) {
      console.error("TIKTOK_TOKEN_EXCHANGE_ERROR", String(err?.message || err));
      return res.status(502).type("text/plain").send("Habitat could not complete TikTok token exchange. Check Render logs and try again.");
    }
  });
}
