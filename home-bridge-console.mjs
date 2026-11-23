// Habitat command center for Home Bridge.
//
//   /bridge/console          the galaxy console (HTML, no secrets inside)
//   POST /bridge/console/login       exchange the operator token for an HttpOnly session cookie
//   POST /bridge/console/logout
//   GET  /bridge/console/dashboard   aggregated AX / BUFF / PHONE / PROJECTS payload
//   GET  /bridge/console/tasks       task list with status
//   POST /bridge/console/tasks       submit a task to Buff (ax credential)
//   POST /bridge/console/claim       claim queued tasks (buff credential)
//   GET  /bridge/console/replies     replies with artifacts
//   GET  /bridge/console/files       shared folder listing
//   GET  /bridge/console/file        one shared file
//   POST /bridge/console/send        queue an allowlisted phone command (ax credential)
//
// Operator authentication is HABITAT_AX_BRIDGE_TOKEN, accepted as a Bearer header or exchanged
// for a session cookie so a browser never stores a credential in JavaScript. The relay's own
// role tokens (ax/buff) stay on the server and are never part of a response body.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createHomeBridgeClient } from "./home-bridge-client.mjs";

const SESSION_COOKIE = "habitat_bridge_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const GITHUB_CACHE_MS = 60000;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req) {
  const value = String(req.headers?.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionId() {
  return randomBytes(32).toString("hex");
}

function short(value, max = 200) {
  return String(value == null ? "" : value).slice(0, max);
}

export function registerHomeBridgeConsole(app, { env = process.env, fetchImpl = fetch, deviceRepository = null, bridgeStatus = null } = {}) {
  const client = createHomeBridgeClient({
    baseUrl: env.HOME_BRIDGE_URL,
    axToken: env.HOME_BRIDGE_AX_TOKEN,
    buffToken: env.HOME_BRIDGE_BUFF_TOKEN,
    fetchImpl
  });
  // The console is the browser-facing surface, so it prefers its own credential. The bridge token
  // that authenticates machine callers is only a compatibility fallback, which keeps an existing
  // deployment working until HABITAT_OPERATOR_TOKEN is configured.
  const operatorToken = String(env.HABITAT_OPERATOR_TOKEN || env.HABITAT_AX_BRIDGE_TOKEN || "").trim();
  const githubRepo = String(env.HABITAT_GITHUB_REPO || "kushxwookiex420/home-launcher").trim();
  const githubToken = String(env.GITHUB_TOKEN || "").trim();
  const sessions = new Map();
  const githubCache = { at: 0, data: null };

  function pruneSessions(now) {
    for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id);
  }

  function operatorFromSession(req) {
    const id = cookies(req)[SESSION_COOKIE];
    if (!id) return null;
    const expiry = sessions.get(id);
    if (!expiry || expiry <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return id;
  }

  function requireOperator(req, res, next) {
    if (!operatorToken) {
      return res.status(503).json({ ok: false, error: "HABITAT_OPERATOR_TOKEN (or HABITAT_AX_BRIDGE_TOKEN) is not configured; console access is disabled." });
    }
    if (safeEqual(bearer(req), operatorToken) || operatorFromSession(req)) return next();
    return res.status(401).json({ ok: false, error: "Operator authentication required." });
  }

  function setSessionCookie(res, id) {
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${id}; Path=/bridge/console; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    );
  }

  app.post("/bridge/console/login", (req, res) => {
    if (!operatorToken) {
      return res.status(503).json({ ok: false, error: "HABITAT_OPERATOR_TOKEN (or HABITAT_AX_BRIDGE_TOKEN) is not configured; console access is disabled." });
    }
    const supplied = String(req.body?.token || bearer(req) || "").trim();
    if (!safeEqual(supplied, operatorToken)) {
      return res.status(401).json({ ok: false, error: "Invalid operator token." });
    }
    const now = Date.now();
    pruneSessions(now);
    const id = sessionId();
    sessions.set(id, now + SESSION_TTL_MS);
    setSessionCookie(res, id);
    return res.json({ ok: true, expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000) });
  });

  app.post("/bridge/console/logout", (req, res) => {
    const id = cookies(req)[SESSION_COOKIE];
    if (id) sessions.delete(id);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/bridge/console; HttpOnly; SameSite=Strict; Max-Age=0`);
    return res.json({ ok: true });
  });

  app.get("/bridge/console/session", (req, res) => {
    const active = Boolean(operatorFromSession(req)) || (operatorToken && safeEqual(bearer(req), operatorToken));
    return res.json({ ok: true, authenticated: Boolean(active), relay: client.roles });
  });

  // ---- read models -------------------------------------------------------

  async function latestCommits() {
    if (githubCache.data && Date.now() - githubCache.at < GITHUB_CACHE_MS) return githubCache.data;
    const url = `https://api.github.com/repos/${githubRepo}/commits?per_page=5`;
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "habitat-bridge-console",
          ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
        }
      });
      if (!response.ok) {
        const data = { ok: false, status: response.status, commits: [], error: `github HTTP ${response.status}` };
        githubCache.at = Date.now();
        githubCache.data = data;
        return data;
      }
      const body = await response.json();
      const commits = (Array.isArray(body) ? body : []).slice(0, 5).map((entry) => ({
        sha: short(entry.sha, 40),
        short: short(entry.sha, 7),
        message: short(entry.commit?.message?.split("\n")[0], 160),
        author: short(entry.commit?.author?.name, 60),
        date: short(entry.commit?.author?.date, 40),
        url: short(entry.html_url, 200)
      }));
      const data = { ok: true, status: response.status, repo: githubRepo, commits };
      githubCache.at = Date.now();
      githubCache.data = data;
      return data;
    } catch {
      const data = { ok: false, status: 0, commits: [], error: "github unreachable" };
      githubCache.at = Date.now();
      githubCache.data = data;
      return data;
    }
  }

  /**
   * The device registry as the console can honestly show it: who is paired, when the pairing was
   * recorded, and when the phone last authenticated. No token, hash or pairing code is included.
   * When the store is unavailable the console says so instead of implying the phone is unpaired.
   */
  async function phoneRegistry() {
    if (!deviceRepository || typeof deviceRepository.listDevices !== "function") {
      return { ok: false, available: false, link: "UNKNOWN", devices: [], error: "phone pairing store is not available" };
    }
    try {
      const rows = await deviceRepository.listDevices();
      const devices = (rows || []).map((row) => ({
        deviceId: row.device_id,
        pairedAt: row.created_at || null,
        lastSeenAt: row.last_seen_at || null,
        revoked: Boolean(row.revoked_at),
        deviceInfo: (() => { try { return row.device_json ? JSON.parse(row.device_json) : null; } catch { return null; } })()
      }));
      const active = devices.filter((row) => !row.revoked);
      const ordered = (active.length ? active : devices).slice().sort((a, b) =>
        Date.parse(b.lastSeenAt || b.pairedAt || 0) - Date.parse(a.lastSeenAt || a.pairedAt || 0)
      );
      const current = ordered[0] || null;
      const live = Boolean(current?.lastSeenAt && Date.now() - Date.parse(current.lastSeenAt) < 45000);
      return {
        ok: true,
        available: true,
        link: !devices.length ? "UNPAIRED" : live ? "LIVE" : "LINKED",
        count: devices.length,
        device: current,
        devices,
        error: null
      };
    } catch (error) {
      return { ok: false, available: true, link: "UNKNOWN", devices: [], error: "unable to read paired phones" };
    }
  }

  /**
   * AX Core credential reporting. The credential that matters for the phone is the device bridge's
   * own inbound token, which is a different secret from the legacy Home Bridge relay role tokens.
   * Only booleans leave this function; a probe that throws degrades to "unknown", never to present.
   */
  function deviceBridgeStatus() {
    const unknown = { ok: false, available: false, ready: false, durable: false, axTokenConfigured: false, perDeviceTokens: false };
    try {
      const status = typeof bridgeStatus === "function" ? bridgeStatus() : bridgeStatus;
      if (!status || typeof status !== "object") return unknown;
      return {
        ok: true,
        available: true,
        ready: Boolean(status.ready),
        durable: Boolean(status.durable),
        axTokenConfigured: Boolean(status.axTokenConfigured),
        perDeviceTokens: Boolean(status.perDeviceTokens)
      };
    } catch {
      return unknown;
    }
  }

  async function dashboard() {
    const [health, state, tasks, replies, files, queue, commits, phone] = await Promise.all([
      client.health(),
      client.state(),
      client.tasks({ limit: 20 }),
      client.replies({ limit: 20 }),
      client.listFiles(),
      client.configured("buff") ? client.queue() : Promise.resolve({ ok: false, status: 0, error: "buff credential not configured" }),
      latestCommits(),
      phoneRegistry()
    ]);

    const taskRows = tasks.data?.tasks || [];
    const replyRows = replies.data?.replies || [];
    const queueRows = queue.data?.tasks || [];
    const fileRows = files.data?.files || [];
    const commands = state.data?.commands || [];

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      relay: {
        url: client.baseUrl,
        credentials: client.roles,
        health: health.ok ? "ok" : "unavailable",
        healthDetail: health.error || (health.data?.db ? "database reachable" : "database state unknown")
      },
      ax: {
        ok: tasks.ok || replies.ok,
        tasks: taskRows,
        counts: {
          queued: taskRows.filter((t) => t.status === "queued").length,
          working: taskRows.filter((t) => t.status === "working").length,
          done: taskRows.filter((t) => t.status === "done").length
        },
        replies: replyRows
      },
      buff: {
        ok: queue.ok,
        queue: queueRows,
        error: queue.ok ? null : queue.error,
        activity: replyRows.map((r) => ({ at: r.iso, text: short(r.text, 200), taskId: r.taskId, artifacts: r.artifacts || [] })),
        artifacts: replyRows.flatMap((r) => r.artifacts || [])
      },
      phone: {
        ok: state.ok,
        name: state.data?.name || null,
        online: Boolean(state.data?.online),
        lastSeen: state.data?.lastSeen || null,
        lastSeenIso: state.data?.commands?.[0]?.iso || null,
        commands,
        error: state.ok ? null : state.error
      },
      devices: phone,
      deviceBridge: deviceBridgeStatus(),
      cloud: {
        relayOk: health.ok,
        github: commits,
        deployments: {
          relay: { url: client.baseUrl, status: health.ok ? "online" : "unreachable" },
          habitat: { status: "running", note: "This response is served by the Habitat process itself." }
        }
      },
      files: { ok: files.ok, count: fileRows.length, items: fileRows },
      errors: [
        tasks.ok ? null : { source: "tasks", error: tasks.error },
        replies.ok ? null : { source: "replies", error: replies.error },
        files.ok ? null : { source: "files", error: files.error },
        state.ok ? null : { source: "state", error: state.error },
        queue.ok ? null : { source: "queue", error: queue.error },
        commits.ok ? null : { source: "github", error: commits.error }
      ].filter(Boolean)
    };
  }

  app.get("/bridge/console/dashboard", requireOperator, async (_req, res) => {
    try {
      return res.json(await dashboard());
    } catch (error) {
      return res.status(502).json({ ok: false, error: "dashboard aggregation failed", detail: short(error?.message, 200) });
    }
  });

  app.get("/bridge/console/tasks", requireOperator, async (_req, res) => {
    const result = await client.tasks({ limit: 50 });
    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      tasks: result.data?.tasks || [],
      error: result.error
    });
  });

  app.get("/bridge/console/replies", requireOperator, async (req, res) => {
    const result = await client.replies({ limit: 50, taskId: req.query?.taskId });
    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      replies: result.data?.replies || [],
      serverTime: result.data?.serverTime || null,
      error: result.error
    });
  });

  app.get("/bridge/console/files", requireOperator, async (_req, res) => {
    const result = await client.listFiles();
    return res.status(result.ok ? 200 : 502).json({ ok: result.ok, files: result.data?.files || [], error: result.error });
  });

  app.get("/bridge/console/file", requireOperator, async (req, res) => {
    const name = String(req.query?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name is required" });
    const result = await client.readFile(name);
    return res.status(result.ok ? 200 : result.status === 404 ? 404 : 502).json({
      ok: result.ok,
      name,
      data: result.data?.data ?? null,
      encoding: result.data?.encoding ?? null,
      size: result.data?.size ?? null,
      error: result.error
    });
  });

  // ---- actions -----------------------------------------------------------

  app.post("/bridge/console/tasks", requireOperator, async (req, res) => {
    const text = String(req.body?.text || "").trim();
    const title = String(req.body?.title || "").trim().slice(0, 120);
    if (!text) return res.status(400).json({ ok: false, error: "text is required" });
    if (text.length > 4000) return res.status(400).json({ ok: false, error: "text must be 4000 characters or fewer" });
    const result = await client.submitTask({ text, title: title || undefined, source: "habitat-ax" });
    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      taskId: result.data?.taskId ?? null,
      createdAt: result.data?.createdAt ?? null,
      error: result.error
    });
  });

  app.post("/bridge/console/claim", requireOperator, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => String(id)).slice(0, 50) : [];
    const result = await client.claimTasks(ids);
    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      acknowledged: result.data?.acknowledged ?? null,
      error: result.error
    });
  });

  const ALLOWED_PHONE_ACTIONS = new Set(["status", "page", "app", "torch", "clear", "remote", "url"]);

  app.post("/bridge/console/send", requireOperator, async (req, res) => {
    const action = String(req.body?.action || "").trim();
    const arg = String(req.body?.arg || "").trim();
    if (!ALLOWED_PHONE_ACTIONS.has(action)) {
      return res.status(400).json({ ok: false, error: `action must be one of ${[...ALLOWED_PHONE_ACTIONS].join(", ")}` });
    }
    const result = await client.sendPhoneAction({ action, arg });
    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      id: result.data?.id ?? null,
      action,
      arg,
      error: result.error
    });
  });

  // The console page itself holds no secrets: it authenticates with the operator token the user
  // types in, then relies on the HttpOnly session cookie.
  app.get("/bridge/console", (req, res) => {
    res.type("html").send(renderConsole());
  });

  return { client, dashboard, requireOperator };
}

