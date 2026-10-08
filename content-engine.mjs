// Habitat Content Engine
// Ax-managed pipeline: research -> script -> edit -> approval -> publish -> analytics.
// External publishing is approval-gated; this module never claims an upload happened
// unless a connected publisher worker explicitly reports it.

export function registerContentEngine(app, deps) {
  const { nowIso, makeTaskId, taskStore, workerRegistry, brainChat } = deps;
  const contentJobs = new Map();

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


  // Deterministic Render Worker: creates a real 1080x1920 MP4 using ffmpeg.
  // This is intentionally asset-light for the first Habitat artifact: it proves the
  // complete media-render path without pretending copyrighted trailer footage exists.
  app.post("/content/jobs/:id/render", async (req, res) => {
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
    const titlePath = path.join(outDir, "title.txt");
    const hookPath = path.join(outDir, "hook.txt");
    const footerPath = path.join(outDir, "footer.txt");

    try {
      update(job, "edit", "rendering", { ...job.stages.edit.result, renderPlan });

      await fs.mkdir(outDir, { recursive:true });
      const script = job.stages.script.result || {};
      await fs.writeFile(titlePath, String(script.title || "Vice City 6: The Next Big Leap"));
      await fs.writeFile(hookPath, String(script.hook || "GTA 6 is getting a lot more real."));
      await fs.writeFile(footerPath, "HABITAT ARTIFACT 001  •  AX  •  FACTS, NOT RUMORS");

      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x10131a:s=1080x1920:r=24:d=45",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-vf",
        [
          "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=" + titlePath + ":fontcolor=white:fontsize=72:x=(w-text_w)/2:y=560:line_spacing=12",
          "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=" + hookPath + ":fontcolor=white:fontsize=42:x=(w-text_w)/2:y=760:line_spacing=10",
          "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=" + footerPath + ":fontcolor=white:fontsize=28:x=(w-text_w)/2:y=1750"
        ].join(","),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
        "-t", "45",
        "-movflags", "+faststart",
        outputPath
      ], { timeout: 120000 });

      const stat = await fs.stat(outputPath);
      if (!stat.size) throw new Error("ffmpeg produced an empty artifact");

      const probe = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration,size",
        "-of", "json", outputPath
      ]);
      let probeData = {};
      try { probeData = JSON.parse(probe.stdout); } catch {}
      const durationSeconds = Number(probeData?.format?.duration || 0);
      if (durationSeconds < 44) throw new Error("rendered artifact duration verification failed");

      const artifact = {
        type: "mp4",
        status: "completed",
        path: outputPath,
        bytes: stat.size,
        durationSeconds,
        width: 1080,
        height: 1920,
        renderedAt: nowIso(),
        verified: true,
        renderer: "ffmpeg"
      };

      update(job, "edit", "completed", {
        ...job.stages.edit.result,
        renderPlan: { ...renderPlan, output: artifact },
        artifact
      });
      res.json({ ok:true, job, artifact });
    } catch (error) {
      update(job, "edit", "failed", {
        ...job.stages.edit.result,
        error: String(error?.message || error),
        failedAt: nowIso()
      });
      res.status(502).json({ ok:false, error:"media render failed", detail:String(error?.message || error), job });
    }
  });

  app.get("/content/jobs/:id/artifact", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    const artifact = job.stages.edit?.result?.artifact;
    if (!artifact?.verified || !artifact?.path)
      return res.status(404).json({ ok:false, error:"verified MP4 artifact not available", job });
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
}
