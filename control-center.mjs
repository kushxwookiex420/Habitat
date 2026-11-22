/**
 * Habitat control center — the operational surface for Ax and NEXUS.
 *
 * It is served by the same Node process as the API, so it needs no build step, no framework and no
 * CDN. It is mobile-first because the owner uses a phone, and it renders a real 3D neural brain with
 * WebGL (point-cloud hemispheres, connectome edges, travelling pulses) rather than a decorative
 * sphere.
 *
 * The page itself is public and contains no data. Every operational value is fetched from the
 * authenticated API with the Ax command token the owner enters, which is kept in `sessionStorage`
 * only — never in the HTML, a cookie, a URL or localStorage. A missing token, a 401, a 503 and a
 * network failure are all shown as themselves, so an unconfigured deployment can never look healthy.
 */

export const CONTROL_CENTER_PATH = "/control";

const STYLES = `
:root{color-scheme:dark;--bg:#04070e;--panel:rgba(10,20,32,.82);--panel2:rgba(13,26,41,.92);--line:rgba(67,227,208,.22);--teal:#43e3d0;--teal2:#8ff6ea;--violet:#9d7bff;--text:#e9f7f8;--muted:#9fb6c4;--warn:#ffc861;--bad:#ff7a85;--good:#57e39b}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding-bottom:calc(150px + env(safe-area-inset-bottom))}
#brain{position:fixed;inset:0;width:100%;height:100%;z-index:0;opacity:.92;pointer-events:none}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(120% 80% at 50% 0%,rgba(24,58,74,.5) 0,transparent 60%),radial-gradient(80% 60% at 100% 100%,rgba(80,50,140,.28) 0,transparent 70%)}
header,main{position:relative;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:calc(14px + env(safe-area-inset-top)) 16px 12px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.14em;font-size:13px}
.mark{width:34px;height:34px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(150deg,var(--teal),#3a6fd0);color:#04121a;font-weight:900;box-shadow:0 0 22px rgba(67,227,208,.45)}
.chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:rgba(6,16,24,.75);border-radius:999px;padding:7px 11px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);box-shadow:0 0 10px currentColor}
.dot.ok{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
main{padding:0 16px 24px;max-width:760px;margin:0 auto}
h1{font-size:19px;letter-spacing:.02em;margin:6px 0 2px}
.sub{color:var(--muted);font-size:13.5px;margin:0 0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;margin-bottom:12px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 18px 50px rgba(0,0,0,.35)}
.card h2{font-size:15px;margin:0 0 10px;letter-spacing:.06em;text-transform:uppercase;color:var(--teal2)}
.row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:14.5px}
.row:last-child{border-bottom:0}
.row .k{color:var(--muted)}
.row .v{text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.muted{color:var(--muted)}
.small{font-size:12.5px}
.big{font-size:26px;font-weight:800;letter-spacing:-.02em}
.pill{display:inline-block;border-radius:999px;padding:3px 9px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--line);color:var(--teal2)}
.pill.good{color:var(--good);border-color:rgba(87,227,155,.4)}
.pill.warn{color:var(--warn);border-color:rgba(255,200,97,.4)}
.pill.bad{color:var(--bad);border-color:rgba(255,122,133,.4)}
button{font:inherit}
.btn{appearance:none;border:1px solid var(--line);background:linear-gradient(160deg,rgba(67,227,208,.16),rgba(67,227,208,.05));color:var(--text);border-radius:12px;padding:12px 15px;font-weight:700;min-height:46px;cursor:pointer}
.btn.primary{background:linear-gradient(160deg,var(--teal),#2fb7c9);color:#03141b;border-color:transparent}
.btn.ghost{background:transparent}
.btn.danger{background:rgba(255,122,133,.12);border-color:rgba(255,122,133,.4);color:#ffd9dd}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
label{display:block;font-size:12.5px;color:var(--muted);margin:10px 0 5px;letter-spacing:.04em;text-transform:uppercase}
input,textarea,select{width:100%;background:rgba(4,10,17,.85);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:12px 13px;font-size:16px;min-height:46px}
textarea{min-height:96px;resize:vertical}
.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}
.list{display:grid;gap:9px}
.item{border:1px solid rgba(255,255,255,.08);background:var(--panel2);border-radius:13px;padding:12px}
.item .top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.item p{margin:6px 0 0;font-size:13.5px;color:var(--muted);overflow-wrap:anywhere}
.item ul{margin:8px 0 0;padding-left:18px;font-size:13px;color:var(--muted)}
.empty{border:1px dashed rgba(255,255,255,.16);border-radius:13px;padding:16px;color:var(--muted);font-size:13.5px;text-align:center}
.error{border:1px solid rgba(255,122,133,.35);background:rgba(255,122,133,.08);border-radius:13px;padding:13px;font-size:13.5px;color:#ffd9dd}
.line{height:1px;background:rgba(255,255,255,.08);margin:12px 0}
details summary{cursor:pointer;color:var(--teal2);font-size:13.5px;padding:6px 0}
nav{position:fixed;left:0;right:0;bottom:0;z-index:5;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:auto;gap:2px;background:rgba(5,11,18,.96);border-top:1px solid var(--line);padding:7px 6px calc(7px + env(safe-area-inset-bottom));backdrop-filter:blur(18px)}
nav button{appearance:none;background:transparent;border:0;color:var(--muted);padding:5px 2px;border-radius:11px;font-size:11.5px;font-weight:700;letter-spacing:.02em;min-height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer}
nav button[aria-selected="true"]{color:var(--teal2);background:rgba(67,227,208,.1)}
nav svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
#gate{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:20px;background:rgba(3,7,12,.88);backdrop-filter:blur(8px)}
#gate .sheet{width:min(420px,100%);background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
#gate.hidden{display:none}
#toast{position:fixed;left:16px;right:16px;bottom:calc(158px + env(safe-area-inset-bottom));z-index:30;background:rgba(10,25,36,.96);border:1px solid var(--line);border-radius:13px;padding:12px 14px;font-size:13.5px;color:var(--text);transform:translateY(140%);transition:transform .22s ease}
#toast.show{transform:none}
@media(min-width:720px){nav{grid-template-columns:repeat(7,1fr);max-width:760px;margin:0 auto;border-radius:18px 18px 0 0;border:1px solid var(--line)}body{padding-bottom:96px}}
@media(prefers-reduced-motion:reduce){#brain{opacity:.35}}
`;

