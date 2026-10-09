const API_BASE = "https://open.tiktokapis.com";
let tokenVault = null;
let refreshInFlight = null;

function tokenFromEnv() {
  return String(process.env.TIKTOK_ACCESS_TOKEN || "").trim();
}

async function ensureAccessToken() {
  const token = tokenFromEnv();
  const expiresAt = Number(process.env.TIKTOK_ACCESS_TOKEN_EXPIRES_AT || 0);
  if (token && (!expiresAt || Date.now() < expiresAt - 60_000)) return token;
  const refreshToken = String(process.env.TIKTOK_REFRESH_TOKEN || "").trim();
  if (!refreshToken) {
    if (token && expiresAt && Date.now() >= expiresAt) throw new Error("TikTok access token expired and no refresh token is available; reconnect TikTok.");
    if (token) return token;
    throw new Error("TIKTOK_ACCESS_TOKEN is not configured");
  }
  const refreshExpiresAt = Number(process.env.TIKTOK_REFRESH_TOKEN_EXPIRES_AT || 0);
  if (refreshExpiresAt && Date.now() >= refreshExpiresAt) throw new Error("TikTok refresh token expired; reconnect TikTok.");
  if (!tokenVault) throw new Error("Encrypted TikTok token vault is unavailable; refusing to refresh credentials without durable storage.");
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
    if (!clientKey || !clientSecret) throw new Error("TikTok client credentials are not configured for token refresh.");
    const response = await fetch(API_BASE + "/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok || !payload?.access_token) {
      throw new Error("TikTok access-token refresh failed with HTTP " + response.status + "; reconnect TikTok if the refresh token was revoked.");
    }
    const now = Date.now();
    const bundle = {
      access_token: String(payload.access_token),
      refresh_token: payload.refresh_token ? String(payload.refresh_token) : refreshToken,
      access_token_expires_at: payload.expires_in ? String(now + Number(payload.expires_in) * 1000) : null,
      refresh_token_expires_at: payload.refresh_expires_in ? String(now + Number(payload.refresh_expires_in) * 1000) : String(refreshExpiresAt || ""),
      open_id: payload.open_id ? String(payload.open_id) : null,
      scope: payload.scope ? String(payload.scope) : null,
      token_type: payload.token_type ? String(payload.token_type) : null
    };
    await tokenVault.set("tiktok_tokens", bundle);
    process.env.TIKTOK_ACCESS_TOKEN = bundle.access_token;
    process.env.TIKTOK_REFRESH_TOKEN = bundle.refresh_token;
    if (bundle.access_token_expires_at) process.env.TIKTOK_ACCESS_TOKEN_EXPIRES_AT = bundle.access_token_expires_at;
    if (bundle.refresh_token_expires_at) process.env.TIKTOK_REFRESH_TOKEN_EXPIRES_AT = bundle.refresh_token_expires_at;
    return bundle.access_token;
  })();

  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

export function buildTikTokPublisherStatus({ tokenPresent = false, mode = "direct", creatorPreflightPassed = false } = {}) {
  const readiness = creatorPreflightPassed
    ? "preflight_passed"
    : tokenPresent
      ? "token_present_unverified"
      : "blocked";
  return {
    configured: Boolean(tokenPresent),
    mode: String(mode || "direct").trim().toLowerCase(),
    readiness,
    directPostReady: creatorPreflightPassed === true,
    scopeRequired: "video.publish",
    note: creatorPreflightPassed
      ? "Creator preflight passed, but each post still requires explicit user approval and a confirming platform response."
      : tokenPresent
        ? "An access token is present, but live creator permissions have not been verified. Run the creator-info preflight and require explicit user approval before posting."
        : "TikTok access token is not configured. Authorize Habitat and then run the creator-info preflight."
  };
}

export function tiktokConfig() {
  return {
    configured: Boolean(tokenFromEnv()),
    mode: String(process.env.TIKTOK_PUBLISH_MODE || "direct").trim().toLowerCase(),
    hasClientId: Boolean(String(process.env.TIKTOK_CLIENT_KEY || "").trim()),
    scopeHint: "video.publish"
  };
}

