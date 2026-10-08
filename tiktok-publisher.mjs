const API_BASE = "https://open.tiktokapis.com";

function tokenFromEnv() {
  return String(process.env.TIKTOK_ACCESS_TOKEN || "").trim();
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
  const token = tokenFromEnv();
  if (!token) throw new Error("TIKTOK_ACCESS_TOKEN is not configured");
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

export async function publishTikTokDirect({ artifactPath, bytes, script = {}, privacyLevel }) {
  const creator = await queryCreatorInfo();
  const options = creator?.data?.privacy_level_options || [];
  const privacy = privacyLevel || String(process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY");
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
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
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

export function registerTikTokPublisher(app, getJob) {
  app.get("/content/publisher/status", (req, res) => {
    const config = tiktokConfig();
    res.json({
      ok: true,
      platform: "tiktok",
      configured: config.configured,
      mode: config.mode,
      scopeRequired: config.scopeHint,
      directPostReady: config.configured,
      note: config.configured
        ? "TikTok access token is configured; publishing still requires the job's existing Ax/user approval gate."
        : "Set TIKTOK_ACCESS_TOKEN after authorizing Habitat with TikTok Content Posting API video.publish."
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
