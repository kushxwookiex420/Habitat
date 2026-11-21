import test from "node:test";
import assert from "node:assert/strict";
import { registerHomeBridgeConsole } from "../home-bridge-console.mjs";

// A route recorder that behaves like the small slice of Express this module uses.
function makeApp() {
  const routes = new Map();
  const app = {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
  return app;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    html: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    type(_t) { return this; },
    send(body) { this.html = body; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; }
  };
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "route exists: " + key);
  const res = responseRecorder();
  const request = { method: key.split(" ")[0], headers: {}, query: {}, body: {}, ...req };
  for (const handler of handlers) {
    if (handler.length >= 3) {
      let advanced = false;
      await handler(request, res, () => { advanced = true; });
      if (advanced) continue;
      return res;
    }
    await handler(request, res);
    return res;
  }
  return res;
}

const OPERATOR = "test-operator-token";

function relayStub(calls) {
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body)
  });
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const auth = String(options.headers?.authorization || "");
    calls.push({ path: parsed.pathname, method: options.method || "GET", auth, query: parsed.searchParams.toString() });
    if (parsed.hostname === "api.github.com") {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { sha: "4ceb2ad107fde75d53bc4f3cee38bbec074869c9", html_url: "https://github.com/x/y/commit/4ceb2ad", commit: { message: "buff: relay 1.3.0", author: { name: "buff", date: "2026-11-21T02:24:00Z" } } }
        ]
      };
    }
    if (parsed.pathname === "/health") return json({ ok: true, db: true });
    if (parsed.pathname === "/state") {
      return json({ ok: true, name: "phone", online: true, lastSeen: Date.now(), commands: [{ id: "c1", action: "status", arg: "", status: "done", output: "BATT 92%", createdAt: Date.now(), iso: new Date().toISOString() }] });
    }
    if (parsed.pathname === "/tasks") {
      return json({ ok: true, count: 2, tasks: [
        { id: "t1", text: "add stopwatch", title: "stopwatch", status: "done", source: "habitat-ax", createdAt: 1, iso: new Date().toISOString(), artifacts: ["https://files.catbox.moe/x.apk"] },
        { id: "t2", text: "rotate keys", title: "keys", status: "queued", createdAt: 2, iso: new Date().toISOString() }
      ] });
    }
    if (parsed.pathname === "/replies") {
      return json({ ok: true, count: 1, serverTime: Date.now(), replies: [{ id: "r1", taskId: "t1", source: "buff", text: "stopwatch shipped", artifacts: ["https://files.catbox.moe/x.apk"], createdAt: 3, iso: new Date().toISOString() }] });
    }
    if (parsed.pathname === "/files") return json({ ok: true, count: 1, files: [{ name: "reports/x.md", mime: "text/markdown", encoding: "text", size: 12, iso: new Date().toISOString() }] });
    if (parsed.pathname === "/file") return json({ ok: true, name: parsed.searchParams.get("name"), encoding: "text", size: 12, data: "# bridge" });
    if (parsed.pathname === "/notes") return json({ ok: true, count: 1, tasks: [{ id: "t2", text: "rotate keys", status: "queued", source: "habitat-ax", iso: new Date().toISOString() }] });
    if (parsed.pathname === "/notes/ack") return json({ ok: true, acknowledged: 1 });
    if (parsed.pathname === "/note") return json({ ok: true, taskId: "t3", createdAt: 4 });
    if (parsed.pathname === "/send") return json({ ok: true, id: "cmd1", action: "status" });
    if (parsed.pathname === "/tasks" && options.method === "POST") return json({ ok: true });
    return json({ ok: false, error: "unexpected path" }, 404);
  };
}

function setup() {
  const app = makeApp();
  const calls = [];
  const env = {
    HABITAT_AX_BRIDGE_TOKEN: OPERATOR,
    HOME_BRIDGE_AX_TOKEN: "hb_ax_" + "1".repeat(48),
    HOME_BRIDGE_BUFF_TOKEN: "hb_buff_" + "2".repeat(48),
    HOME_BRIDGE_URL: "https://relay.test",
    HABITAT_GITHUB_REPO: "kushxwookiex420/home-launcher"
  };
  registerHomeBridgeConsole(app, { env, fetchImpl: relayStub(calls) });
  return { app, calls, env };
}

const operator = { headers: { authorization: `Bearer ${OPERATOR}` } };

test("console routes require operator authentication", async () => {
  const { app } = setup();
  for (const route of [
    "GET /bridge/console/dashboard",
    "GET /bridge/console/tasks",
    "GET /bridge/console/replies",
    "GET /bridge/console/files",
    "POST /bridge/console/tasks",
    "POST /bridge/console/send"
  ]) {
    const res = await invoke(app, route, {});
    assert.equal(res.statusCode, 401, route + " must reject anonymous callers");
  }
});