async function tiktokJson(path, body) {
  const token = await ensureAccessToken();
  const response = await fetch(API_BASE + path, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok || payload?.error?.code && payload.error.code !== "ok") {
    const code = payload?.error?.code || "http_error";
    const message = payload?.error?.message || text || response.statusText;
    const error = new Error("TikTok " + code + ": " + message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function queryCreatorInfo() {
  return tiktokJson("/v2/post/publish/creator_info/query/", {});
}

export async function fetchTikTokPublishStatus(publishId) {
  return tiktokJson("/v2/post/publish/status/fetch/", { publish_id: String(publishId) });
}

function captionFromScript(script = {}) {
  const hashtags = Array.isArray(script.hashtags) ? script.hashtags.join(" ") : "";
  return [String(script.caption || script.title || "").trim(), hashtags].filter(Boolean).join(" ").slice(0, 2200);
}

export async function publishTikTokDirect({ artifactPath, bytes, durationSeconds, script = {}, privacyLevel, userConsent, allowComment, allowDuet, allowStitch }) {
  if (userConsent !== true) { const error = new Error("explicit user consent is required before sending media to TikTok"); error.status = 409; throw error; }
  if (!privacyLevel) { const error = new Error("privacyLevel must be explicitly selected by the user"); error.status = 400; throw error; }
  const creator = await queryCreatorInfo();
  const options = creator?.data?.privacy_level_options || [];
  const privacy = privacyLevel || String(process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY");
  const maxDuration = Number(creator?.data?.max_video_post_duration_sec || 0);
  if (maxDuration && Number(durationSeconds || 0) > maxDuration) { const error = new Error("video exceeds TikTok creator max duration"); error.status = 400; error.payload = { durationSeconds, maxDuration }; throw error; }
  if (creator?.data?.can_post === false) { const error = new Error("TikTok creator cannot post at this time"); error.status = 409; throw error; }
  if (!options.includes(privacy)) {
    const error = new Error("TikTok privacy level is not allowed for this creator");
    error.status = 409;
    error.payload = { privacyRequested: privacy, privacyLevelOptions: options };
    throw error;
  }

  const size = Number(bytes || 0);
  if (!size || !artifactPath) throw new Error("verified artifact path and size are required");

  const chunkSize = Math.min(64 * 1024 * 1024, Math.max(5 * 1024 * 1024, Number(process.env.TIKTOK_CHUNK_SIZE_BYTES || 10 * 1024 * 1024)));
  const totalChunkCount = Math.ceil(size / chunkSize);
  const init = await tiktokJson("/v2/post/publish/video/init/", {
    post_info: {
      title: captionFromScript(script),
      privacy_level: privacy,
      disable_duet: allowDuet === true ? false : true,
      disable_comment: allowComment === true ? false : true,
      disable_stitch: allowStitch === true ? false : true,
      is_aigc: true
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount
    }
  });

  const publishId = init?.data?.publish_id;
  const uploadUrl = init?.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error("TikTok did not return publish_id and upload_url");

  const fs = await import("node:fs/promises");
  const file = await fs.open(artifactPath, "r");
  try {
    let offset = 0;
    for (let chunk = 0; chunk < totalChunkCount; chunk++) {
      const remaining = size - offset;
      const length = Math.min(chunkSize, remaining);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error("artifact read ended before expected byte count");
      const first = offset;
      const last = offset + length - 1;
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(length),
          "Content-Range": `bytes ${first}-${last}/${size}`
        },
        body: buffer
      });
      if (!response.ok) {
        const body = await response.text();
        const error = new Error("TikTok media upload failed: HTTP " + response.status + " " + body);
        error.status = response.status;
        throw error;
      }
      offset += length;
    }
  } finally {
    await file.close();
  }

  return {
    publisher: "tiktok-content-posting-api",
    publishId: String(publishId),
    privacyLevel: privacy,
    uploadedBytes: size,
    totalChunkCount,
    creator: {
      username: creator?.data?.creator_username || null,
      nickname: creator?.data?.creator_nickname || null
    }
  };
}

export function registerTikTokPublisher(app, getJob, secretVault = null) {
  tokenVault = secretVault;
  app.post("/content/publisher/creator-info", async (req, res) => {
    try {
      const payload = await queryCreatorInfo();
      const data = payload?.data || {};
      return res.json({
        ok: true,
        creator: {
          username: data.creator_username || null,
          nickname: data.creator_nickname || null,
          avatarUrl: data.creator_avatar_url || null,
          privacyLevelOptions: data.privacy_level_options || [],
          commentDisabled: data.comment_disabled === true,
          duetDisabled: data.duet_disabled === true,
          stitchDisabled: data.stitch_disabled === true,
          maxVideoPostDurationSec: Number(data.max_video_post_duration_sec || 0),
          canPost: data.can_post !== false
        }
      });
    } catch (error) {
      return res.status(Number(error?.status) >= 400 ? Number(error.status) : 502).json({
        ok:false, error:"TikTok creator info query failed", detail:String(error?.message || error)
      });
    }
  });

  app.get("/content/publisher/status", (req, res) => {
    const config = tiktokConfig();
    res.json({
      ok: true,
      platform: "tiktok",
      ...buildTikTokPublisherStatus({ tokenPresent: config.configured, mode: config.mode })
    });
  });

  app.post("/content/jobs/:id/publish-status", async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    const publish = job.stages?.publish?.result || {};
    const publishId = String(req.body?.publishId || publish.publishId || "").trim();
    if (!publishId) return res.status(400).json({ ok:false, error:"publishId required" });

    try {
      const status = await fetchTikTokPublishStatus(publishId);
      const data = status?.data || {};
      job.stages.publish.result = {
        ...publish,
        publishId,
        tiktokStatus: data.status || null,
        postIds: data.publicaly_available_post_id || [],
        failReason: data.fail_reason || null,
        checkedAt: new Date().toISOString()
      };
      if (data.status === "PUBLISH_COMPLETE") {
        job.stages.publish.status = "completed";
        job.stages.publish.result.confirmed = true;
        job.stages.publish.result.platform = "tiktok";
        job.stages.publish.result.completedAt = new Date().toISOString();
        job.stages.analytics.status = "ready";
        return res.json({ ok:true, status:"PUBLISHED", job });
      }
      if (data.status === "FAILED") {
        job.stages.publish.status = "failed";
        return res.status(502).json({ ok:false, error:"TikTok rejected the publish", job });
      }
      job.stages.publish.status = "processing";
      return res.status(202).json({ ok:true, status:"PROCESSING", job });
    } catch (error) {
      return res.status(Number(error?.status) >= 400 ? Number(error.status) : 502).json({
        ok:false, error:"TikTok status check failed", detail:String(error?.message || error), job
      });
    }
  });
}