export function renderConsole() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#04070d">
<title>Habitat · Command Center</title>
<style>
:root{color-scheme:dark;--void:#04070d;--glass:rgba(11,24,33,.72);--line:rgba(79,227,224,.22);--cyan:#4fe3e0;--violet:#a97bff;--text:#e9fbfc;--muted:#8fb3bb}
*{box-sizing:border-box}
html,body{margin:0;background:var(--void);color:var(--text);font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:hidden}
body{min-height:100vh;background:
 radial-gradient(ellipse 120% 70% at 50% -10%,rgba(79,227,224,.13),transparent 60%),
 radial-gradient(ellipse 70% 50% at 100% 20%,rgba(169,123,255,.12),transparent 65%),
 radial-gradient(ellipse 80% 60% at 0% 90%,rgba(79,227,224,.08),transparent 60%),
 var(--void)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:radial-gradient(1px 1px at 12% 18%,#fff9 40%,transparent 41%),radial-gradient(1px 1px at 72% 8%,#fff7 40%,transparent 41%),radial-gradient(1px 1px at 38% 62%,#fff6 40%,transparent 41%),radial-gradient(2px 2px at 88% 48%,#4fe3e088 40%,transparent 41%),radial-gradient(1px 1px at 22% 84%,#a97bff88 40%,transparent 41%),radial-gradient(1px 1px at 58% 92%,#fff5 40%,transparent 41%);opacity:.8}
.wrap{width:min(560px,100%);margin:auto;padding:18px 14px 40px;position:relative}
header.top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px}
.brand{display:flex;align-items:center;gap:10px;letter-spacing:.16em;font-size:12px;font-weight:700;color:var(--cyan)}
.orb{width:34px;height:34px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#bffffa,#4fe3e0 38%,#123a52 78%);box-shadow:0 0 18px #4fe3e066,0 0 42px #a97bff44;animation:pulse 4s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 26px #4fe3e099,0 0 60px #a97bff55}}
.chip{font-size:10px;letter-spacing:.12em;padding:5px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:rgba(8,18,26,.8)}
.chip.on{color:#061318;background:var(--cyan);border-color:var(--cyan);font-weight:700}
h1{font-size:19px;letter-spacing:.14em;margin:6px 0 2px;font-weight:600}
.sub{color:var(--muted);font-size:11px;letter-spacing:.1em;margin-bottom:16px}
.panel{background:var(--glass);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:12px;backdrop-filter:blur(10px);box-shadow:0 10px 30px #0008}
.panel h2{font-size:11px;letter-spacing:.18em;margin:0 0 10px;color:var(--cyan);font-weight:700;display:flex;justify-content:space-between}
.panel h2 span{color:var(--muted);font-weight:400;letter-spacing:.06em}
.row{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed #ffffff12;font-size:12px}
.row:last-child{border-bottom:0}
.row .k{color:var(--muted)}
.row .v{color:var(--text);text-align:right;word-break:break-word}
.list{max-height:210px;overflow:auto;-webkit-overflow-scrolling:touch}
.item{border-left:2px solid var(--violet);padding:6px 0 6px 9px;margin-bottom:8px;font-size:12px}
.item .meta{color:var(--muted);font-size:10px;letter-spacing:.08em}
.item .body{color:#dff;white-space:pre-wrap;word-break:break-word}
.item.cyan{border-left-color:var(--cyan)}
.item.done{border-left-color:#6ef0a0}
a{color:var(--cyan)}
input,select,button,textarea{font:inherit;color:var(--text);background:rgba(6,14,20,.9);border:1px solid var(--line);border-radius:10px;padding:9px 10px;width:100%}
textarea{min-height:64px;resize:vertical}
button{background:linear-gradient(140deg,#4fe3e0,#5ad1ff);color:#04121a;font-weight:800;letter-spacing:.08em;border:0;cursor:pointer}
button.ghost{background:transparent;color:var(--cyan);border:1px solid var(--line);font-weight:600}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.tabs{display:flex;gap:6px;overflow:auto;padding-bottom:8px;margin-bottom:4px}
.tabs button{flex:0 0 auto;width:auto;padding:7px 11px;font-size:10px;letter-spacing:.12em;background:rgba(8,18,26,.85);color:var(--muted);border:1px solid var(--line);font-weight:600}
.tabs button.active{color:#04121a;background:var(--cyan);border-color:var(--cyan)}
.hidden{display:none!important}
.login{max-width:420px;margin:8vh auto}
.note{color:var(--muted);font-size:11px;margin-top:8px;line-height:1.5}
.err{color:#ff9db1;font-size:11px;margin-top:6px}
footer{color:#527080;font-size:10px;letter-spacing:.1em;text-align:center;padding-top:8px}
@media(min-width:720px){.wrap{width:min(920px,100%)}.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}}
</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <div class="brand"><span class="orb"></span>HABITAT · AX CORE</div>
  <span class="chip" id="link-chip">HOME RELAY …</span>
</header>

<section id="login-view" class="panel login">
  <h2>OPERATOR ACCESS <span>session</span></h2>
  <p class="note">Paste the Habitat operator token (HABITAT_OPERATOR_TOKEN). It is sent once, exchanged for an HttpOnly session, and never stored in this page.</p>
  <input id="token" type="password" autocomplete="off" placeholder="operator token" aria-label="Operator token">
  <div class="grid2"><button id="login">UNLOCK</button><button class="ghost" id="probe">CHECK RELAY</button></div>
  <div class="err" id="login-err"></div>
</section>

<div id="console-view" class="hidden">
  <h1>COMMAND CENTER</h1>
  <div class="sub" id="stamp">awaiting telemetry</div>
  <div class="tabs" id="tabs">
    <button data-tab="ax" class="active">AX</button>
    <button data-tab="buff">BUFF</button>
    <button data-tab="workers">WORKERS</button>
    <button data-tab="tasks">TASKS</button>
    <button data-tab="phone">PHONE</button>
    <button data-tab="cloud">CLOUD</button>
    <button data-tab="files">FILES</button>
  </div>

  <div class="cols">
    <section class="panel" data-view="ax">
      <h2>AX · CORE <span id="ax-status">—</span></h2>
      <div class="row"><span class="k">device bridge</span><span class="v" id="ax-bridge">—</span></div>
      <div class="row"><span class="k">home relay</span><span class="v" id="ax-relay">—</span></div>
      <p class="note">AX credential is this server's device bridge token, the one that authenticates the phone. HOME RELAY is the separate legacy relay; its own ax/buff role credentials are reported in CLOUD.</p>
      <div class="row"><span class="k">queued</span><span class="v" id="ax-queued">—</span></div>
      <div class="row"><span class="k">working</span><span class="v" id="ax-working">—</span></div>
      <div class="row"><span class="k">done</span><span class="v" id="ax-done">—</span></div>
      <h2 style="margin-top:14px">DELEGATE TO BUFF</h2>
      <input id="task-title" placeholder="short title" aria-label="Task title">
      <textarea id="task-text" placeholder="one precise task for the agent" aria-label="Task text"></textarea>
      <div class="grid2"><button id="submit-task">QUEUE TASK</button><button class="ghost" id="refresh">REFRESH</button></div>
      <div class="err" id="task-err"></div>
    </section>

    <section class="panel hidden" data-view="buff">
      <h2>BUFF · AGENT <span id="buff-status">—</span></h2>
      <div class="list" id="buff-queue"></div>
      <div class="grid2"><button id="claim">CLAIM QUEUE</button><button class="ghost" id="buff-refresh">REFRESH</button></div>
      <h2 style="margin-top:14px">ACTIVITY</h2>
      <div class="list" id="buff-activity"></div>
    </section>

    <section class="panel hidden" data-view="workers">
      <h2>WORKERS · AGENTS <span id="workers-status">—</span></h2>
      <div class="list" id="worker-list"></div>
      <p class="note">Derived from relay telemetry: credential presence, queue depth, last reply, phone polling and service health. A worker is only "active" when the relay reports it.</p>
    </section>

    <section class="panel hidden" data-view="tasks">
      <h2>TASKS · STATUS <span id="tasks-count">—</span></h2>
      <div class="list" id="task-list"></div>
    </section>

    <section class="panel hidden" data-view="phone">
      <h2>PHONE · RELAY <span id="phone-status">—</span></h2>
      <div class="row"><span class="k">device</span><span class="v" id="phone-name">—</span></div>
      <div class="row"><span class="k">last check-in</span><span class="v" id="phone-seen">—</span></div>
      <h2 style="margin-top:14px">PAIR PHONE <span id="pair-link">—</span></h2>
      <div class="row"><span class="k">registered phone</span><span class="v" id="pair-device-id">—</span></div>
      <div class="row"><span class="k">paired at</span><span class="v" id="pair-paired-at">—</span></div>
      <div class="row"><span class="k">confirmed</span><span class="v" id="pair-confirmed">never</span></div>
      <input id="pair-device" placeholder="optional: phone device ID to bind the code to" aria-label="Phone device ID">
      <div class="grid2"><button id="pair-create">GENERATE PAIRING CODE</button><button class="ghost" id="pair-clear">CLEAR CODE</button></div>
      <div class="err" id="pair-err"></div>
      <div id="pair-code" class="hidden">
        <div class="item cyan"><div class="meta" id="pair-meta"></div><div class="body" id="pair-value" style="font-size:16px;letter-spacing:.14em;user-select:all"></div></div>
        <p class="note">Open the Bridge app → LINK → paste this as the one-time AX pairing code. Single use, shown only once, expires after 10 minutes.</p>
      </div>
      <h2 style="margin-top:14px">APPROVED COMMAND</h2>
      <select id="cmd-action" aria-label="Action">
        <option value="status">status</option>
        <option value="page">page</option>
        <option value="app">app</option>
        <option value="torch">torch</option>
        <option value="clear">clear</option>
        <option value="remote">remote</option>
        <option value="url">url</option>
      </select>
      <div style="height:8px"></div>
      <input id="cmd-arg" placeholder="argument (page name, app, on|off, key|device, https link)" aria-label="Command argument">
      <div class="grid2"><button id="send-cmd">QUEUE COMMAND</button><button class="ghost" id="phone-refresh">REFRESH</button></div>
      <div class="err" id="cmd-err"></div>
      <h2 style="margin-top:14px">RESULTS</h2>
      <div class="list" id="cmd-list"></div>
    </section>

    <section class="panel hidden" data-view="cloud">
      <h2>CLOUD · SERVICES <span id="cloud-status">—</span></h2>
      <div class="row"><span class="k">home relay</span><span class="v" id="cloud-relay">—</span></div>
      <div class="row"><span class="k">home relay credentials</span><span class="v" id="cloud-relay-cred">—</span></div>
      <div class="row"><span class="k">github</span><span class="v" id="cloud-github">—</span></div>
      <h2 style="margin-top:14px">COMMITS</h2>
      <div class="list" id="commit-list"></div>
    </section>

    <section class="panel hidden" data-view="files">
      <h2>FILES · SHARED <span id="files-count">—</span></h2>
      <div class="list" id="file-list"></div>
      <div class="item body hidden" id="file-preview"></div>
    </section>
  </div>
  <footer>HABITAT BRIDGE CONSOLE · <a href="#" id="logout">lock session</a></footer>
</div>
</div>
<script>
(function(){
  var state={data:null};
  var $=function(id){return document.getElementById(id)};
  function text(id,value){var el=$(id);if(el)el.textContent=value}
  function esc(value){return String(value==null?"":value).replace(/[&<>"]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":"&quot;"})}
  function when(iso){if(!iso)return "unknown";var d=new Date(iso);if(isNaN(d))return String(iso);return d.toLocaleString()}
  async function api(path,options){
    var res=await fetch(path,Object.assign({cache:"no-store",credentials:"same-origin"},options||{}));
    var data=await res.json().catch(function(){return {}});
    if(!res.ok||data.ok===false){var e=new Error(data.error||("HTTP "+res.status));e.status=res.status;throw e}
    return data;
  }
  function show(view){
    document.querySelectorAll("[data-view]").forEach(function(el){el.classList.toggle("hidden",el.getAttribute("data-view")!==view)});
    document.querySelectorAll("#tabs button").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-tab")===view)});
  }
  document.querySelectorAll("#tabs button").forEach(function(b){b.addEventListener("click",function(){show(b.getAttribute("data-tab"))})});

  function render(data){
    state.data=data;
    var relay=data.relay||{},ax=data.ax||{},buff=data.buff||{},phone=data.phone||{},cloud=data.cloud||{},files=data.files||{};
    var bridge=data.deviceBridge||{},bridgeAx=bridge.axTokenConfigured===true,relayOk=relay.health==="ok",relayCred=relay.credentials||{};
    text("link-chip",relayOk?"HOME RELAY ONLINE":"HOME RELAY OFFLINE");
    $("link-chip").className="chip "+(relayOk?"on":"");
    $("link-chip").title="home relay: "+(relay.healthDetail||(relayOk?"reachable":"unavailable"));
    text("stamp","SYNCED "+when(data.generatedAt));
    text("ax-status","device bridge ax credential "+(bridgeAx?"present":"missing"));
    text("ax-bridge",bridge.ready?(bridge.durable?"ready · durable":"ready"):"not ready");
    text("ax-relay",relayOk?"online":("offline · "+(relay.healthDetail||"unreachable")));
    text("ax-queued",(ax.counts&&ax.counts.queued)??"—");
    text("ax-working",(ax.counts&&ax.counts.working)??"—");
    text("ax-done",(ax.counts&&ax.counts.done)??"—");
    text("buff-status",buff.ok?"queue live":"queue unavailable");
    text("tasks-count",(ax.tasks||[]).length+" recent");
    text("phone-status",phone.online?"ONLINE":"LAST KNOWN");
    text("phone-name",phone.name||"—");
    text("phone-seen",phone.lastSeen?when(new Date(phone.lastSeen).toISOString()):"never");

    var devices=data.devices||{};
    var current=devices.device||null;
    text("pair-link",devices.link||"UNKNOWN");
    text("pair-device-id",current?current.deviceId:"none registered");
    text("pair-paired-at",current&&current.pairedAt?when(current.pairedAt):"—");
    text("pair-confirmed",current&&current.lastSeenAt?when(current.lastSeenAt):"never");
    if(devices.ok===false&&!$("pair-err").textContent)text("pair-err",devices.error||"pairing store unavailable");
    $("pair-device").placeholder=current?("optional: bind the code to "+current.deviceId):"optional: phone device ID to bind the code to";
    text("cloud-status",relayOk?"nominal":"degraded");
    text("cloud-relay",relay.url||"—");
    text("cloud-relay-cred","ax "+(relayCred.ax?"present":"missing")+" · buff "+(relayCred.buff?"present":"missing"));
    text("cloud-github",(cloud.github&&cloud.github.ok)?((cloud.github.repo||"")+" · "+cloud.github.commits.length+" commits"):((cloud.github&&cloud.github.error)||"not configured"));
    text("files-count",(files.count||0)+" files");

    var workers=[
      {name:"AX · relay tasks",state:(relayCred.ax&&ax.ok)?"active":"offline",detail:"relay task API · device bridge ax credential "+(bridgeAx?"present":"missing")},
      {name:"BUFF · agent",state:buff.ok?(buff.queue.length?"assigned":"idle"):"offline",detail:(buff.queue||[]).length+" queued · "+(buff.activity||[]).length+" replies on record"},
      {name:"PHONE · poller",state:phone.online?"polling":"idle",detail:phone.lastSeen?("last check-in "+when(phone.lastSeen)):"no check-in yet"},
      {name:"HOME RELAY · legacy",state:relayOk?"online":"unreachable",detail:(relay.url||"")+(relayOk?"":" · "+(relay.healthDetail||"unavailable"))},
      {name:"GITHUB · commits",state:(cloud.github&&cloud.github.ok)?"online":"unavailable",detail:(cloud.github&&cloud.github.ok)?((cloud.github.repo||"")+" · "+cloud.github.commits.length+" commits"):((cloud.github&&cloud.github.error)||"not configured")}
    ];
    text("workers-status",workers.filter(function(w){return w.state!=="offline"&&w.state!=="unreachable"}).length+" reporting");
    $("worker-list").innerHTML=workers.map(function(w){
      var cls=w.state==="active"||w.state==="polling"||w.state==="online"?"done":w.state==="assigned"?"cyan":"";
      return '<div class="item '+cls+'"><div class="meta">'+esc(w.state.toUpperCase())+'</div><div class="body">'+esc(w.name)+'</div><div class="meta">'+esc(w.detail)+'</div></div>'
    }).join("");

    $("task-list").innerHTML=(ax.tasks||[]).map(function(t){
      return '<div class="item '+(t.status==="done"?"done":t.status==="working"?"":"cyan")+'"><div class="meta">'+esc(t.status)+' · '+when(t.iso)+' · '+esc(String(t.id).slice(0,8))+'</div><div class="body">'+esc(t.title||t.text)+'</div>'+(t.artifacts&&t.artifacts.length?'<div class="meta">artifacts: '+t.artifacts.map(function(a){return '<a href="'+esc(a)+'" rel="noreferrer noopener" target="_blank">link</a>'}).join(' ')+'</div>':'')+'</div>'
    }).join("")||'<div class="item meta">no tasks</div>';

    $("buff-queue").innerHTML=(buff.queue||[]).map(function(t){
      return '<div class="item cyan"><div class="meta">'+esc(t.status)+' · '+when(t.iso)+' · '+esc(t.source||"ax")+'</div><div class="body">'+esc(t.title||t.text)+'</div></div>'
    }).join("")||'<div class="item meta">queue empty</div>';

    $("buff-activity").innerHTML=(buff.activity||[]).map(function(a){
      return '<div class="item"><div class="meta">'+when(a.at)+'</div><div class="body">'+esc(a.text)+'</div></div>'
    }).join("")||'<div class="item meta">no replies yet</div>';

    $("cmd-list").innerHTML=(phone.commands||[]).map(function(c){
      return '<div class="item '+(c.status==="done"?"done":"cyan")+'"><div class="meta">'+esc(c.action)+(c.arg?" · "+esc(c.arg):"")+' · '+esc(c.status||"")+' · '+when(c.iso)+'</div><div class="body">'+esc(c.output||"awaiting phone result")+'</div></div>'
    }).join("")||'<div class="item meta">no commands</div>';

    $("commit-list").innerHTML=((cloud.github&&cloud.github.commits)||[]).map(function(c){
      return '<div class="item"><div class="meta">'+esc(c.short)+' · '+when(c.date)+'</div><div class="body">'+esc(c.message)+'</div></div>'
    }).join("")||'<div class="item meta">commits unavailable</div>';

    $("file-list").innerHTML=(files.items||[]).map(function(f){
      return '<div class="item cyan" data-name="'+esc(f.name)+'"><div class="meta">'+esc(f.size)+' B · '+esc(f.encoding)+' · '+when(f.iso)+'</div><div class="body">'+esc(f.name)+'</div></div>'
    }).join("")||'<div class="item meta">no files</div>';
    document.querySelectorAll("#file-list [data-name]").forEach(function(el){
      el.style.cursor="pointer";
      el.addEventListener("click",async function(){
        try{var d=await api("/bridge/console/file?name="+encodeURIComponent(el.getAttribute("data-name")));
        var p=$("file-preview");p.classList.remove("hidden");
        p.innerHTML='<div class="meta">'+esc(d.name)+'</div><div class="body">'+esc(String(d.data||"").slice(0,4000))+'</div>';
        }catch(e){var p=$("file-preview");p.classList.remove("hidden");p.innerHTML='<div class="body">'+esc(e.message)+'</div>'}
      });
    });
  }

  async function load(){
    try{render(await api("/bridge/console/dashboard"));$("login-view").classList.add("hidden");$("console-view").classList.remove("hidden")}
    catch(e){
      $("login-view").classList.remove("hidden");
      if(e.status===401){text("login-err","")}else{text("login-err",e.message)}
    }
  }

  $("login").addEventListener("click",async function(){
    text("login-err","");
    try{
      await api("/bridge/console/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:$("token").value.trim()})});
      $("token").value="";await load();
    }catch(e){text("login-err",e.message)}
  });
  $("probe").addEventListener("click",async function(){
    try{var s=await api("/bridge/console/session");text("login-err","home relay credentials: ax "+(s.relay.ax?"yes":"no")+", buff "+(s.relay.buff?"yes":"no"))}
    catch(e){text("login-err",e.message)}
  });
  $("refresh").addEventListener("click",load);
  $("buff-refresh").addEventListener("click",load);
  $("phone-refresh").addEventListener("click",load);
  function clearPairingCode(){
    $("pair-code").classList.add("hidden");
    text("pair-value","");
    text("pair-meta","");
  }
  $("pair-clear").addEventListener("click",clearPairingCode);
  $("pair-create").addEventListener("click",async function(){
    text("pair-err","");clearPairingCode();
    var button=$("pair-create");button.disabled=true;button.textContent="GENERATING…";
    try{
      var r=await api("/bridge/console/pairing",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId:$("pair-device").value.trim()})});
      text("pair-value",r.pairing.code);
      text("pair-meta","single-use · expires "+when(new Date(r.pairing.expiresAt).toISOString())+(r.pairing.deviceId?" · bound to "+r.pairing.deviceId:" · binds to the first phone that uses it"));
      $("pair-code").classList.remove("hidden");
    }catch(e){text("pair-err",e.message)}
    finally{button.disabled=false;button.textContent="GENERATE PAIRING CODE"}
  });
  $("logout").addEventListener("click",async function(ev){ev.preventDefault();clearPairingCode();try{await api("/bridge/console/logout",{method:"POST"})}catch(e){};location.reload()});

  $("submit-task").addEventListener("click",async function(){
    text("task-err","");
    var t=$("task-text").value.trim();if(!t){text("task-err","describe the task first");return}
    try{var r=await api("/bridge/console/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:t,title:$("task-title").value.trim()})});
      $("task-text").value="";$("task-title").value="";text("task-err","queued "+String(r.taskId).slice(0,8));await load();
    }catch(e){text("task-err",e.message)}
  });
  $("claim").addEventListener("click",async function(){
    try{await api("/bridge/console/claim",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:((state.data&&state.data.buff&&state.data.buff.queue)||[]).map(function(t){return t.id})})});await load()}
    catch(e){text("buff-status",e.message)}
  });
  $("send-cmd").addEventListener("click",async function(){
    text("cmd-err","");
    try{var r=await api("/bridge/console/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:$("cmd-action").value,arg:$("cmd-arg").value.trim()})});
      $("cmd-arg").value="";text("cmd-err","queued "+String(r.id).slice(0,8)+" — the phone executes it only while the launcher is on screen");await load();
    }catch(e){text("cmd-err",e.message)}
  });

  load();
})();
</script>
</body>
</html>`;
}