const ICONS = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  workers: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.4 3.1-5.4 7-5.4s7 2 7 5.4"/>',
  tasks: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  memory: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  approvals: '<path d="M5 13l4 4 10-11"/>',
  missions: '<path d="M4 19V5m0 14h16M8 15V9m4 6V7m4 8v-4"/>',
  health: '<path d="M3 12h4l2-5 3 10 2-5h7"/>'
};

function navButton(key, label) {
  return (
    '<button type="button" role="tab" data-tab="' + key + '" aria-selected="false" aria-controls="panel">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[key] + "</svg><span>" + label + "</span></button>"
  );
}

export function renderControlCenter({ version = "unknown" } = {}) {
  return (
    "<!doctype html><html lang=\"en\"><head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#04070e">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<meta name="description" content="Habitat Ax control center: live workers, tasks, memory, approvals, mission history and system health.">' +
    "<title>Habitat Ax · Control Center</title>" +
    "<style>" + STYLES + "</style></head><body>" +
    '<canvas id="brain" aria-hidden="true"></canvas>' +
    "<header><div class=\"brand\"><span class=\"mark\">H</span><span>HABITAT · NEXUS</span></div>" +
    '<span class="chip" id="conn"><span class="dot" id="conn-dot"></span><span id="conn-text">Not connected</span></span></header>' +
    '<main><h1>Control center</h1><p class="sub" id="panel-sub">Live operational state. Nothing here is simulated.</p><div id="panel" role="tabpanel"></div></main>' +
    '<nav role="tablist" aria-label="Control center sections">' +
    navButton("chat", "Chat") + navButton("workers", "Workers") + navButton("tasks", "Tasks") + navButton("memory", "Memory") +
    navButton("approvals", "Approvals") + navButton("missions", "Missions") + navButton("health", "Health") +
    "</nav>" +
    '<div id="gate"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="gate-title">' +
    '<h2 id="gate-title" style="margin:0 0 6px;font-size:18px">Connect to Ax</h2>' +
    '<p class="small muted" style="margin:0 0 6px">Enter the Ax command token for this service. It is kept in this tab\'s session memory only and is never written into the page.</p>' +
    '<label for="token">Ax command token</label><input id="token" type="password" autocomplete="off" spellcheck="false">' +
    '<p class="small muted" id="gate-error" style="color:#ffd9dd;min-height:18px;margin:8px 0 0"></p>' +
    '<div class="actions"><button class="btn primary" id="gate-connect" type="button">Connect</button>' +
    '<button class="btn ghost" id="gate-demo" type="button">View health without a token</button></div>' +
    '<p class="small muted" style="margin:12px 0 0">Version ' + String(version).replace(/[^0-9A-Za-z._-]/g, "") + "</p>" +
    "</div></div>" +
    '<div id="toast" role="status" aria-live="polite"></div>' +
    '<script src="/control/app.js"></script></body></html>'
  );
}

/**
 * The browser application. Written as a real function so `node --check` validates it, then shipped
 * with `.toString()`. It must not reference anything Node-only.
 */
