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

  // Media editing is explicitly worker-backed. The API creates an edit manifest;
  // a future Android/Render editor worker can consume it and return an artifact.
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

  // Publishing always stops at approval. A connected publisher may later consume
  // the approved manifest and report the actual upload ID.
  app.post("/content/jobs/:id/approve-publish", (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.edit.status !== "completed")
      return res.status(409).json({ ok:false, error:"edited artifact must be completed first", job });

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
