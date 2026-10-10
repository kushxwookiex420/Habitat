import crypto from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import sharp from "sharp";

// Keep image processing within the memory budget of the free Render instance.
sharp.cache({ memory:32, files:10, items:20 });
sharp.concurrency(1);
import { buildSceneOverlaySvg } from "./scene-overlay.mjs";

const ffprobePath = ffprobeStatic.path;
import { runVisualQA } from "./visual-qa.mjs";
import { normalizeViceCityScript } from "./vice-city-script-fallback.mjs";
import { DEJAVU_REGULAR, DEJAVU_BOLD } from "./font-paths.mjs";
import { publishTikTokDirect, registerTikTokPublisher, tiktokConfig } from "./tiktok-publisher.mjs";

function cryptoRandomState() {
  return crypto.randomBytes(24).toString("hex");
}

// Habitat Content Engine
// Ax-managed pipeline: research -> script -> edit -> approval -> publish -> analytics.
// External publishing is approval-gated; this module never claims an upload happened
// unless a connected publisher worker explicitly reports it.

export function registerContentEngine(app, deps) {
  const { nowIso, makeTaskId, taskStore, workerRegistry, brainChat, contentJobRepository, secretVault, getDispatchLeaseRepository } = deps;
  const contentJobs = new Map();
  const tiktokOAuthStates = new Map();
  registerTikTokPublisher(app, (id) => contentJobs.get(id), secretVault);

  // Persist each returned content-job state before acknowledging the API response.
  // This keeps all stage handlers behind the same awaited durability boundary.
  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const job = body?.job;
      if (!contentJobRepository || !job || typeof job.id !== "string") return originalJson(body);
      contentJobRepository.upsert(job).then(() => originalJson(body)).catch(error => {
        console.error("CONTENT_JOB_PERSIST_FAILED", String(error?.message || error));
        if (!res.headersSent) {
          res.status(503);
          originalJson({ ok:false, error:"content job state could not be persisted" });
        }
      });
      return res;
    };
    next();
  });

  // Hydrate a content job from durable storage when a request lands on a fresh
  // Render instance or after a process restart. Without this lookup, a successfully
  // persisted job can still return a false 404 because contentJobs is process-local.
  app.use(async (req, res, next) => {
    const match = String(req.path || "").match(/^\/content\/jobs\/([^/]+)(?:\/|$)/);
    if (!match) return next();
    let id;
    try { id = decodeURIComponent(match[1]); }
    catch { return res.status(400).json({ ok:false, error:"invalid content job id" }); }
    if (contentJobs.has(id)) return next();
    if (!contentJobRepository) return next();
    try {
      const persisted = await contentJobRepository.get(id);
      if (persisted && typeof persisted.id === "string") contentJobs.set(persisted.id, persisted);
      return next();
    } catch (error) {
      console.error("CONTENT_JOB_RESTORE_FAILED", String(error?.message || error));
      return res.status(503).json({ ok:false, error:"content job could not be restored from durable storage" });
    }
  });

  // TikTok Login Kit (Web) connection flow.
  // Secrets and tokens remain server-side; the browser only follows redirects.
  app.get("/auth/tiktok", async (req, res) => {
    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
    if (!clientKey || !clientSecret) {
      return res.status(503).send("<h1>Habitat TikTok connection is not configured</h1><p>Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to the Habitat-1 Render environment, then redeploy.</p>");
    }

    if (!secretVault) return res.status(503).send("<h1>Secure TikTok storage is not ready</h1><p>Habitat requires its encrypted D1 token vault before authorization.</p>");

    const state = cryptoRandomState();
    const stateRecord = { createdAt: Date.now() };
    try { await secretVault.set("tiktok_oauth_state:" + state, stateRecord); }
    catch (error) {
      console.error("TIKTOK_OAUTH_STATE_PERSIST_FAILED", String(error?.message || error));
      return res.status(503).send("<h1>TikTok connection temporarily unavailable</h1><p>Authorization state could not be saved securely.</p>");
    }
    tiktokOAuthStates.set(state, stateRecord);
    // Bound in-memory state storage so abandoned login attempts cannot accumulate.
    for (const [key, value] of tiktokOAuthStates) {
      if (Date.now() - value.createdAt > 10 * 60 * 1000) tiktokOAuthStates.delete(key);
    }

    const redirectUri = String(
      process.env.TIKTOK_REDIRECT_URI ||
      "https://habitat-1-szzd.onrender.com/auth/tiktok/callback"
    ).trim();

    const params = new URLSearchParams({
      client_key: clientKey,
      response_type: "code",
      scope: "user.info.basic,video.upload,video.publish",
      redirect_uri: redirectUri,
      state,
      disable_auto_auth: "0"
    });

    return res.redirect("https://www.tiktok.com/v2/auth/authorize/?" + params.toString());
  });

  app.get("/auth/tiktok/callback", async (req, res) => {
    const state = String(req.query?.state || "");
    let stateRecord = null;
    if (secretVault && state) {
      try {
        stateRecord = await secretVault.get("tiktok_oauth_state:" + state);
        await secretVault.delete("tiktok_oauth_state:" + state);
      } catch (error) {
        console.error("TIKTOK_OAUTH_STATE_READ_FAILED", String(error?.message || error));
        return res.status(503).send("<h1>TikTok connection temporarily unavailable</h1><p>Authorization state could not be verified securely.</p>");
      }
    }
    tiktokOAuthStates.delete(state);

    if (!secretVault || !stateRecord || Date.now() - stateRecord.createdAt > 10 * 60 * 1000) {
      return res.status(400).send("<h1>TikTok connection failed</h1><p>Invalid or expired authorization state. Please start Connect TikTok again from Habitat.</p>");
    }

    if (req.query?.error) {
      const message = String(req.query.error_description || req.query.error);
      return res.status(400).send("<h1>TikTok connection cancelled</h1><p>" + message.replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])) + "</p>");
    }

    const code = String(req.query?.code || "").trim();
    if (!code) return res.status(400).send("<h1>TikTok connection failed</h1><p>No authorization code was returned by TikTok.</p>");

    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
    const redirectUri = String(
      process.env.TIKTOK_REDIRECT_URI ||
      "https://habitat-1-szzd.onrender.com/auth/tiktok/callback"
    ).trim();

    try {
      const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri
        })
      });

      const tokenText = await tokenResponse.text();
      let tokenPayload = {};
      try { tokenPayload = JSON.parse(tokenText); } catch {}

      if (!tokenResponse.ok || !tokenPayload?.access_token) {
        console.error("TIKTOK_OAUTH_TOKEN_EXCHANGE_FAILED", tokenResponse.status, tokenText.slice(0, 500));
        return res.status(502).send("<h1>TikTok connection failed</h1><p>TikTok did not return an access token. Check the registered redirect URI and approved scopes in the TikTok Developer Portal.</p>");
      }

      const now = Date.now();
      const tokenBundle = {
        access_token: String(tokenPayload.access_token),
        refresh_token: tokenPayload.refresh_token ? String(tokenPayload.refresh_token) : null,
        access_token_expires_at: tokenPayload.expires_in ? String(now + Number(tokenPayload.expires_in) * 1000) : null,
        refresh_token_expires_at: tokenPayload.refresh_expires_in ? String(now + Number(tokenPayload.refresh_expires_in) * 1000) : null,
        open_id: tokenPayload.open_id ? String(tokenPayload.open_id) : null,
        scope: tokenPayload.scope ? String(tokenPayload.scope) : null,
        token_type: tokenPayload.token_type ? String(tokenPayload.token_type) : null
      };
      if (!secretVault) return res.status(503).send("<h1>TikTok token not saved</h1><p>Secure encrypted storage is not ready.</p>");
      try { await secretVault.set("tiktok_tokens", tokenBundle); }
      catch (error) {
        console.error("TIKTOK_TOKEN_PERSIST_FAILED", String(error?.message || error));
        return res.status(503).send("<h1>TikTok token not saved</h1><p>Authorization succeeded, but credentials could not be persisted securely. Please retry.</p>");
      }
      process.env.TIKTOK_ACCESS_TOKEN = tokenBundle.access_token;
      if (tokenBundle.refresh_token) process.env.TIKTOK_REFRESH_TOKEN = tokenBundle.refresh_token;
      if (tokenBundle.access_token_expires_at) process.env.TIKTOK_ACCESS_TOKEN_EXPIRES_AT = tokenBundle.access_token_expires_at;
      if (tokenBundle.refresh_token_expires_at) process.env.TIKTOK_REFRESH_TOKEN_EXPIRES_AT = tokenBundle.refresh_token_expires_at;

      return res.status(200).send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Habitat — TikTok Connected</title><style>body{font-family:system-ui;background:#050914;color:#e9ffff;padding:32px;text-align:center}main{max-width:560px;margin:12vh auto;padding:28px;border:1px solid #164f5a;border-radius:20px;background:#08121c}a{display:inline-block;margin-top:20px;padding:13px 20px;border-radius:12px;background:#17d6c3;color:#041011;text-decoration:none;font-weight:700}</style></head><body><main><h1>✓ TikTok Connected</h1><p>Habitat is authorized to work with your TikTok account.</p><p>You can return to Habitat and continue the content workflow.</p><a href="https://kushxwookiex420.github.io/Habitat/">Return to Habitat</a></main></body></html>`);
    } catch (error) {
      console.error("TIKTOK_OAUTH_CALLBACK_ERROR", String(error?.message || error));
      return res.status(502).send("<h1>TikTok connection failed</h1><p>Habitat could not complete the secure token exchange.</p>");
    }
  });

  app.get("/auth/tiktok/status", (req, res) => {
    // Report presence only; never expose credential values or lengths.
    const clientKeyPresent = Boolean(String(process.env.TIKTOK_CLIENT_KEY || "").trim());
    const clientSecretPresent = Boolean(String(process.env.TIKTOK_CLIENT_SECRET || "").trim());
    const configured = clientKeyPresent && clientSecretPresent;
    const connected = Boolean(String(process.env.TIKTOK_ACCESS_TOKEN || "").trim());
    res.json({
      ok: true,
      configured,
      clientKeyPresent,
      clientSecretPresent,
      connected,
      redirectUri: String(process.env.TIKTOK_REDIRECT_URI || "https://habitat-1-szzd.onrender.com/auth/tiktok/callback"),
      scopes: ["user.info.basic", "video.upload", "video.publish"],
      tokenVaultReady: Boolean(secretVault)
    });
  });

  const contentWorkers = [
    ["content-researcher", {
      id: "content-researcher", name: "Ax Content Researcher", kind: "specialist",
      status: "available", capabilities: ["trend-research","product-research","competitor-research","opportunity-scoring"]
    }],
    ["content-writer", {
      id: "content-writer", name: "Ax Script Writer", kind: "specialist",
      status: "available", capabilities: ["hooks","scripts","captions","titles","hashtags"]
    }],
    ["content-editor", {
      id: "content-editor", name: "Ax Video Editor", kind: "specialist",
      status: "ready", capabilities: ["9:16","16:9","captions","voiceover","cuts","export"]
    }],
    ["content-publisher", {
      id: "content-publisher", name: "Ax Publisher", kind: "approval-gated",
      status: "approval_required", capabilities: ["tiktok","youtube","shopify-product-video","upload"]
    }],
    ["content-analytics", {
      id: "content-analytics", name: "Ax Analytics", kind: "specialist",
      status: "ready", capabilities: ["views","retention","clicks","sales","iteration"]
    }]
  ];

  for (const [id, worker] of contentWorkers) workerRegistry.set(id, {
    ...worker, lastRunAt: null
  });

  function makeJob(input) {
    const id = "content-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const job = {
      id,
      project: String(input.project || "general").trim(),
      objective: String(input.objective || "").trim(),
      platform: String(input.platform || "tiktok").trim().toLowerCase(),
      format: String(input.format || "9:16").trim(),
      status: "research",
      approvalRequired: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      stages: {
        research: { status: "queued", worker: "content-researcher", result: null },
        script: { status: "queued", worker: "content-writer", result: null },
        edit: { status: "queued", worker: "content-editor", result: null },
        publish: { status: "approval_required", worker: "content-publisher", result: null },
        analytics: { status: "queued", worker: "content-analytics", result: null }
      }
    };
    contentJobs.set(id, job);
    return job;
  }

  function update(job, stage, status, result = null) {
    job.stages[stage].status = status;
    if (result !== null) job.stages[stage].result = result;
    job.updatedAt = nowIso();
    return job;
  }

  app.get("/content/workers", (req, res) => {
    res.json({
      ok: true,
      workers: contentWorkers.map(([id]) => workerRegistry.get(id))
    });
  });

  app.get("/content/jobs", (req, res) => {
    res.json({
      ok: true,
      jobs: Array.from(contentJobs.values()).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    });
  });

  app.get("/content/jobs/:id", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    res.json({ ok:true, job });
  });

  // Creates the complete production mission without pretending that media was edited
  // or uploaded. Each stage has a real state and a worker owner.
  app.post("/content/jobs", async (req, res) => {
    const objective = String(req.body?.objective || "").trim();
    if (!objective) return res.status(400).json({ ok:false, error:"objective required" });

    const job = makeJob(req.body);
    const task = {
      id: makeTaskId(),
      title: "Content Mission: " + objective.slice(0, 80),
      description: "Ax content pipeline mission for " + job.project + ": " + objective,
      status: "planned",
      owner: "Ax",
      worker: "content-researcher",
      createdAt: nowIso(),
      delegatedAt: null,
      completedAt: null,
      verifiedAt: null,
      result: null,
      error: null,
      contentJobId: job.id
    };
    taskStore.set(task.id, task);
    job.taskId = task.id;
    res.json({ ok:true, job, task });
  });

  // Runs research + script generation using the connected brain. This is a planning/
  // intelligence stage; it does not claim live web evidence unless a research source
  // is supplied by a connected research tool.
  app.post("/content/jobs/:id/research", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });

    try {
      update(job, "research", "running");
      const prompt = [
        "You are Ax Content Researcher.",
        "Create a production-ready research brief for this objective.",
        "Do not invent live trend metrics, sales numbers, or source citations.",
        "Return JSON with: angle, audience, hookIdeas (5), keyClaims, visualIdeas (5), risks, nextBestAction.",
        "Objective: " + job.objective,
        "Project: " + job.project,
        "Platform: " + job.platform
      ].join("\n");

      const response = await brainChat({
        messages: [
          { role:"system", content:"Return valid JSON only. Never claim live web research unless explicitly provided." },
          { role:"user", content:prompt }
        ],
        model: undefined,
        max_tokens: 900
      });
      const text = response?.choices?.[0]?.message?.content || "";
      let brief;
      try { brief = JSON.parse(text); } catch { brief = { raw: text }; }

      update(job, "research", "completed", brief);
      update(job, "script", "queued");
      res.json({ ok:true, job });
    } catch (error) {
      update(job, "research", "failed", { error:String(error?.message || error) });
      res.status(502).json({ ok:false, error:"content research failed", job });
    }
  });

  app.post("/content/jobs/:id/script", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });

    try {
      update(job, "script", "running");
      const research = job.stages.research.result || {};

      // Artifact 001 uses the canonical fact-checked package already committed to Habitat.
      // Do not replace that approved package with an unconstrained model rewrite.
      if (job.project === "ViceCityFiles" && /Artifact 001|Vice City 6: The Next Big Leap/i.test(job.objective)) {
        const script = {
          title: "Vice City 6: The Next Big Leap",
          hook: "Vice City is coming back — and GTA 6 just got a lot more real.",
          voiceover: "Vice City is coming back — and GTA 6 just got a lot more real. Rockstar has GTA 6 scheduled to launch November 19, 2026, and pre-orders are already open. The game follows Jason and Lucia after a score goes wrong, pulling them into a criminal conspiracy across Leonida. And yes, Vice City is back at the center of the story — with Rockstar promising its biggest evolution of the series yet. Right now, the officially announced launch platforms are PlayStation 5 and Xbox Series X and S. So forget the rumors for a second. These are the facts Rockstar has actually confirmed — and the next leap is almost here.",
          onScreenText: ["VICE CITY 6", "THE NEXT BIG LEAP", "FACTS, NOT RUMORS"],
          shotList: ["title card", "Jason and Lucia", "Vice City / Leonida", "official launch platforms", "end card"],
          caption: "GTA 6 is getting closer. Here are the confirmed details — no rumors, no made-up features.",
          hashtags: ["#GTA6", "#GTAVI", "#ViceCity", "#RockstarGames", "#GamingNews"]
        };
        update(job, "script", "completed", script);
        update(job, "edit", "ready");
        return res.json({ ok:true, job, source:"canonical-artifact-001" });
      }

      const prompt = [
        "You are Ax Script Writer.",
        "Create one short-form production script from this research.",
        "Return JSON with: title, hook, voiceover, onScreenText, shotList, caption, hashtags.",
        "Keep claims grounded in the supplied research; do not invent facts.",
        "Objective: " + job.objective,
        "Research: " + JSON.stringify(research)
      ].join("\n");

      const response = await brainChat({
        messages: [
          { role:"system", content:"Return valid JSON only." },
          { role:"user", content:prompt }
        ],
        model: undefined,
        max_tokens: 1200
      });
      const text = response?.choices?.[0]?.message?.content || "";
      let script;
      try { script = JSON.parse(text); } catch { script = { raw: text }; }
      if (job.project === "ViceCityFiles") {
        const normalized = normalizeViceCityScript(script);
        if (normalized.fallbackReason) console.warn("CONTENT_SCRIPT_FALLBACK", job.id, normalized.fallbackReason);
        script = normalized;
      }

      update(job, "script", "completed", script);
      update(job, "edit", "ready");
      res.json({ ok:true, job });
    } catch (error) {
      update(job, "script", "failed", { error:String(error?.message || error) });
      res.status(502).json({ ok:false, error:"script generation failed", job });
    }
  });

  // Creates a deterministic render specification for the editor worker. This does NOT claim
  // that an MP4 was rendered; only a connected media worker may mark the edit completed.
  app.post("/content/jobs/:id/render-plan", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.script.status !== "completed")
      return res.status(409).json({ ok:false, error:"script must be completed first", job });
    const script = job.stages.script.result || {};
    const plan = {
      version: "1.0",
      jobId: job.id,
      format: job.format,
      platform: job.platform,
      targetRuntimeSeconds: 45,
      audio: { voiceover: true, captions: true },
      scenes: Array.isArray(script.shotList) ? script.shotList : [],
      onScreenText: script.onScreenText || [],
      output: { type: "mp4", status: "pending", path: null },
      approvalRequired: true,
      generatedAt: nowIso()
    };
    update(job, "edit", "queued", { ...job.stages.edit.result, renderPlan: plan });
    res.json({ ok:true, job, renderPlan:plan, message:"Render plan created; no MP4 is claimed until an editor worker returns a real output." });
  });

  // Media editing is explicitly worker-backed. The API creates an edit manifest;
  // the Render editor below turns that manifest into a real, verifiable MP4.
  app.post("/content/jobs/:id/edit", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.script.status !== "completed")
      return res.status(409).json({ ok:false, error:"script must be completed first", job });

    const manifest = {
      jobId: job.id,
      format: job.format,
      platform: job.platform,
      script: job.stages.script.result,
      sourceAssets: Array.isArray(req.body?.sourceAssets) ? req.body.sourceAssets : [],
      requestedEdits: Array.isArray(req.body?.requestedEdits) ? req.body.requestedEdits : [],
      output: "pending"
    };
    update(job, "edit", "queued", manifest);
    res.json({ ok:true, job, editManifest:manifest });
  });


  // Deterministic Render Worker v2: real scene-based 1080x1920 MP4.
  // v1 proved the MP4 path but intentionally used one static frame. v2 fixes the
  // observed artifact problems: scene changes now occur at the planned timestamps,
  // on-screen copy is constrained to a mobile-safe area, and every scene has its
  // own visual treatment. No copyrighted footage is fabricated or claimed.
  let renderJobHandler;
  renderJobHandler = async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.script.status !== "completed")
      return res.status(409).json({ ok:false, error:"script must be completed first", job });

    const renderPlan = job.stages.edit?.result?.renderPlan;
    if (!renderPlan) return res.status(409).json({ ok:false, error:"render plan required first", job });

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const execFileAsync = promisify(execFile);

    const safeId = job.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const outDir = path.join("/tmp", "habitat-artifacts", safeId);
    const outputPath = path.join(outDir, "vice-city-6-next-big-leap.mp4");
    const script = job.stages.script.result || {};

    const attempt = Math.max(1, Number(req.body?.attempt || 1));
    const maxAttempts = Math.min(3, Math.max(1, Number(req.body?.maxAttempts || 3)));
    const repairPlan = Array.isArray(req.body?.repairPlan) ? req.body.repairPlan : [];
    const fontScale = repairPlan.some(x => x?.action === "resize_text") ? 0.82 : 1;

    // Artifact 001 has a canonical six-scene timing package. Keep these timings
    // aligned with the fact-checked script so the visual sequence follows the VO.
    const scenes = [
      { start:0,  end:4,  bg:"0x10131a", title:"VICE CITY IS BACK", sub:"GTA 6 • THE NEXT BIG LEAP" },
      { start:4,  end:11, bg:"0x17151f", title:"NOV. 19, 2026", sub:"OFFICIAL RELEASE DATE" },
      { start:11, end:19, bg:"0x121b20", title:"JASON + LUCIA", sub:"VICE CITY • LEONIDA" },
      { start:19, end:27, bg:"0x20161a", title:"VICE CITY • LEONIDA", sub:"THE NEXT EVOLUTION" },
      { start:27, end:36, bg:"0x151d18", title:"PS5 • XBOX SERIES X|S", sub:"OFFICIALLY ANNOUNCED PLATFORMS" },
      { start:36, end:45, bg:"0x1b1622", title:"FACTS, NOT RUMORS", sub:"HABITAT • AX • VICECITYFILES" }
    ];

    const esc = (s) => String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/\x27/g, "\\x27")
      .replace(/%/g, "\\%");

    try {
      update(job, "edit", "rendering", { ...job.stages.edit.result, renderPlan, rendererVersion:"v6-official-visuals-narrated" });
      await fs.mkdir(outDir, { recursive:true });

          // Pull six real screenshots from Rockstar Games official GTA VI media page.
      // Missing assets block the render instead of silently reverting to text cards.
      const officialImageUrls = [
        "https://www.rockstargames.com/VI/_next/static/media/Jason_and_Lucia_08.0.bq0bdrl6g5y.jpg?akim=1&imdensity=1&imwidth=540",
        "https://www.rockstargames.com/VI/_next/static/media/Vice_City_10.0f1q-xa_4q8r2.jpg?akim=1&imdensity=1&imwidth=540",
        "https://www.rockstargames.com/VI/_next/static/media/Jason_Duval_02.1486~7_v40cn..jpg?akim=1&imdensity=1&imwidth=540",
        "https://www.rockstargames.com/VI/_next/static/media/Lucia_Caminos_01.0a7yqvewctkfp.jpg?akim=1&imdensity=1&imwidth=540",
        "https://www.rockstargames.com/VI/_next/static/media/Vice_City_01.135x56yoeu.6t.jpg?akim=1&imdensity=1&imwidth=540",
        "https://www.rockstargames.com/VI/_next/static/media/Ambrosia_06.0j9c7-8nfb_xf.jpg?akim=1&imdensity=1&imwidth=540"
      ];
      const imagePaths = [];
      // Download one asset at a time: parallel full-resolution buffers caused
      // memory spikes on the small instance and could kill the render worker.
      for (const [i, imageUrl] of officialImageUrls.entries()) {
        const imageResponse = await fetch(imageUrl, {
          headers: { "User-Agent": "Mozilla/5.0 HabitatAx/1.0", "Accept": "image/jpeg,*/*;q=0.1" },
          signal: AbortSignal.timeout(15000)
        });
        const imageType = String(imageResponse.headers.get("content-type") || "");
        if (!imageResponse.ok || !imageType.startsWith("image/")) throw new Error("official_visual_asset_unavailable_" + (i + 1) + "_http_" + imageResponse.status);
        const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
        if (imageBytes.length < 10000) throw new Error("official_visual_asset_too_small_" + (i + 1));
        const imageExt = imageType.includes("webp") ? ".webp" : imageType.includes("avif") ? ".avif" : imageType.includes("png") ? ".png" : ".jpg";
        const imagePath = path.join(outDir, "official-scene-" + String(i + 1).padStart(2, "0") + imageExt);
        await fs.writeFile(imagePath, imageBytes);
        imagePaths.push(imagePath);
      }

      // Produce real spoken narration before encoding. Use short Google Translate TTS
          // chunks to avoid request-length limits; if speech generation fails, block the
          // render rather than substitute silence and falsely report a finished video.
          const voiceText = String(script.voiceover || "").replace(/\s+/g, " ").trim();
          if (voiceText.length < 80) throw new Error("voiceover_missing_or_too_short");
          const voiceChunks = [];
          let voiceChunk = "";
          for (const word of voiceText.split(" ")) {
            const candidate = voiceChunk ? voiceChunk + " " + word : word;
            if (candidate.length > 175 && voiceChunk) {
              voiceChunks.push(voiceChunk);
              voiceChunk = word;
            } else voiceChunk = candidate;
          }
          if (voiceChunk) voiceChunks.push(voiceChunk);
          const voiceFiles = [];
          for (let i = 0; i < voiceChunks.length; i++) {
            const ttsUrl = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-US&q=" + encodeURIComponent(voiceChunks[i]);
            const ttsResponse = await fetch(ttsUrl, {
              headers: { "User-Agent": "Mozilla/5.0 HabitatAx/1.0", "Accept": "audio/mpeg" },
              signal: AbortSignal.timeout(15000)
            });
            if (!ttsResponse.ok) throw new Error("voiceover_tts_http_" + ttsResponse.status);
            const audioBytes = Buffer.from(await ttsResponse.arrayBuffer());
            if (audioBytes.length < 1000) throw new Error("voiceover_tts_empty_audio");
            const voiceFile = path.join(outDir, "voice-" + String(i).padStart(2, "0") + ".mp3");
            await fs.writeFile(voiceFile, audioBytes);
            voiceFiles.push(voiceFile);
          }
          const voiceList = path.join(outDir, "voiceover-concat.txt");
          await fs.writeFile(voiceList, voiceFiles.map(file => "file '" + file.replace(/'/g, "'\\''") + "'").join("\n") + "\n");
          const voicePath = path.join(outDir, "voiceover.mp3");
          await execFileAsync(ffmpegPath, [
            "-hide_banner","-loglevel","error","-y","-f","concat","-safe","0","-i",voiceList,"-c","copy",voicePath
          ], { timeout: 30000 });
      
      
      // v4: prioritize a guaranteed visible artifact. Render each scene at 540x960/15fps,
      // concatenate, then upscale once to the required 1080x1920 output.
      const sceneInputs = [
        { dur:4, bg:"0x10131a", title:"VICE CITY IS BACK", sub:"GTA 6 • THE NEXT BIG LEAP" },
        { dur:7, bg:"0x17151f", title:"NOV. 19, 2026", sub:"OFFICIAL RELEASE DATE" },
        { dur:8, bg:"0x121b20", title:"JASON + LUCIA", sub:"VICE CITY • LEONIDA" },
        { dur:8, bg:"0x20161a", title:"VICE CITY • LEONIDA", sub:"THE NEXT EVOLUTION" },
        { dur:9, bg:"0x151d18", title:"PS5 • XBOX SERIES X|S", sub:"OFFICIALLY ANNOUNCED PLATFORMS" },
        { dur:9, bg:"0x1b1622", title:"FACTS, NOT RUMORS", sub:"HABITAT • AX • VICECITYFILES" }
      ];
      const inputs = [];
      const filters = [];
      const sceneFramePaths = [];
      // Burn each text overlay into its still image before encoding. This keeps
      // FFmpeg at six video inputs instead of twelve simultaneous looping streams,
      // which avoids memory spikes on the small Render instance.
      for (const [i, scene] of sceneInputs.entries()) {
        const overlaySvg = buildSceneOverlaySvg({
          title: scene.title,
          subtitle: scene.sub,
          fontScale
        });
        const overlayPng = await sharp(Buffer.from(overlaySvg)).png().toBuffer();
        const framePath = path.join(outDir, "scene-frame-" + i + ".jpg");
        await sharp(imagePaths[i])
          .resize(540, 960, { fit:"cover", position:"centre" })
          .composite([{ input:overlayPng, blend:"over" }])
          .jpeg({ quality:88, mozjpeg:true })
          .toFile(framePath);
        sceneFramePaths.push(framePath);
      }

      sceneInputs.forEach((s, i) => {
        inputs.push("-loop","1","-framerate","10","-t",String(s.dur),"-i",sceneFramePaths[i]);
        filters.push(
          "["+i+":v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,fps=10,trim=duration="+s.dur+",setpts=PTS-STARTPTS,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.12:t=fill,drawbox=x=20+20*t:y=205:w=8:h=550:color=white@0.16:t=fill,setsar=1[v"+i+"]"
        );
      });
      filters.push(sceneInputs.map((_,i)=>"[v"+i+"]").join("")+"concat=n="+sceneInputs.length+":v=1:a=0,scale=1080:1920:flags=fast_bilinear,format=yuv420p[v]");

      await execFileAsync(ffmpegPath, [
        "-hide_banner","-loglevel","error","-y","-filter_complex_threads","1",
        ...inputs,
        "-i",voicePath,
        "-filter_complex",filters.join(";"),
        "-map","[v]","-map","6:a:0",
        "-c:v","libx264","-preset","ultrafast","-crf","32","-pix_fmt","yuv420p","-threads","1",
        "-af","apad,atrim=duration=45","-c:a","aac","-b:a","128k","-ar","48000","-t","45","-shortest",
        "-movflags","+faststart",outputPath
      ],{timeout:120000});

      const stat=await fs.stat(outputPath);
      if(!stat.size) throw new Error("ffmpeg produced an empty artifact");

      const probe=await execFileAsync(ffprobePath,[
        "-v","error",
        "-show_entries","format=duration,size:stream=index,codec_type,width,height,r_frame_rate",
        "-of","json",outputPath
      ]);
      let probeData={};
      try { probeData=JSON.parse(probe.stdout); } catch {}
      const durationSeconds=Number(probeData?.format?.duration||0);
      const videoStream=(probeData?.streams||[]).find(x=>x.codec_type==="video")||{};
      if(durationSeconds<44) throw new Error("rendered artifact duration verification failed");
      if(Number(videoStream.width)!==1080 || Number(videoStream.height)!==1920)
        throw new Error("rendered artifact dimensions verification failed");

      const artifact={
        type:"mp4",status:"rendered",path:outputPath,bytes:stat.size,
        durationSeconds,width:1080,height:1920,renderedAt:nowIso(),
        verified:false,renderer:"ffmpeg-scene-engine-v6-official-visuals-narrated",
        audio:"google-translate-tts-narration",
        scenes:scenes.map(s=>({start:s.start,end:s.end,title:s.title}))
      };

      // Hard visual gate: file existence is not visual verification.
      const visualQA = await runVisualQA({
        artifactPath: outputPath,
        renderPlan: {
          ...renderPlan,
          scenes: scenes.map(s=>({start:s.start,end:s.end,title:s.title})),
          onScreenText: [
            { text:"VICE CITY IS BACK", fontSize:Math.round(32*fontScale), bold:true },
            { text:"NOV. 19, 2026", fontSize:Math.round(32*fontScale), bold:true },
            { text:"JASON + LUCIA", fontSize:Math.round(32*fontScale), bold:true },
            { text:"VICE CITY • LEONIDA", fontSize:Math.round(32*fontScale), bold:true },
            { text:"PS5 • XBOX SERIES X|S", fontSize:Math.round(32*fontScale), bold:true },
            { text:"FACTS, NOT RUMORS", fontSize:Math.round(32*fontScale), bold:true }
          ]
        },
        expectedSceneCount: scenes.length
      });

      artifact.visualQA = visualQA;
      artifact.verified = visualQA.status === "VISUAL_PASS";
      artifact.status = artifact.verified ? "verified" : "blocked";

      update(job,"edit",artifact.verified ? "completed" : "failed",{
        ...job.stages.edit.result,
        renderPlan:{...renderPlan,output:artifact},
        artifact,
        visualQA
      });

      if (!artifact.verified) {
        console.warn("MEDIA_RENDER_QA_BLOCKED", job.id, JSON.stringify(visualQA.issues).slice(0, 1200));
        return res.status(422).json({
          ok:false,
          error:"visual QA blocked artifact",
          artifact,
          visualQA,
          job
        });
      }

      res.json({ok:true,job,artifact,visualQA});
    } catch(error) {
      console.error("MEDIA_RENDER_FAILED", job.id, "code="+String(error?.code||""), "stderr="+String(error?.stderr||"").slice(0, 1600), "message="+String(error?.message||error).slice(-500));
      update(job,"edit","failed",{
        ...job.stages.edit.result,
        error:String(error?.message||error),failedAt:nowIso()
      });
      res.status(502).json({ok:false,error:"media render failed",detail:String(error?.message||error),job});
    }
  };
  app.post("/content/jobs/:id/render", renderJobHandler);

  // Closed-loop render endpoint: failed visual QA feeds remediation back into the renderer.
  app.post("/content/jobs/:id/render-loop", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.script.status !== "completed") return res.status(409).json({ ok:false, error:"script must be completed first", job });
    const maxAttempts = 3;
    const history = [];
    let repairPlan = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Invoke the renderer in-process. A self-HTTP fetch can hit another Render
      // instance whose in-memory contentJobs Map does not contain this job.
      const renderResponse = {
        statusCode:200,
        payload:null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.payload = body; return body; }
      };
      await renderJobHandler({ params:{ id:job.id }, body:{ attempt, maxAttempts, repairPlan } }, renderResponse);
      const payload = renderResponse.payload || {};
      const qa = payload.visualQA || payload.artifact?.visualQA || null;
      history.push({ attempt, status:renderResponse.statusCode, qaStatus:qa?.status || null, issues:qa?.issues || [], remediation:qa?.remediation || [] });
      if (renderResponse.statusCode < 400 && payload.artifact?.verified === true) {
        job.renderLoop = { status:"VERIFIED", attempts:attempt, maxAttempts, history, completedAt:nowIso() };
        return res.json({ ok:true, renderLoop:job.renderLoop, job, artifact:payload.artifact, visualQA:qa });
      }
      repairPlan = qa?.remediation || [];
    }
    job.renderLoop = { status:"BLOCKED", attempts:maxAttempts, maxAttempts, history, completedAt:nowIso(), reason:"visual QA did not pass within bounded correction loop" };
    return res.status(422).json({ ok:false, error:"render correction loop exhausted", renderLoop:job.renderLoop, job });
  });

  // Ax final artifact review: workers and deterministic QA provide evidence; Ax owns the decision.
  function axReviewArtifact(job) {
    const artifact = job?.stages?.edit?.result?.artifact;
    const qa = artifact?.visualQA;
    const issues = [];
    if (!artifact) issues.push("artifact missing");
    if (!qa || qa.status !== "VISUAL_PASS") issues.push("visual QA did not pass");
    if (artifact && artifact.status !== "verified") issues.push("artifact is not verified");
    if (artifact && artifact.verified !== true) issues.push("artifact verified flag is false");
    if (artifact && (Number(artifact.width) !== 1080 || Number(artifact.height) !== 1920)) issues.push("unexpected output dimensions");
    if (artifact && Number(artifact.durationSeconds) < 44) issues.push("artifact duration below production minimum");
    if (qa?.issues?.length) issues.push("visual QA reported issues");
    const status = issues.length ? "BLOCKED" : "AX_APPROVED";
    return {
      status, owner:"Ax", decisionAt:nowIso(), issues,
      evidence:{ visualQA:qa?.status||null, artifactStatus:artifact?.status||null, verified:artifact?.verified===true, dimensions:artifact?[artifact.width,artifact.height]:null, durationSeconds:artifact?.durationSeconds||null },
      rule:"Ax approves only a machine-verified artifact with zero visual-QA issues."
    };
  }

  app.post("/content/jobs/:id/ax-review", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    const review = axReviewArtifact(job);
    job.axReview = review;
    job.updatedAt = nowIso();
    res.status(review.status === "AX_APPROVED" ? 200 : 422).json({ ok:review.status === "AX_APPROVED", review, job });
  });

  app.get("/content/jobs/:id/artifact", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    const artifact = job.stages.edit?.result?.artifact;
    if (!artifact?.verified || artifact?.status !== "verified" || !artifact?.path)
      return res.status(404).json({ ok:false, error:"verified visual-QA-passed MP4 artifact not available", job });
    res.type("video/mp4");
    res.download(artifact.path, "habitat-artifact-001.mp4");
  });


  function qualityGate(job) {
    const script = job?.stages?.script?.result || {};
    const research = job?.stages?.research?.result || {};
    const text = JSON.stringify(script);
    const issues = [];

    if (!script || typeof script !== "object") issues.push("script result missing");
    for (const field of ["title","hook","voiceover","onScreenText","shotList","caption","hashtags"]) {
      if (script[field] == null || (typeof script[field] === "string" && !script[field].trim())) {
        issues.push("missing required field: " + field);
      }
    }

    const voice = String(script.voiceover || "");
    if (voice.length < 80) issues.push("voiceover is too short for a production package");
    if (/\\b(sprawing|sprawlingg|Al-driven|E0 drop|latest updates\\.)\\b/i.test(text)) {
      issues.push("generation/formatting corruption detected");
    }
    if (/\\b0:29|0:30|0:31|0:32|0:33|0:34|0:35\\b/.test(text) && !/0:36/.test(text)) {
      issues.push("timing sequence appears incomplete");
    }

    const unsupportedClaimPatterns = [
      /cross-platform launch/i,
      /cloud-based streaming/i,
      /dynamic weather system/i,
      /AI-driven city/i,
      /NPCs have their own agendas/i
    ];
    const claimText = text;
    for (const pattern of unsupportedClaimPatterns) {
      if (pattern.test(claimText) && !/speculat|unconfirmed|rumou?r|not officially confirmed|no official statement/i.test(claimText)) {
        issues.push("unsupported claim requires source or explicit speculation label: " + pattern.source);
      }
    }

    const hashtags = Array.isArray(script.hashtags) ? script.hashtags : [];
    if (hashtags.length !== 5) issues.push("exactly 5 hashtags required");

    const status = issues.length ? "BLOCKED" : "READY_TO_PUBLISH";
    return {
      status,
      verifiedAt: nowIso(),
      issues,
      checks: {
        requiredFields: !issues.some(i => i.startsWith("missing required field")),
        corruption: !issues.some(i => i.includes("corruption")),
        timing: !issues.some(i => i.includes("timing")),
        claims: !issues.some(i => i.includes("unsupported claim")),
        hashtags: hashtags.length === 5,
        researchPresent: Boolean(research && Object.keys(research).length)
      }
    };
  }

  // Publishing always stops at approval. A connected publisher may later consume
  // the approved manifest and report the actual upload ID.
  app.post("/content/jobs/:id/quality-gate", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    const gate = qualityGate(job);
    job.qualityGate = gate;
    job.updatedAt = nowIso();
    res.status(gate.status === "READY_TO_PUBLISH" ? 200 : 422).json({ ok: gate.status === "READY_TO_PUBLISH", gate, job });
  });

  app.post("/content/jobs/:id/approve-publish", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.edit.status !== "completed")
      return res.status(409).json({ ok:false, error:"edited artifact must be completed first", job });

    const gate = job.qualityGate || qualityGate(job);
    job.qualityGate = gate;
    const axReview = job.axReview || axReviewArtifact(job);
    job.axReview = axReview;
    if (axReview.status !== "AX_APPROVED") {
      job.stages.publish.status = "blocked";
      job.stages.publish.result = { blockedAt: nowIso(), reason: "Ax final review failed", axReview };
      return res.status(409).json({ ok:false, error:"publishing blocked by Ax final review", axReview, gate, job });
    }
    if (gate.status !== "READY_TO_PUBLISH") {
      job.stages.publish.status = "blocked";
      job.stages.publish.result = { blockedAt: nowIso(), reason: "quality gate failed", gate };
      return res.status(409).json({ ok:false, error:"publishing blocked by quality gate", gate, job });
    }

    job.stages.publish.status = "approved";
    job.stages.publish.result = {
      approvedAt: nowIso(),
      approvedBy: "user",
      platform: job.platform
    };
    job.updatedAt = nowIso();
    res.json({ ok:true, job });
  });

  // Publisher bridge: after Ax/user approval, Habitat can hand the verified artifact
  // to a connected external publisher. No upload is claimed unless the bridge confirms it.
  app.post("/content/jobs/:id/publish", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.publish.status !== "approved")
      return res.status(409).json({ ok:false, error:"publish approval required", job });
    const artifact = job.stages.edit?.result?.artifact;
    if (!artifact?.verified || artifact.status !== "verified")
      return res.status(409).json({ ok:false, error:"verified artifact required", job });
    // Native TikTok Content Posting API path. It remains behind the existing Ax/user approval gate.
    // No upload is claimed unless TikTok returns a real publish_id.
    if (job.platform === "tiktok" && tiktokConfig().configured) {
      try {
        const result = await publishTikTokDirect({
          artifactPath: artifact.path,
          bytes: artifact.bytes,
          durationSeconds: artifact.durationSeconds,
          script: job.stages.script.result,
          privacyLevel: req.body?.privacyLevel,
          userConsent: req.body?.userConsent === true,
          allowComment: req.body?.allowComment === true,
          allowDuet: req.body?.allowDuet === true,
          allowStitch: req.body?.allowStitch === true
        });
        job.stages.publish.status = "processing";
        job.stages.publish.result = {
          ...(job.stages.publish.result || {}),
          ...result,
          status: "processing",
          confirmed: false,
          startedAt: nowIso()
        };
        job.updatedAt = nowIso();
        return res.status(202).json({ ok:true, status:"TIKTOK_PROCESSING", job, publishId:result.publishId, next:"POST /content/jobs/:id/publish-status" });
      } catch (error) {
        job.stages.publish.result = {
          ...(job.stages.publish.result || {}),
          status:"tiktok_publish_failed",
          error:String(error?.message || error),
          response:error?.payload || null,
          failedAt:nowIso()
        };
        return res.status(Number(error?.status) >= 400 ? Number(error.status) : 502).json({ ok:false, error:"TikTok publisher failed", job });
      }
    }

    const bridgeUrl = String(process.env.HABITAT_PUBLISHER_WEBHOOK_URL || "").trim();
    if (!bridgeUrl) {
      job.stages.publish.result = {
        ...(job.stages.publish.result || {}),
        status:"awaiting_publisher_connection",
        blockedAt:nowIso(),
        reason:"HABITAT_PUBLISHER_WEBHOOK_URL is not configured"
      };
      return res.status(503).json({ ok:false, error:"publisher connection required", requiredEnv:"HABITAT_PUBLISHER_WEBHOOK_URL", job });
    }
    try {
      const response = await fetch(bridgeUrl, {
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          jobId:job.id, project:job.project, platform:job.platform, objective:job.objective,
          artifact:{ path:artifact.path, bytes:artifact.bytes, durationSeconds:artifact.durationSeconds, width:artifact.width, height:artifact.height },
          script:job.stages.script.result,
          axReview:job.axReview, qualityGate:job.qualityGate
        })
      });
      const text = await response.text();
      let payload={}; try { payload=JSON.parse(text); } catch {}
      if (!response.ok || !payload.uploadId) {
        job.stages.publish.result = { ...(job.stages.publish.result || {}), status:"publisher_failed", responseStatus:response.status, response:payload || text, failedAt:nowIso() };
        return res.status(502).json({ ok:false, error:"publisher bridge did not confirm upload", job, response:payload || text });
      }
      job.stages.publish.status="completed";
      job.stages.publish.result={ uploadId:String(payload.uploadId), platform:job.platform, completedAt:nowIso(), confirmed:true, publisher:payload.publisher||"external-bridge" };
      job.stages.analytics.status="ready";
      job.updatedAt=nowIso();
      res.json({ ok:true, job });
    } catch (error) {
      job.stages.publish.result={ ...(job.stages.publish.result || {}), status:"publisher_unreachable", error:String(error?.message||error), failedAt:nowIso() };
      res.status(502).json({ ok:false, error:"publisher bridge unreachable", job });
    }
  });

  app.post("/content/jobs/:id/publish-result", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.publish.status !== "approved")
      return res.status(409).json({ ok:false, error:"publish approval required", job });

    const uploadId = String(req.body?.uploadId || "").trim();
    if (!uploadId) return res.status(400).json({ ok:false, error:"uploadId required from publisher worker" });

    job.stages.publish.status = "completed";
    job.stages.publish.result = {
      uploadId,
      platform: job.platform,
      completedAt: nowIso(),
      confirmed: true
    };
    job.stages.analytics.status = "ready";
    job.updatedAt = nowIso();
    res.json({ ok:true, job });
  });

  // Analytics closes the loop once the platform reports real metrics.
  app.post("/content/jobs/:id/analytics", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    const metrics = req.body?.metrics;
    if (!metrics || typeof metrics !== "object")
      return res.status(400).json({ ok:false, error:"metrics object required" });

    update(job, "analytics", "completed", {
      metrics,
      analyzedAt: nowIso(),
      nextAction: "Use measured performance to generate the next content mission."
    });
    res.json({ ok:true, job });
  });

  // Scheduler hook: bounded autonomous missions on a cadence. The scheduler is
  // deliberately observable: boot, dispatch, stage progress, completion, and
  // failure are all logged. It uses the public Render URL so the same deployed
  // instance handles the mission rather than relying on loopback routing.
  // A rolling deploy must not immediately launch another expensive, long-running render.
  // Clamp configured cadence to at least one hour and wait for the first full interval after boot.
  // The in-process guard below prevents overlap within this instance; publication remains approval-gated.
  const configuredAutonomousIntervalMinutes = Math.max(0, Number(process.env.HABITAT_AUTONOMOUS_INTERVAL_MINUTES || 0));
  const autonomousIntervalMinutes = configuredAutonomousIntervalMinutes > 0
    ? Math.max(60, configuredAutonomousIntervalMinutes)
    : 0;
  const inProcessSchedulerEnabled = String(process.env.HABITAT_AUTONOMOUS_IN_PROCESS_SCHEDULER || "").toLowerCase() === "true";
  if (autonomousIntervalMinutes > 0 && inProcessSchedulerEnabled) {
    const objective = String(process.env.HABITAT_AUTONOMOUS_OBJECTIVE || "Create the next best ViceCityFiles short-form content mission.").trim();
    const project = String(process.env.HABITAT_AUTONOMOUS_PROJECT || "ViceCityFiles").trim();
    const platform = String(process.env.HABITAT_AUTONOMOUS_PLATFORM || "tiktok").trim().toLowerCase();
    const publicBase = String(process.env.HABITAT_PUBLIC_URL || "https://habitat-1-szzd.onrender.com").replace(/\/$/, "");
    let autonomousMissionRunning = false;
    console.log("AX_AUTONOMOUS_BOOT", JSON.stringify({
      enabled:true, intervalMinutes:autonomousIntervalMinutes, project, platform, publicBase, bootAt:nowIso()
    }));
    const runAutonomous = async () => {
      if (autonomousMissionRunning) {
        console.log("AX_AUTONOMOUS_TICK_SKIPPED", JSON.stringify({reason:"mission already running",at:nowIso()}));
        return;
      }
      const leaseRepository = typeof getDispatchLeaseRepository === "function" ? getDispatchLeaseRepository() : null;
      if (!leaseRepository || typeof leaseRepository.acquire !== "function") {
        console.error("AX_AUTONOMOUS_TICK_SKIPPED", JSON.stringify({reason:"durable dispatch lease unavailable; refusing uncoordinated dispatch",project,platform,at:nowIso()}));
        return;
      }
      const intervalMs = autonomousIntervalMinutes * 60 * 1000;
      const windowStart = new Date(Math.floor(Date.now() / intervalMs) * intervalMs).toISOString();
      const scopeKey = "autonomous:" + project + ":" + platform + ":lease-v3:" + windowStart;
      const leaseToken = crypto.randomUUID();
      let lease;
      try {
        lease = await leaseRepository.acquire({
          scopeKey,
          leaseToken,
          nowIso: nowIso(),
          expiresAt: new Date(new Date(windowStart).getTime() + intervalMs + 10 * 60 * 1000).toISOString()
        });
      } catch {
        console.error("AX_AUTONOMOUS_TICK_SKIPPED", JSON.stringify({reason:"durable dispatch lease claim failed; refusing uncoordinated dispatch",project,platform,windowStart,at:nowIso()}));
        return;
      }
      if (!lease.acquired) {
        console.log("AX_AUTONOMOUS_TICK_SKIPPED", JSON.stringify({reason:"scheduled window already claimed by another instance",project,platform,windowStart,at:nowIso()}));
        return;
      }
      autonomousMissionRunning = true;
      const startedAt = nowIso();
      console.log("AX_AUTONOMOUS_DISPATCH", JSON.stringify({project, platform, objective, startedAt, windowStart, leaseProtected:true}));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      try {
        const schedulerToken = String(process.env.HABITAT_AUTONOMOUS_SCHEDULER_TOKEN || "").trim();
        if (!schedulerToken) throw new Error("HABITAT_AUTONOMOUS_SCHEDULER_TOKEN is not configured; scheduled run refused");
        const response = await fetch(publicBase + "/content/autonomous-run", {
          method:"POST",
          headers:{"content-type":"application/json","x-habitat-scheduler-token":schedulerToken,"x-habitat-scheduler-lease":"already-claimed"},
          body:JSON.stringify({ project, objective, platform, format:"9:16" }),
          signal:controller.signal
        });
        let payload = {};
        try { payload = await response.json(); } catch {}
        console.log("AX_AUTONOMOUS_TICK", JSON.stringify({
          jobId:payload?.job?.id || null,
          status:response.status,
          ok:response.ok,
          missionStatus:payload?.autonomousRun?.status || null,
          stages:payload?.autonomousRun?.stages || [],
          startedAt,
          completedAt:nowIso(),
          leaseProtected:true,
          windowStart
        }));
      } catch (error) {
        console.error("AX_AUTONOMOUS_TICK_FAILED", JSON.stringify({
          message:String(error?.message || error), startedAt, failedAt:nowIso(), windowStart
        }));
      } finally {
        clearTimeout(timeout);
        autonomousMissionRunning = false;
        // Keep the scheduled-window claim until the window expires. Releasing
        // it immediately would let a second instance dispatch the same window
        // again after the first request completed.
      }
    };
    const interval = setInterval(runAutonomous, autonomousIntervalMinutes * 60 * 1000);
    interval.unref?.();
    console.log("AX_AUTONOMOUS_SCHEDULER_POLICY", JSON.stringify({
      firstRun:"after full interval (no boot-time dispatch)",
      minimumIntervalMinutes:60,
      configuredIntervalMinutes:configuredAutonomousIntervalMinutes,
      effectiveIntervalMinutes:autonomousIntervalMinutes
    }));
  }

  if (autonomousIntervalMinutes > 0 && !inProcessSchedulerEnabled) {
    console.log("AX_AUTONOMOUS_SCHEDULER_DISABLED", JSON.stringify({
      reason:"in-process scheduling is opt-in; use the external GitHub Actions scheduler to survive free-instance sleep",
      configuredIntervalMinutes:configuredAutonomousIntervalMinutes
    }));
  }

  // Ax autonomous mission runner: executes every safe stage in order and stops only at the external publish approval boundary.
  app.post("/content/autonomous-run", async (req, res) => {
    // Scheduled missions are triggered by GitHub Actions or the local scheduler.
    // Require a shared secret so an anonymous caller cannot consume model/render resources.
    const expectedToken = String(process.env.HABITAT_AUTONOMOUS_SCHEDULER_TOKEN || "").trim();
    const suppliedToken = String(req.get("x-habitat-scheduler-token") || "").trim();
    if (!expectedToken) return res.status(503).json({ ok:false, error:"autonomous scheduler secret is not configured" });
    const expectedBytes = Buffer.from(expectedToken);
    const suppliedBytes = Buffer.from(suppliedToken);
    if (expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) {
      return res.status(401).json({ ok:false, error:"unauthorized autonomous scheduler request" });
    }
    // JSON remains the primary contract. Accept query fallbacks for external
    // schedulers in case an intermediary delivers the request without its body.
    const objective = String(req.body?.objective || req.query?.objective || req.get("x-habitat-objective") || "").trim();
    if (!objective) return res.status(400).json({ ok:false, error:"objective required", bodyParsed: Boolean(req.body && Object.keys(req.body).length), contentType: String(req.get("content-type") || "") });
    const project = String(req.body?.project || req.query?.project || "ViceCityFiles").trim();
    const platform = String(req.body?.platform || req.query?.platform || "tiktok").trim().toLowerCase();
    const format = String(req.body?.format || req.query?.format || "9:16").trim();
    const leaseAlreadyHeld = String(req.get("x-habitat-scheduler-lease") || "") === "already-claimed" || req.body?.schedulerLeaseAlreadyHeld === true || String(req.query?.schedulerLeaseAlreadyHeld || "") === "true";
    let scheduledLease = null;
    let leaseRepository = null;
    if (!leaseAlreadyHeld) {
      leaseRepository = typeof getDispatchLeaseRepository === "function" ? getDispatchLeaseRepository() : null;
      if (!leaseRepository || typeof leaseRepository.acquire !== "function") {
        return res.status(503).json({ ok:false, error:"durable scheduler lease unavailable; mission refused" });
      }
      const intervalMinutes = Math.max(60, Number(process.env.HABITAT_AUTONOMOUS_INTERVAL_MINUTES || 60));
      const intervalMs = intervalMinutes * 60 * 1000;
      const windowStart = new Date(Math.floor(Date.now() / intervalMs) * intervalMs).toISOString();
      const scopeKey = "autonomous:" + project + ":" + platform + ":lease-v3:" + windowStart;
      const leaseToken = crypto.randomUUID();
      try {
        scheduledLease = await leaseRepository.acquire({
          scopeKey,
          leaseToken,
          nowIso: nowIso(),
          expiresAt: new Date(new Date(windowStart).getTime() + intervalMs + 10 * 60 * 1000).toISOString()
        });
      } catch {
        return res.status(503).json({ ok:false, error:"durable scheduler lease claim failed; mission refused" });
      }
      if (!scheduledLease.acquired) {
        return res.status(409).json({ ok:false, duplicate:true, error:"scheduled mission window already claimed", project, platform, windowStart });
      }
      // Keep this window claim until expiry; do not release it after a successful run.
    }
    const job = makeJob({ project, objective, platform, format });
    // Internal stage calls stay on this instance and bypass Render edge request timeouts.
    const base = "http://127.0.0.1:" + String(process.env.PORT || 10000);
    const stages = [];
    const call = async (path, body = {}) => {
      const response = await fetch(base + path, {
        method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body),
        signal:AbortSignal.timeout(15 * 60 * 1000)
      });
      let payload = {};
      try { payload = await response.json(); } catch {}
      stages.push({ path, status:response.status, ok:response.ok });
      if (!response.ok) {
        const error = new Error(payload?.error || "autonomous stage failed");
        error.payload = payload;
        throw error;
      }
      return payload;
    };

    // A Render edge proxy can terminate long requests while FFmpeg is still
    // rendering. Acknowledge the durable job immediately, then run the bounded
    // pipeline in the background so the scheduler does not misclassify a slow
    // render as a failed dispatch.
    job.autonomousRun = { status:"RUNNING", owner:"Ax", stages, acceptedAt:nowIso() };
    res.status(200).json({ ok:true, job, autonomousRun:job.autonomousRun });

    void (async () => {
      try {
        await call("/content/jobs/" + job.id + "/research");
        await call("/content/jobs/" + job.id + "/script");
        await call("/content/jobs/" + job.id + "/render-plan");
        const rendered = await call("/content/jobs/" + job.id + "/render-loop");
        const review = await call("/content/jobs/" + job.id + "/ax-review");
        const gate = await call("/content/jobs/" + job.id + "/quality-gate");
        job.autonomousRun = {
          status:gate?.gate?.status === "READY_TO_PUBLISH" ? "READY_TO_PUBLISH" : "BLOCKED",
          owner:"Ax", stages, renderLoop:rendered?.renderLoop || null,
          axReview:review?.review || null, qualityGate:gate?.gate || null,
          completedAt:nowIso()
        };
        if (contentJobRepository) await contentJobRepository.upsert(job);
        console.log("AX_AUTONOMOUS_MISSION_COMPLETE", JSON.stringify({
          jobId:job.id, status:job.autonomousRun.status, stages:stages.length,
          visualQA:job.autonomousRun.renderLoop?.status || null
        }));
      } catch (error) {
        if (scheduledLease?.acquired && leaseRepository && typeof leaseRepository.release === "function") {
          try {
            await leaseRepository.release({ scopeKey:scheduledLease.scopeKey, leaseToken:scheduledLease.leaseToken });
          } catch (releaseError) {
            console.warn("AX_AUTONOMOUS_LEASE_RELEASE_FAILED", JSON.stringify({
              project, platform, message:String(releaseError?.message || releaseError).slice(0,180)
            }));
          }
        }
        job.autonomousRun = { status:"BLOCKED", owner:"Ax", stages, error:String(error?.message || error), failedAt:nowIso() };
        try { if (contentJobRepository) await contentJobRepository.upsert(job); } catch (persistError) {
          console.error("AX_AUTONOMOUS_FAILURE_PERSIST_FAILED", job.id, String(persistError?.message || persistError));
        }
        console.error("AX_AUTONOMOUS_MISSION_FAILED", JSON.stringify({
          jobId:job.id, error:String(error?.message || error), stages
        }));
      }
    })();
  });

  app.post("/content/jobs/:id/run-next", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });

    const next =
      job.stages.research.status === "queued" ? "research" :
      job.stages.script.status === "queued" ? "script" :
      job.stages.edit.status === "ready" ? "edit" :
      job.stages.publish.status === "approval_required" ? "publish" :
      job.stages.analytics.status === "ready" ? "analytics" : "complete";

    res.json({
      ok:true,
      jobId:job.id,
      next,
      message: next === "publish"
        ? "Approval required before publishing."
        : next === "complete"
          ? "Content mission stages are complete."
          : "Next stage is ready for its worker."
    });
  });


  return {
    async initialize() {
      if (!contentJobRepository) {
        console.warn("CONTENT_JOB_STORAGE: memory-only — D1 credentials are not configured");
        return { ok: true, durable: false, restored: 0 };
      }
      await contentJobRepository.initialize();
      const fs = await import("node:fs/promises");
      const restoredJobs = await contentJobRepository.list({ limit: 500 });
      let interrupted = 0;
      for (const job of restoredJobs) {
        if (!job || typeof job.id !== "string") continue;
        let changed = false;
        for (const stage of Object.values(job.stages || {})) {
          if (stage?.status === "running") {
            stage.status = "interrupted";
            stage.result = {
              ...(stage.result && typeof stage.result === "object" ? stage.result : {}),
              interruptedAt: nowIso(),
              reason: "server restarted while this stage was running"
            };
            changed = true;
            interrupted += 1;
          }
        }
        // A D1 row preserves metadata, not Render's ephemeral /tmp video bytes.
        // Never leave a vanished artifact marked verified/publishable after restart.
        const editResult = job.stages?.edit?.result;
        const artifact = editResult?.artifact;
        if (artifact?.path && artifact.verified === true) {
          try {
            await fs.access(artifact.path);
          } catch {
            job.stages.edit.status = "interrupted";
            job.stages.edit.result = {
              ...(editResult && typeof editResult === "object" ? editResult : {}),
              artifact: {
                ...artifact,
                verified: false,
                status: "missing_after_restart",
                unavailableReason: "The video file was stored on ephemeral Render disk and is no longer available."
              }
            };
            changed = true;
          }
        }
        if (changed) {
          job.status = "interrupted";
          job.updatedAt = nowIso();
          await contentJobRepository.upsert(job);
        }
        contentJobs.set(job.id, job);
      }
      console.log("CONTENT_JOB_STORAGE: D1 ready; restored " + restoredJobs.length + " jobs; marked " + interrupted + " running stages interrupted");
      return { ok: true, durable: true, restored: restoredJobs.length, interrupted };
    }
  };

}