function clientApp() {
  "use strict";
  const TOKEN_KEY = "habitat.ax.token";
  const OWNER_ID_KEY = "habitat.owner.id";
  const OWNER_TOKEN_KEY = "habitat.owner.token";
  const TABS = ["chat", "workers", "tasks", "memory", "approvals", "missions", "health"];
  const state = { tab: "chat", timer: null, busy: false };

  const $ = id => document.getElementById(id);
  const panel = $("panel");
  const toast = $("toast");

  function token() { return sessionStorage.getItem(TOKEN_KEY) || ""; }
  function ownerCreds() {
    return { id: sessionStorage.getItem(OWNER_ID_KEY) || "", token: sessionStorage.getItem(OWNER_TOKEN_KEY) || "" };
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key === "html") node.innerHTML = value; // only ever used with constants from this file
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
    return node;
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove("show"), 3600);
  }

  async function api(path, options) {
    const opts = options || {};
    if (!token()) {
      const error = new Error("This tab is not connected to Ax.");
      error.code = "locked";
      throw error;
    }
    const response = await fetch(path, {
      method: opts.method || "GET",
      headers: Object.assign({ authorization: "Bearer " + token(), "content-type": "application/json" }, opts.headers || {}),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: "no-store"
    });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || ("HTTP " + response.status));
      error.code = data.code || ("http_" + response.status);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function ownerApi(path, options) {
    const creds = ownerCreds();
    if (!creds.id || !creds.token) {
      const error = new Error("Owner device id and token are required for this action.");
      error.code = "owner_required";
      throw error;
    }
    return api(path, Object.assign({}, options, {
      headers: Object.assign({ "x-owner-device-id": creds.id, "x-owner-device-token": creds.token }, (options && options.headers) || {})
    }));
  }

  function setConnection(kind, text) {
    $("conn-dot").className = "dot " + kind;
    $("conn-text").textContent = text;
  }

  function statusClass(value) {
    const text = String(value || "").toLowerCase();
    if (["ok", "ready", "reachable", "available", "completed", "verified", "delivered", "true", "running"].includes(text)) return "good";
    if (["pending", "recorded", "needs_approval", "warn", "unchecked", "not_checked", "partial"].includes(text)) return "warn";
    if (["failed", "error", "unreachable", "unavailable", "not_configured", "denied", "expired"].includes(text)) return "bad";
    return "";
  }

  function errorCard(error) {
    const code = error && error.code ? error.code : "request_failed";
    const message = error && error.message ? error.message : "The request could not be completed.";
    if (code === "locked" || (error && error.status === 401 && code === "invalid_token")) {
      return el("div", { class: "card" },
        el("h2", { text: "Locked" }),
        el("p", { class: "muted", text: "This tab has no Ax command token, or the token was refused. Reconnect to continue." }),
        el("div", { class: "actions" }, el("button", { class: "btn primary", type: "button", text: "Reconnect", onclick: showGate })));
    }
    if (code === "owner_required") {
      return el("div", { class: "error", text: "This action needs the owner device credential. Open Memory → Owner controls and add the paired device id and token." });
    }
    return el("div", { class: "error" },
      el("strong", { text: code }),
      el("div", { text: message }),
      el("p", { class: "small muted", style: "margin:8px 0 0", text: "Nothing is being shown as healthy while this read is failing." }));
  }

  function loading(label) {
    return el("div", { class: "empty", text: label || "Reading live state…" });
  }

  function row(label, value, cls) {
    return el("div", { class: "row" }, el("span", { class: "k", text: label }), el("span", { class: "v " + (cls || ""), text: value }));
  }

  function pill(text) {
    return el("span", { class: "pill " + statusClass(text), text: String(text) });
  }

  async function render() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    panel.replaceChildren(loading());
    const sub = $("panel-sub");
    const labels = {
      chat: "Command Ax, then follow the run it creates.",
      workers: "The NEXUS executor, its heartbeat and its queue.",
      tasks: "Every command task, read from durable storage.",
      memory: "Approved memory with provenance, confidence and history.",
      approvals: "Owner-gated actions waiting for authorization.",
      missions: "Reconstructed from durable run records and notifications.",
      health: "Probe results, provider configuration and subsystem status."
    };
    sub.textContent = labels[state.tab] || "";
    try {
      await renderers[state.tab]();
      setConnection(token() ? "ok" : "warn", token() ? "Connected" : "Read-only");
    } catch (error) {
      panel.replaceChildren(errorCard(error));
      setConnection("bad", error && error.status === 401 ? "Token refused" : "Degraded");
    }
    const periodic = state.tab !== "chat" && state.tab !== "memory";
    if (periodic && token()) state.timer = setInterval(() => { if (!state.busy) render(); }, 15000);
  }

  async function renderChat() {
    const form = el("form", { class: "card" },
      el("h2", { text: "Command Ax" }),
      el("label", { for: "objective", text: "Objective" }),
      el("textarea", { id: "objective", placeholder: "Describe the outcome. Ax plans it, NEXUS executes it, evidence decides success.", maxlength: "2000", required: "required" }),
      el("div", { class: "actions" },
        el("button", { class: "btn primary", type: "submit", text: "Plan and run" }),
        el("button", { class: "btn ghost", type: "button", text: "Refresh runs", onclick: () => refreshRuns() })));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const objective = form.querySelector("#objective").value.trim();
      if (!objective) return;
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      button.textContent = "Planning…";
      try {
        const data = await api("/ax/command/runs", { method: "POST", body: { objective: objective } });
        notify("Run " + data.run.id + ": " + data.run.status);
        render();
      } catch (error) {
        panel.replaceChildren(form, errorCard(error));
      } finally {
        button.disabled = false;
        button.textContent = "Plan and run";
      }
    });
    panel.replaceChildren(form);
    const runsCard = el("div", { class: "card" }, el("h2", { text: "Recent runs" }), loading());
    panel.appendChild(runsCard);
    await refreshRuns(runsCard);
  }

  async function refreshRuns(card) {
    const target = card || panel.querySelector(".card:last-child");
    if (!target) return;
    try {
      const data = await api("/ax/command/runs?limit=8");
      target.replaceChildren(el("h2", { text: "Recent runs" }), missionList(data.runs || [], true));
    } catch (error) {
      target.replaceChildren(el("h2", { text: "Recent runs" }), errorCard(error));
    }
  }

  function missionList(runs, compact) {
    if (!runs.length) return el("div", { class: "empty", text: "No runs recorded yet. A run is created only when you command Ax." });
    const list = el("div", { class: "list" });
    for (const run of runs) {
      const head = el("div", { class: "top" },
        el("strong", { class: "mono", text: run.id }),
        pill(run.status || "unknown"));
      const item = el("div", { class: "item" }, head, el("p", { text: run.objective || "" }));
      const facts = [];
      if (run.verified) facts.push("verified");
      if (run.costUsd !== undefined) facts.push("cost $" + Number(run.costUsd || 0).toFixed(4));
      if (run.model) facts.push(run.model);
      if (run.memory && run.memory.recalled) facts.push(run.memory.recalled + " memories");
      if (run.recoveries) facts.push(run.recoveries + " recoveries");
      if (facts.length) item.appendChild(el("p", { class: "small muted", text: facts.join(" · ") }));
      if (!compact && Array.isArray(run.steps) && run.steps.length) {
        const steps = el("ul");
        for (const step of run.steps) {
          steps.appendChild(el("li", { text: (step.adapter || "step " + step.index) + " — " + step.status + (step.verified ? " ✓ verified" : "") }));
        }
        item.appendChild(steps);
      }
      if (!compact && run.error) item.appendChild(el("p", { class: "small", text: run.error }));
      list.appendChild(item);
    }
    return list;
  }

  async function renderWorkers() {
    const data = await api("/ax/command/presence");
    const presence = data.presence || {};
    panel.replaceChildren(
      el("div", { class: "card" },
        el("h2", { text: "Executor" }),
        row("Reachable", presence.reachable ? "yes" : "no", presence.reachable ? "good" : "bad"),
        row("Configured", presence.executor && presence.executor.configured ? "yes" : "no"),
        row("Started", presence.executor && presence.executor.started ? "yes" : "no"),
        row("State", (presence.executor && presence.executor.state) || "unknown", statusClass(presence.executor && presence.executor.state)),
        row("Why not running", (presence.executor && presence.executor.reason) || "—"),
        row("Can execute", presence.canExecute ? "yes" : "no", presence.canExecute ? "good" : "warn")),
      el("div", { class: "card" },
        el("h2", { text: "Heartbeat" }),
        row("Verified", presence.heartbeat && presence.heartbeat.verified ? "yes" : "no", presence.heartbeat && presence.heartbeat.verified ? "good" : "bad"),
        row("Live workers", String((presence.heartbeat && presence.heartbeat.liveWorkers) || 0)),
        row("Last heartbeat", presence.heartbeat && presence.heartbeat.lastHeartbeatAgeSeconds !== null ? Number(presence.heartbeat.lastHeartbeatAgeSeconds).toFixed(1) + "s ago" : "none"),
        row("Asleep", presence.heartbeat && presence.heartbeat.asleep ? "yes" : "no")),
      el("div", { class: "card" },
        el("h2", { text: "Queue" }),
        presence.queue && presence.queue.ok
          ? el("div", {}, row("Waiting", String(presence.queue.waiting ?? "0")), row("Claimed", String(presence.queue.claimed ?? "0")), row("Stale", String(presence.queue.stale ?? "0")))
          : el("div", { class: "error", text: "Queue unavailable: " + ((presence.queue && presence.queue.error) || "no report") })),
      el("p", { class: "small muted", text: "Observed " + (presence.observedAt || "unknown") + ". A worker is listed only if the backend reported it." }));
  }

  async function renderTasks() {
    const data = await api("/ax/command/tasks?limit=50");
    const tasks = data.tasks || [];
    const groups = new Map();
    for (const task of tasks) {
      const status = task.status || "unknown";
      if (!groups.has(status)) groups.set(status, []);
      groups.get(status).push(task);
    }
    if (!tasks.length) {
      panel.replaceChildren(el("div", { class: "card" }, el("h2", { text: "Tasks" }), el("div", { class: "empty", text: "No command tasks exist. Ax creates one only when it delegates work." })));
      return;
    }
    const cards = [el("div", { class: "card" }, el("h2", { text: "Summary" }), row("Total", String(tasks.length)), row("Count", String(data.count ?? tasks.length)))];
    for (const [status, items] of groups) {
      const card = el("div", { class: "card" }, el("h2", {}, "Tasks · ", pill(status)));
      const list = el("div", { class: "list" });
      for (const task of items) {
        const item = el("div", { class: "item" },
          el("div", { class: "top" }, el("strong", { class: "mono", text: task.id }), pill(task.status)),
          el("p", { text: task.objective || "" }));
        const meta = [];
        if (task.adapter) meta.push("adapter " + task.adapter);
        if (task.attempts) meta.push(task.attempts + " attempts");
        if (task.claimedBy) meta.push(task.claimedBy);
        if (meta.length) item.appendChild(el("p", { class: "small muted", text: meta.join(" · ") }));
        if (task.error) item.appendChild(el("p", { class: "small", text: task.error }));
        list.appendChild(item);
      }
      card.appendChild(list);
      cards.push(card);
    }
    panel.replaceChildren(...cards);
  }

  async function renderApprovals() {
    const tasks = await api("/ax/command/tasks?status=needs_approval&limit=50");
    const runs = await api("/ax/command/runs?limit=20");
    const waiting = (runs.runs || []).filter(run => run.status === "needs_approval");
    const card = el("div", { class: "card" }, el("h2", { text: "Task approvals" }));
    if (!(tasks.tasks || []).length) card.appendChild(el("div", { class: "empty", text: "No task is awaiting approval." }));
    else {
      const list = el("div", { class: "list" });
      for (const task of tasks.tasks) {
        const item = el("div", { class: "item" },
          el("div", { class: "top" }, el("strong", { class: "mono", text: task.id }), pill("needs_approval")),
          el("p", { text: task.objective || "" }));
        const reasons = (task.approvals || []).map(entry => entry.reason).filter(Boolean);
        if (reasons.length) item.appendChild(el("p", { class: "small muted", text: reasons[reasons.length - 1] }));
        const buttons = el("div", { class: "actions" },
          el("button", { class: "btn primary", type: "button", text: "Approve", onclick: () => decide("approve", task.id) }),
          el("button", { class: "btn danger", type: "button", text: "Deny", onclick: () => decide("deny", task.id) }));
        item.appendChild(buttons);
        list.appendChild(item);
      }
      card.appendChild(list);
    }
    const runCard = el("div", { class: "card" }, el("h2", { text: "Run approvals" }));
    runCard.appendChild(waiting.length ? missionList(waiting, false) : el("div", { class: "empty", text: "No run is waiting for approval." }));
    runCard.appendChild(el("p", { class: "small muted", text: "Ax cannot approve its own plan. Approval requires the paired owner device credential, kept in this tab only." }));
    panel.replaceChildren(card, runCard);
  }

  async function decide(kind, taskId) {
    try {
      await ownerApi("/ax/command/tasks/" + encodeURIComponent(taskId) + "/" + kind, { method: "POST", body: kind === "deny" ? { reason: "Denied by owner in control center" } : {} });
      notify("Task " + taskId + " " + (kind === "approve" ? "approved" : "denied"));
      render();
    } catch (error) {
      notify(error.code === "owner_required" ? "Owner credential required: Memory → Owner controls" : (error.code || "failed"));
      panel.replaceChildren(errorCard(error));
    }
  }

  async function renderMemory() {
    const stats = await api("/ax/command/memory/stats");
    const statCard = el("div", { class: "card" }, el("h2", { text: "Memory store" }),
      row("Active entries", String(stats.stats && stats.stats.active || 0)),
      row("Deleted entries", String(stats.stats && stats.stats.deleted || 0)),
      row("Kinds in use", String(Object.keys((stats.stats && stats.stats.byKind) || {}).length)));
    const search = el("form", { class: "card" },
      el("h2", { text: "Search" }),
      el("label", { for: "mem-q", text: "Statement, key or tag" }),
      el("input", { id: "mem-q", type: "search", placeholder: "e.g. task engine, deployment, preference" }),
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "submit", text: "Search approved memory" })));
    const results = el("div", { class: "card" }, el("h2", { text: "Results" }), el("div", { class: "empty", text: "Search to read approved entries. Imported claims are labelled as claims, never as facts." }));
    search.addEventListener("submit", async event => {
      event.preventDefault();
      const query = search.querySelector("#mem-q").value.trim();
      results.replaceChildren(el("h2", { text: "Results" }), loading("Searching…"));
      try {
        const data = await api("/ax/command/memory/search?q=" + encodeURIComponent(query) + "&limit=25");
        const entries = data.results || [];
        results.replaceChildren(el("h2", { text: "Results · " + entries.length }), entries.length
          ? el("div", { class: "list" }, ...entries.map(entry => {
              const item = el("div", { class: "item" },
                el("div", { class: "top" }, el("strong", { text: entry.key }), pill(entry.kind)),
                el("p", { text: entry.statement }));
              const prov = entry.provenance || {};
              item.appendChild(el("p", { class: "small muted", text: [prov.source, "confidence " + (entry.confidence === null || entry.confidence === undefined ? "n/a" : entry.confidence), "v" + entry.version].join(" · ") }));
              if (prov.ref) item.appendChild(el("p", { class: "small mono muted", text: prov.ref }));
              return item;
            }))
          : el("div", { class: "empty", text: "No active memory matched that query." }));
      } catch (error) {
        results.replaceChildren(el("h2", { text: "Results" }), errorCard(error));
      }
    });
    const owner = el("details", { class: "card" },
      el("summary", { text: "Owner controls" }),
      el("p", { class: "small muted", text: "Deletion and verified-fact writes require the paired owner device credential. It stays in this tab." }),
      el("label", { for: "owner-id", text: "Owner device id" }),
      el("input", { id: "owner-id", autocomplete: "off", value: ownerCreds().id }),
      el("label", { for: "owner-token", text: "Owner device token" }),
      el("input", { id: "owner-token", type: "password", autocomplete: "off", value: ownerCreds().token }),
      el("div", { class: "actions" }, el("button", { class: "btn", type: "button", text: "Save in this tab", onclick: () => {
        sessionStorage.setItem(OWNER_ID_KEY, $("owner-id").value.trim());
        sessionStorage.setItem(OWNER_TOKEN_KEY, $("owner-token").value.trim());
        notify("Owner credential stored for this tab");
      } })));
    panel.replaceChildren(statCard, search, results, owner);
  }

  async function renderMissions() {
    const data = await api("/ax/command/history?limit=20");
    const missions = data.missions || [];
    const summary = data.summary || {};
    const summaryCard = el("div", { class: "card" }, el("h2", { text: "Mission summary" }),
      row("Missions", String(summary.total || 0)),
      row("Verified", String(summary.verified || 0), summary.verified ? "good" : ""),
      row("Failed", String(summary.failed || 0), summary.failed ? "bad" : ""),
      row("Recovered", String(summary.recovered || 0)),
      row("Total cost", "$" + Number(summary.costUsd || 0).toFixed(4)));
    if (!missions.length) {
      panel.replaceChildren(summaryCard, el("div", { class: "card" }, el("div", { class: "empty", text: "No mission history is recorded yet." })));
      return;
    }
    const list = el("div", { class: "list" });
    for (const mission of missions) {
      const details = el("details", { class: "item" },
        el("summary", {}, mission.objective + " — " + mission.status),
        el("p", { class: "small mono muted", text: mission.runId }),
        el("p", { class: "small muted", text: "Plan: " + mission.plan.length + " step(s) · steps: " + mission.steps.length + " · evidence: " + mission.evidence.length + " · cost $" + Number(mission.costUsd || 0).toFixed(4) + (mission.memory.used ? " · memory " + mission.memory.recalled : "") + (mission.recoveries ? " · recoveries " + mission.recoveries : "") }));
      if (mission.memory.citations.length) {
        details.appendChild(el("p", { class: "small muted", text: "Memory used: " + mission.memory.citations.map(cite => cite.key + " (v" + cite.version + ", " + cite.source + ")").join(", ") }));
      }
      if (mission.steps.length) {
        const ul = el("ul");
        for (const step of mission.steps) ul.appendChild(el("li", { text: (step.adapter || "step " + step.index) + " — " + step.status + (step.verified ? " ✓" : "") }));
        details.appendChild(ul);
      }
      if (mission.error) details.appendChild(el("p", { class: "small", text: mission.error }));
      if (mission.notifications.length) details.appendChild(el("p", { class: "small muted", text: "Notifications: " + mission.notifications.map(fact => fact.type + "[" + fact.status + "]").join(", ") }));
      list.appendChild(details);
    }
    const notifications = await api("/ax/command/notifications?limit=20");
    const notificationCard = el("div", { class: "card" }, el("h2", { text: "Notifications" }));
    const notes = notifications.notifications || [];
    notificationCard.appendChild(notes.length
      ? el("div", { class: "list" }, ...notes.map(note => el("div", { class: "item" },
          el("div", { class: "top" }, el("strong", { text: note.title }), pill(note.status)),
          el("p", { text: note.body }),
          el("p", { class: "small muted", text: note.channel + " · " + note.type + " · " + note.createdAt + (note.attempts ? " · attempts " + note.attempts : "") }))))
      : el("div", { class: "empty", text: "No notifications recorded. In-app records are the only delivery channel; no push provider is configured." }));
    panel.replaceChildren(summaryCard, el("div", { class: "card" }, el("h2", { text: "Missions" }), list), notificationCard);
  }

  async function renderHealth() {
    const [diagnostics, providers] = await Promise.all([
      api("/ax/command/diagnostics"),
      api("/ax/command/providers").catch(error => ({ error: error }))
    ]);
    const d = diagnostics.diagnostics || {};
    const cards = [];
    cards.push(el("div", { class: "card" }, el("h2", { text: "Build" }),
      row("Version", (d.application && d.application.version) || "unknown"),
      row("Commit", (d.application && d.application.commit) || "unknown"),
      row("Read at", d.generatedAt || "unknown")));
    const section = (title, value) => {
      const card = el("div", { class: "card" }, el("h2", { text: title }));
      const status = value && value.status ? value.status : (value && value.enabled !== undefined ? (value.enabled ? "enabled" : "disabled") : "unknown");
      card.appendChild(row("Status", status, statusClass(status)));
      for (const [key, item] of Object.entries(value || {})) {
        if (key === "status" || key === "detail" || item === null || typeof item === "object") continue;
        card.appendChild(row(key, String(item)));
      }
      if (value && value.detail && typeof value.detail === "object") {
        for (const [key, item] of Object.entries(value.detail)) {
          if (item === null || typeof item === "object") continue;
          card.appendChild(row(key, String(item)));
        }
      }
      if (value && value.detail && typeof value.detail === "string") card.appendChild(row("Detail", value.detail));
      if (value && value.health) card.appendChild(row("Health checked", value.health.checked ? "yes" : "no", value.health.checked ? "good" : "warn"));
      if (value && value.health && value.health.note) card.appendChild(el("p", { class: "small muted", text: value.health.note }));
      cards.push(card);
    };
    section("Database", d.database);
    section("Memory repository", d.memory);
    section("Providers", d.providers);
    const providerCard = el("div", { class: "card" }, el("h2", { text: "Provider configuration" }));
    if (providers.error) providerCard.appendChild(errorCard(providers.error));
    else {
      const status = providers.providers || {};
      providerCard.appendChild(row("Enabled", status.enabled ? "yes" : "no", status.enabled ? "good" : "warn"));
      if (status.code) providerCard.appendChild(row("Code", status.code));
      if (status.primary) providerCard.appendChild(row("Primary", status.primary.name + " · " + status.primary.model + (status.primary.configured ? " · configured" : " · no key")));
      for (const fallback of status.fallbacks || []) providerCard.appendChild(row("Fallback", fallback.name + " · " + fallback.model + (fallback.configured ? " · configured" : " · no key")));
      providerCard.appendChild(el("p", { class: "small muted", text: "Configured is not tested. This page makes no paid model call, so it cannot report an account as healthy." }));
    }
    cards.push(providerCard);
    section("Orchestrator", d.orchestrator);
    section("Scheduler", d.scheduler);
    section("Sandbox", d.sandbox);
    section("Notifications", d.notifications);
    section("Device bridge", d.deviceBridge);
    cards.push(el("p", { class: "small muted", text: "Secrets exposed: " + (d.secretsExposed ? "REPORTED" : "no") + ". Diagnostics report probe results, not configuration guesses." }));
    panel.replaceChildren(...cards);
  }

  const renderers = {
    chat: renderChat,
    workers: renderWorkers,
    tasks: renderTasks,
    memory: renderMemory,
    approvals: renderApprovals,
    missions: renderMissions,
    health: renderHealth
  };

  function showGate() {
    $("gate").classList.remove("hidden");
    setTimeout(() => $("token").focus(), 60);
  }

  function hideGate() { $("gate").classList.add("hidden"); }

  function selectTab(tab) {
    if (!TABS.includes(tab)) return;
    state.tab = tab;
    for (const button of document.querySelectorAll("nav button[data-tab]")) {
      button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false");
    }
    render();
  }

  $("gate-connect").addEventListener("click", () => {
    const value = $("token").value.trim();
    if (!value) {
      $("gate-error").textContent = "Enter the Ax command token.";
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, value);
    $("gate-error").textContent = "";
    hideGate();
    render();
  });
  $("gate-demo").addEventListener("click", () => {
    hideGate();
    state.tab = "health";
    for (const button of document.querySelectorAll("nav button[data-tab]")) {
      button.setAttribute("aria-selected", button.dataset.tab === "health" ? "true" : "false");
    }
    panel.replaceChildren(el("div", { class: "card" }, el("h2", { text: "No token" }),
      el("p", { class: "muted", text: "Operational data is authenticated. Without a token this page can only show that it is locked — it will not invent a status." }),
      el("div", { class: "actions" }, el("button", { class: "btn primary", type: "button", text: "Connect", onclick: showGate }))));
    setConnection("warn", "Locked");
  });
  for (const button of document.querySelectorAll("nav button[data-tab]")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  }
  $("conn").addEventListener("click", showGate);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.timer) { clearInterval(state.timer); state.timer = null; }
    else if (!document.hidden && token()) render();
  });

  selectTab("chat");
  if (!token()) showGate();
  startBrain();
}

