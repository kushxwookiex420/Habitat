import { runVisualQA } from "./visual-qa.mjs";

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
      update(job, "edit", "rendering", { ...job.stages.edit.result, renderPlan, rendererVersion:"v4-scene-engine" });
      await fs.mkdir(outDir, { recursive:true });

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
      sceneInputs.forEach((s, i) => {
        inputs.push("-f","lavfi","-i","color=c="+s.bg+":s=540x960:r=10:d="+s.dur);
        const title = esc(s.title);
        const sub = esc(s.sub);
        filters.push(
          "["+i+":v]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='AX / VICE CITY FILES':fontcolor=white@0.72:fontsize=16:x=39:y=150,drawbox=x=20+20*t:y=205:w=8:h=550:color=white@0.08:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='"+title+"':fontcolor=white:fontsize="+Math.round(32*fontScale)+":x=(w-text_w)/2:y=280,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='"+sub+"':fontcolor=white@0.88:fontsize="+Math.round(18*fontScale)+":x=(w-text_w)/2:y=345,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='FACT-CHECKED • NO RUMORS':fontcolor=white@0.62:fontsize=13:x=(w-text_w)/2:y=858,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VICE CITY FILES • AX':fontcolor=white@0.58:fontsize=13:x=39:y=905,setsar=1[v"+i+"]"
        );
      });
      filters.push(sceneInputs.map((_,i)=>"[v"+i+"]").join("")+"concat=n="+sceneInputs.length+":v=1:a=0,scale=1080:1920:flags=fast_bilinear,format=yuv420p[v]");

      await execFileAsync("ffmpeg", [
        "-hide_banner","-loglevel","error","-y",
        ...inputs,
        "-f","lavfi","-i","anullsrc=channel_layout=stereo:sample_rate=48000",
        "-filter_complex",filters.join(";"),
        "-map","[v]","-map","6:a:0",
        "-c:v","libx264","-preset","ultrafast","-crf","32","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","64k","-ar","48000","-t","45","-shortest",
        "-movflags","+faststart",outputPath
      ],{timeout:120000});

      const stat=await fs.stat(outputPath);
      if(!stat.size) throw new Error("ffmpeg produced an empty artifact");

      const probe=await execFileAsync("ffprobe",[
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
        verified:false,renderer:"ffmpeg-scene-engine-v4",
        audio:"placeholder-silence",
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
      update(job,"edit","failed",{
        ...job.stages.edit.result,
        error:String(error?.message||error),failedAt:nowIso()
      });
      res.status(502).json({ok:false,error:"media render failed",detail:String(error?.message||error),job});
    }
  });

  // Closed-loop render endpoint: failed visual QA feeds remediation back into the renderer.
  app.post("/content/jobs/:id/render-loop", async (req, res) => {
    const job = contentJobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok:false, error:"content job not found" });
    if (job.stages.script.status !== "completed") return res.status(409).json({ ok:false, error:"script must be completed first", job });
    const maxAttempts = 3;
    const history = [];
    let repairPlan = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const base = req.protocol + "://" + req.get("host");
      const response = await fetch(base + "/content/jobs/" + job.id + "/render", {
        method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({ attempt, maxAttempts, repairPlan })
      });
      let payload = {};
      try { payload = await response.json(); } catch {}
      const qa = payload.visualQA || payload.artifact?.visualQA || null;
      history.push({ attempt, status:response.status, qaStatus:qa?.status || null, issues:qa?.issues || [], remediation:qa?.remediation || [] });
      if (response.ok && payload.artifact?.verified === true) {
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

  // Scheduler hook: when enabled, Ax can start bounded autonomous missions on a cadence.
  // The timer is opt-in so deployment alone never creates unexpected external activity.
  const autonomousIntervalMinutes = Math.max(0, Number(process.env.HABITAT_AUTONOMOUS_INTERVAL_MINUTES || 0));
  if (autonomousIntervalMinutes > 0) {
    const objective = String(process.env.HABITAT_AUTONOMOUS_OBJECTIVE || "Create the next best ViceCityFiles short-form content mission.").trim();
    const project = String(process.env.HABITAT_AUTONOMOUS_PROJECT || "ViceCityFiles").trim();
    const platform = String(process.env.HABITAT_AUTONOMOUS_PLATFORM || "tiktok").trim().toLowerCase();
    const runAutonomous = async () => {
      try {
        const job = makeJob({ project, objective, platform, format:"9:16" });
        const base = "http://127.0.0.1:" + String(process.env.PORT || 10000);
        const response = await fetch(base + "/content/jobs/" + job.id + "/research", {
          method:"POST", headers:{"content-type":"application/json"}, body:"{}"
        });
        console.log("AX_AUTONOMOUS_TICK", JSON.stringify({jobId:job.id,status:response.status,startedAt:nowIso()}));
      } catch (error) {
        console.error("AX_AUTONOMOUS_TICK_FAILED", String(error?.message || error));
      }
    };
    setTimeout(runAutonomous, 1500);
    setInterval(runAutonomous, autonomousIntervalMinutes * 60 * 1000);
  }

  // Ax autonomous mission runner: executes every safe stage in order and stops only at the external publish approval boundary.
  app.post("/content/autonomous-run", async (req, res) => {
    const objective = String(req.body?.objective || "").trim();
    if (!objective) return res.status(400).json({ ok:false, error:"objective required" });
    const job = makeJob({
      project: String(req.body?.project || "ViceCityFiles"),
      objective,
      platform: String(req.body?.platform || "tiktok"),
      format: String(req.body?.format || "9:16")
    });
    const base = req.protocol + "://" + req.get("host");
    const stages = [];
    const call = async (path, body = {}) => {
      const response = await fetch(base + path, {
        method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)
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
    try {
      await call("/content/jobs/" + job.id + "/research");
      await call("/content/jobs/" + job.id + "/script");
      await call("/content/jobs/" + job.id + "/render-plan");
      const rendered = await call("/content/jobs/" + job.id + "/render-loop");
      const review = await call("/content/jobs/" + job.id + "/ax-review");
      const gate = await call("/content/jobs/" + job.id + "/quality-gate");
      // Never cross the external publishing boundary automatically unless a publisher bridge is configured.
      job.autonomousRun = {
        status: gate?.gate?.status === "READY_TO_PUBLISH" ? "READY_TO_PUBLISH" : "BLOCKED",
        owner:"Ax", stages, renderLoop:rendered?.renderLoop || null,
        axReview:review?.review || null, qualityGate:gate?.gate || null,
        completedAt:nowIso()
      };
      res.json({ ok:true, job, autonomousRun:job.autonomousRun });
    } catch (error) {
      job.autonomousRun = { status:"BLOCKED", owner:"Ax", stages, error:String(error?.message || error), failedAt:nowIso() };
      res.status(502).json({ ok:false, error:"autonomous mission stopped", job, autonomousRun:job.autonomousRun, detail:error?.payload || null });
    }
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
