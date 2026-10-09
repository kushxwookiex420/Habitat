import crypto from "node:crypto";

const REDIRECT_URI = "https://habitat-1-szzd.onrender.com/auth/tiktok/callback";
const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const SCOPES = ["user.info.basic", "video.upload", "video.publish"];

// Temporary in-process state/token storage for the initial integration test.
// Durable encrypted token storage must be added before multi-instance/production use.
const pendingStates = new Map();
let connectedToken = null;
let connectedAt = null;
let tokenDetails = null;

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const item of cookies) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) {
      return decodeURIComponent(item.slice(index + 1).trim());
    }
  }
  return "";
}

export function registerTikTokOAuth(app) {
  app.get("/auth/tiktok/status", (_req, res) => {
    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
    res.json({
      ok: true,
      configured: Boolean(clientKey && clientSecret),
      clientKeyPresent: Boolean(clientKey),
      clientSecretPresent: Boolean(clientSecret),
      connected: Boolean(connectedToken),
      redirectUri: REDIRECT_URI,
      scopes: SCOPES,
      tokenStorage: "temporary-in-memory",
      connectedAt
    });
  });

  app.get("/auth/tiktok", (req, res) => {
    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    if (!clientKey) {
      return res.status(503).type("text/plain").send("TikTok client key is missing from Habitat runtime configuration.");
    }
    const state = crypto.randomBytes(24).toString("hex");
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);
    for (const [key, expires] of pendingStates) {
      if (expires < Date.now()) pendingStates.delete(key);
    }
    res.setHeader("Set-Cookie", `habitat_tiktok_state=${encodeURIComponent(state)}; Max-Age=600; Path=/auth/tiktok; HttpOnly; Secure; SameSite=Lax`);
    const url = new URL(AUTH_URL);
    url.searchParams.set("client_key", clientKey);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(","));
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", state);
    return res.redirect(302, url.toString());
  });

  app.get("/auth/tiktok/callback", async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query || {};
    if (error) {
      return res.status(400).type("text/plain").send("TikTok authorization failed: " + String(errorDescription || error));
    }
    const expectedState = readCookie(req, "habitat_tiktok_state");
    if (!code || !state || state !== expectedState || !pendingStates.has(String(state))) {
      return res.status(400).type("text/plain").send("TikTok authorization state check failed. Please restart Connect TikTok from Habitat.");
    }
    pendingStates.delete(String(state));
    res.setHeader("Set-Cookie", "habitat_tiktok_state=; Max-Age=0; Path=/auth/tiktok; HttpOnly; Secure; SameSite=Lax");

    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
    if (!clientKey || !clientSecret) {
      return res.status(503).type("text/plain").send("TikTok client key or secret is missing from Habitat runtime configuration.");
    }

    try {
      const body = new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code: String(code),
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI
      });
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error || !data.access_token) {
        console.error("TIKTOK_TOKEN_EXCHANGE_FAILED", JSON.stringify({
          httpStatus: response.status,
          error: data.error || null,
          description: data.error_description || data.message || null,
          logId: data.log_id || null
        }));
        return res.status(502).type("text/plain").send("TikTok authorization returned, but token exchange failed. Check Habitat Render logs for TIKTOK_TOKEN_EXCHANGE_FAILED.");
      }
      connectedToken = String(data.access_token);
      connectedAt = new Date().toISOString();
      tokenDetails = {
        openId: data.open_id || null,
        scope: data.scope || null,
        expiresIn: data.expires_in || null,
        refreshTokenPresent: Boolean(data.refresh_token)
      };
      console.log("TIKTOK_OAUTH_CONNECTED", JSON.stringify(tokenDetails));
      return res.type("text/html").send("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Habitat connected</title></head><body style=\"font-family:system-ui;max-width:640px;margin:48px auto;padding:20px\"><h1>Habitat authorization completed</h1><p>TikTok returned an access token successfully. You can return to Habitat.</p><p><a href=\"/auth/tiktok/status\">Check connection status</a></p></body></html>");
    } catch (err) {
      console.error("TIKTOK_TOKEN_EXCHANGE_ERROR", String(err?.message || err));
      return res.status(502).type("text/plain").send("Habitat could not complete TikTok token exchange. Check Render logs and try again.");
    }
  });
}