/**
 * WebGL neural brain.
 *
 * Two densely sampled hemispheres with a central fissure, a cerebellum and a brainstem, joined by
 * short-range synapses. Points and edges are drawn from buffers generated once; the animation is a
 * single rotation uniform, so a phone GPU can render it continuously at low cost. If WebGL is
 * unavailable the canvas stays transparent and the page simply has no brain — it does not fake one.
 */
function startBrain() {
  "use strict";
  const canvas = document.getElementById("brain");
  if (!canvas) return;
  const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) return;

  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function mat4Identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + j] * b[i * 4 + k];
        out[i * 4 + j] = sum;
      }
    }
    return out;
  }
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f; out[10] = (far + near) / (near - far); out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }
  function rotationY(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
  }
  function rotationX(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
  }
  function translation(x, y, z) {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
  }

  // Deterministic pseudo-random so the brain looks the same on every visit.
  let seed = 20261122;
  function random() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  function gaussian() {
    const u = Math.max(1e-6, random());
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const positions = [];
  const sizes = [];
  const glows = [];

  function addNeuron(x, y, z, size) {
    positions.push(x, y, z);
    sizes.push(size);
    glows.push(random());
  }

  // Two hemispheres. Points sit on an ellipsoidal shell rather than filling the volume, so the
  // silhouette is a pair of lobes with a sagittal groove instead of a fuzzy sphere.
  const NEURONS = 2400;
  for (let i = 0; i < NEURONS; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const u = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - u * u);
    const shell = 0.82 + random() * 0.18;
    const x = side * (0.36 + 0.35 * ring * Math.cos(phi) * shell);
    const y = (0.06 + 0.37 * u * shell) * (1 + 0.02 * Math.sin(x * 9));
    const z = 0.52 * ring * Math.sin(phi) * shell;
    if (Math.abs(x) < 0.055) continue; // the longitudinal fissure
    addNeuron(x, y, z, 2.0 + random() * 2.8);
  }
  // Temporal lobes: a lower-lateral bulge on each side, which is what makes a point cloud read as
  // a brain rather than two eggs.
  for (let i = 0; i < 360; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const u = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const ring = Math.sqrt(1 - u * u);
    const shell = 0.8 + random() * 0.2;
    addNeuron(
      side * (0.44 + 0.13 * ring * Math.cos(phi) * shell),
      -0.13 + 0.12 * u * shell,
      0.08 + 0.27 * ring * Math.sin(phi) * shell,
      1.5 + random() * 1.9
    );
  }
  // Cerebellum: a smaller, denser mass below and behind the occipital lobes.
  for (let i = 0; i < 480; i++) {
    let x, y, z;
    do {
      x = gaussian() * 0.24;
      y = gaussian() * 0.13 - 0.4;
      z = gaussian() * 0.2 - 0.36;
    } while ((x * x) / 0.09 + (y * y) / 0.03 + (z * z) / 0.06 > 1);
    addNeuron(x, y, z, 1.6 + random() * 2.0);
  }
  // Brainstem: a tapering column from the centre down to the spinal cord.
  for (let i = 0; i < 200; i++) {
    const t = random();
    const radius = 0.075 * (1 - t * 0.55);
    const angle = random() * Math.PI * 2;
    addNeuron(Math.cos(angle) * radius, -0.32 - t * 0.42, -0.08 + Math.sin(angle) * radius, 1.5 + random() * 1.8);
  }

  // Synapses: connect each neuron to a nearby one, biased within a hemisphere.
  const edges = [];
  const pointCount = positions.length / 3;
  for (let i = 0; i < pointCount; i++) {
    const xi = positions[i * 3], yi = positions[i * 3 + 1], zi = positions[i * 3 + 2];
    for (let attempt = 0; attempt < 4; attempt++) {
      const j = Math.floor(random() * pointCount);
      if (j === i) continue;
      const dx = positions[j * 3] - xi, dy = positions[j * 3 + 1] - yi, dz = positions[j * 3 + 2] - zi;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < 0.14) {
        edges.push(xi, yi, zi, positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]);
        break;
      }
    }
  }

  const pointProgram = compile(
    "attribute vec3 aPos;attribute float aSize;attribute float aGlow;uniform mat4 uMatrix;uniform float uTime;uniform float uScale;varying float vGlow;" +
    "void main(){vec4 p=uMatrix*vec4(aPos,1.0);gl_Position=p;gl_PointSize=aSize*uScale*(1.0+0.3*sin(uTime*1.7+aGlow*6.283));vGlow=aGlow;}",
    "precision mediump float;varying float vGlow;void main(){vec2 c=gl_PointCoord-0.5;float d=length(c);if(d>0.5)discard;float a=smoothstep(0.5,0.0,d);gl_FragColor=vec4(mix(vec3(0.30,0.94,0.90),vec3(0.63,0.48,1.0),vGlow),a*0.8);}"
  );
  const lineProgram = compile(
    "attribute vec3 aPos;uniform mat4 uMatrix;void main(){gl_Position=uMatrix*vec4(aPos,1.0);}",
    "precision mediump float;void main(){gl_FragColor=vec4(0.42,0.88,1.0,0.55);}"
  );
  if (!pointProgram || !lineProgram) return;

  const pointBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  const sizeBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sizes), gl.STATIC_DRAW);
  const glowBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, glowBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(glows), gl.STATIC_DRAW);
  // A sparse wireframe over the same ellipsoids. Point clouds alone read as a nebula; the latitude
  // and longitude arcs are what make the two lobes, the cerebellum and the midline visible.
  const wire = [];
  function ellipsoidWire(cx, cy, cz, rx, ry, rz, { longitudes = 12, latitudes = 9, steps = 26 } = {}) {
    const point = (theta, phi) => [
      cx + rx * Math.sin(theta) * Math.cos(phi),
      cy + ry * Math.cos(theta),
      cz + rz * Math.sin(theta) * Math.sin(phi)
    ];
    for (let l = 0; l < longitudes; l += 1) {
      const phi = (l / longitudes) * Math.PI * 2;
      let previous = point(0.001, phi);
      for (let s = 1; s <= steps; s += 1) {
        const next = point((s / steps) * Math.PI, phi);
        wire.push(...previous, ...next);
        previous = next;
      }
    }
    for (let b = 1; b < latitudes; b += 1) {
      const theta = (b / latitudes) * Math.PI;
      let previous = point(theta, 0);
      for (let s = 1; s <= steps; s += 1) {
        const next = point(theta, (s / steps) * Math.PI * 2);
        wire.push(...previous, ...next);
        previous = next;
      }
    }
  }
  ellipsoidWire(-0.36, 0.06, 0, 0.35, 0.37, 0.52);
  ellipsoidWire(0.36, 0.06, 0, 0.35, 0.37, 0.52);
  ellipsoidWire(0, -0.4, -0.36, 0.24, 0.13, 0.2, { longitudes: 8, latitudes: 5, steps: 18 });

  const edgeBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edges), gl.STATIC_DRAW);
  const wireBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, wireBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wire), gl.STATIC_DRAW);

  function compile(vertexSource, fragmentSource) {
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertex, vertexSource);
    gl.compileShader(vertex);
    if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) return null;
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragment, fragmentSource);
    gl.compileShader(fragment);
    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener("resize", resize);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.clearColor(0, 0, 0, 0);

  const started = performance.now();
  function frame(now) {
    const time = (now - started) / 1000;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const aspect = canvas.width / Math.max(1, canvas.height);
    const angle = reduce ? 0.5 : time * 0.16;
    const matrix = multiply(
      perspective(0.9, aspect, 0.1, 10),
      multiply(translation(0, 0.02, -2.12), multiply(rotationX(-0.22), rotationY(angle + 0.22)))
    );

    gl.useProgram(lineProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProgram, "uMatrix"), false, matrix);
    const linePos = gl.getAttribLocation(lineProgram, "aPos");
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
    gl.enableVertexAttribArray(linePos);
    gl.vertexAttribPointer(linePos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, wireBuffer);
    gl.vertexAttribPointer(linePos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, wire.length / 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuffer);
    gl.vertexAttribPointer(linePos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, edges.length / 3);

    gl.useProgram(pointProgram);
    gl.uniformMatrix4fv(gl.getUniformLocation(pointProgram, "uMatrix"), false, matrix);
    gl.uniform1f(gl.getUniformLocation(pointProgram, "uTime"), time);
    // Point size is in device pixels, so scale it by the backing-store ratio to keep the neurons
    // the same apparent size on a high-density phone screen.
    gl.uniform1f(gl.getUniformLocation(pointProgram, "uScale"), Math.min(window.devicePixelRatio || 1, 2));
    const pos = gl.getAttribLocation(pointProgram, "aPos");
    gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 0, 0);
    const size = gl.getAttribLocation(pointProgram, "aSize");
    gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuffer);
    gl.enableVertexAttribArray(size);
    gl.vertexAttribPointer(size, 1, gl.FLOAT, false, 0, 0);
    const glow = gl.getAttribLocation(pointProgram, "aGlow");
    gl.bindBuffer(gl.ARRAY_BUFFER, glowBuffer);
    gl.enableVertexAttribArray(glow);
    gl.vertexAttribPointer(glow, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, pointCount);

    if (!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * Mount the page. `app` only needs Express' `get(path, handler)`.
 */
export function registerControlCenter(app, { version = "unknown" } = {}) {
  app.get(CONTROL_CENTER_PATH, (_req, res) => {
    res.type("html").send(renderControlCenter({ version }));
  });
  app.get(CONTROL_CENTER_PATH + "/app.js", (_req, res) => {
    res.type("application/javascript").send(clientSource());
  });
  return { path: CONTROL_CENTER_PATH };
}

/**
 * The browser script as text. Both functions are self-contained, so shipping their source keeps the
 * page dependency-free and still lets `node --check` validate the real code we serve.
 */
export function clientSource() {
  return "var startBrain = " + startBrain.toString() + ";\n(" + clientApp.toString() + ")();";
}