test("a wrong operator token is rejected and no session cookie is issued", async () => {
  const { app } = setup();
  const res = await invoke(app, "POST /bridge/console/login", { body: { token: "wrong" } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("login issues an HttpOnly session cookie that unlocks the dashboard", async () => {
  const { app } = setup();
  const login = await invoke(app, "POST /bridge/console/login", { body: { token: OPERATOR } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const session = cookie.split(";")[0];
  const dashboard = await invoke(app, "GET /bridge/console/dashboard", { headers: { cookie: session } });
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.body.phone.online, true);
});

test("console login and mutations reject cross-origin browser requests", async () => {
  const { app } = setup();
  const blocked = await invoke(app, "POST /bridge/console/login", {
    headers: { origin: "https://evil.test", host: "bridge.test" },
    body: { token: OPERATOR }
  });
  assert.equal(blocked.statusCode, 403);
  const sameOrigin = await invoke(app, "POST /bridge/console/login", {
    headers: { origin: "https://bridge.test", host: "bridge.test" },
    body: { token: OPERATOR }
  });
  assert.equal(sameOrigin.statusCode, 200);

  const mutation = await invoke(app, "POST /bridge/console/send", {
    headers: { ...operator.headers, origin: "https://evil.test", host: "bridge.test" },
    body: { action: "status" }
  });
  assert.equal(mutation.statusCode, 403);
});

test("repeated wrong logins are rate limited", async () => {
  const { app } = setup();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await invoke(app, "POST /bridge/console/login", { body: { token: "wrong" } });
    assert.equal(res.statusCode, 401);
  }
  const limited = await invoke(app, "POST /bridge/console/login", { body: { token: OPERATOR } });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
});

test("logout invalidates the session", async () => {
  const { app } = setup();
  const login = await invoke(app, "POST /bridge/console/login", { body: { token: OPERATOR } });
  const session = login.headers["set-cookie"].split(";")[0];
  await invoke(app, "POST /bridge/console/logout", { headers: { cookie: session } });
  const dashboard = await invoke(app, "GET /bridge/console/dashboard", { headers: { cookie: session } });
  assert.equal(dashboard.statusCode, 401);
});

test("the dashboard aggregates ax, buff, phone, cloud and files", async () => {
  const { app } = setup();
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.equal(body.relay.health, "ok");
  assert.deepEqual(body.ax.counts, { queued: 1, working: 0, done: 1 });
  assert.equal(body.ax.tasks.length, 2);
  assert.equal(body.ax.replies[0].taskId, "t1");
  assert.equal(body.buff.queue[0].id, "t2");
  assert.equal(body.buff.artifacts[0], "https://files.catbox.moe/x.apk");
  assert.equal(body.phone.name, "phone");
  assert.equal(body.phone.commands[0].output, "BATT 92%");
  assert.equal(body.cloud.github.commits[0].short, "4ceb2ad");
  assert.equal(body.files.count, 1);
  assert.equal(body.errors.length, 0);
});

test("ax reads use the ax credential and buff reads use the buff credential", async () => {
  const { app, calls } = setup();
  await invoke(app, "GET /bridge/console/dashboard", operator);
  const tasks = calls.find((c) => c.path === "/tasks" && c.method === "GET");
  const queue = calls.find((c) => c.path === "/notes");
  assert.match(tasks.auth, /^Bearer hb_ax_/);
  assert.match(queue.auth, /^Bearer hb_buff_/);
  assert.equal(calls.some((c) => c.path === "/state" && !/hb_ax_/.test(c.auth)), false);
});

test("the operator token and relay credentials never appear in a response", async () => {
  const { app, env } = setup();
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes(OPERATOR), false);
  assert.equal(serialized.includes(env.HOME_BRIDGE_AX_TOKEN), false);
  assert.equal(serialized.includes(env.HOME_BRIDGE_BUFF_TOKEN), false);
});

test("task submission validates input and reports the relay failure", async () => {
  const { app } = setup();
  const empty = await invoke(app, "POST /bridge/console/tasks", { ...operator, body: { text: "" } });
  assert.equal(empty.statusCode, 400);

  const failing = makeApp();
  registerHomeBridgeConsole(failing, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR, HOME_BRIDGE_AX_TOKEN: "hb_ax_" + "1".repeat(48), HOME_BRIDGE_URL: "https://relay.test" },
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); }
  });
  const res = await invoke(failing, "POST /bridge/console/tasks", { ...operator, body: { text: "do a thing" } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.ok, false);
  assert.equal(JSON.stringify(res.body).includes("hb_ax_"), false);
});

test("a missing relay credential is reported instead of faked", async () => {
  const app = makeApp();
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("should not be called"); }
  });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.relay.credentials.ax, false);
  assert.ok(res.body.errors.length > 0);
});

test("phone actions are allowlisted and forwarded", async () => {
  const { app, calls } = setup();
  const bad = await invoke(app, "POST /bridge/console/send", { ...operator, body: { action: "shell", arg: "id" } });
  assert.equal(bad.statusCode, 400);
  const good = await invoke(app, "POST /bridge/console/send", { ...operator, body: { action: "torch", arg: "on" } });
  assert.equal(good.statusCode, 200);
  const send = calls.find((c) => c.path === "/send");
  assert.match(send.auth, /^Bearer hb_ax_/);
});

test("the console page contains no credentials", async () => {
  const { app } = setup();
  const res = await invoke(app, "GET /bridge/console", {});
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.html).includes(OPERATOR), false);
  assert.equal(String(res.html).includes("hb_ax_"), false);
  assert.match(String(res.html), /COMMAND CENTER/);
});

test("an unconfigured operator token disables the console", async () => {
  const app = makeApp();
  registerHomeBridgeConsole(app, { env: {}, fetchImpl: async () => { throw new Error("no"); } });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 503);
});
