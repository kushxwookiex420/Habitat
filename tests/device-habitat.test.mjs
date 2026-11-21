import test from "node:test";
import assert from "node:assert/strict";
import { registerDeviceHabitat } from "../device-habitat.mjs";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
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

const AX = "hb_ax_" + "1".repeat(48);
const BUFF = "hb_buff_" + "2".repeat(48);
const DEVICE_TOKEN = "device-token-abc";
const DEVICE_ID = "launcher-test";

function relayStub(calls, { failFiles = false } = {}) {
  const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  return async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, auth: String(options.headers?.authorization || "") });
    if (parsed.hostname === "api.github.com") {
      return { ok: true, status: 200, json: async () => [
        { sha: "bb51e971c59abe171889d1d7679cdfb9bcca62e9", commit: { message: "buff: relay tests", author: { name: "buff", date: "2026-11-21T02:40:00Z" } } }
      ] };
    }
    if (parsed.pathname === "/health") return json({ ok: true, db: true });
    if (parsed.pathname === "/state") return json({ ok: true, name: "home-launcher", online: false, lastSeen: 1795224629485, commands: [
      { id: "c1", action: "status", arg: "", status: "done", output: "BATT 92", iso: "2026-11-20T20:30:29Z" },
      { id: "c2", action: "torch", arg: "on", status: "queued", output: null, iso: "2026-11-20T20:31:00Z" }
    ] });
    if (parsed.pathname === "/tasks") return json({ ok: true, count: 2, tasks: [
      { id: "t1", text: "ship it", title: "ship", status: "done", iso: "2026-11-21T02:00:00Z", artifacts: ["https://files.catbox.moe/x.apk"] },
      { id: "t2", text: "rotate keys", title: "keys", status: "working", iso: "2026-11-21T02:10:00Z" }
    ] });
    if (parsed.pathname === "/replies") return json({ ok: true, count: 1, serverTime: 1, replies: [
      { id: "r1", taskId: "t1", text: "done, apk attached", artifacts: ["https://files.catbox.moe/x.apk"], iso: "2026-11-21T02:05:00Z" }
    ] });
    if (parsed.pathname === "/notes") return json({ ok: true, count: 1, tasks: [{ id: "t2", text: "rotate keys", status: "queued", iso: "2026-11-21T02:10:00Z" }] });
    if (parsed.pathname === "/files") {
      if (failFiles) return json({ ok: false, error: "relay exploded" }, 500);
      return json({ ok: true, count: 1, files: [{ name: "reports/x.md", size: 12, encoding: "text", iso: "2026-11-21T02:00:00Z" }] });
    }
    if (parsed.pathname === "/file") return json({ ok: true, name: parsed.searchParams.get("name"), encoding: "text", size: 9, data: "# report" });
    if (parsed.pathname === "/send") return json({ ok: true, id: "cmd1", action: "torch" });
    return json({ ok: false, error: "unexpected " + parsed.pathname }, 404);
  };
}

function setup(options = {}) {
  const app = makeApp();
  const calls = [];
  const verified = { token: DEVICE_TOKEN, deviceId: DEVICE_ID };
  const repository = {
    async verifyDeviceToken(token, deviceId) {
      return token === verified.token && deviceId === verified.deviceId;
    }
  };
  const env = {
    HOME_BRIDGE_URL: "https://relay.test",
    HOME_BRIDGE_AX_TOKEN: AX,
    HOME_BRIDGE_BUFF_TOKEN: BUFF,
    HABITAT_GITHUB_REPO: "kushxwookiex420/home-launcher"
  };
  registerDeviceHabitat(app, { env, fetchImpl: relayStub(calls, options), repository });
  return { app, calls, env };
}

// The endpoint reads Authorization from headers, exactly like the launcher does.
const auth = {
  headers: { authorization: "Bearer " + DEVICE_TOKEN },
  query: { deviceId: DEVICE_ID }
};
const withAuth = (extra = {}) => ({
  headers: { ...auth.headers, ...(extra.headers || {}) },
  query: { ...auth.query, ...(extra.query || {}) },
  body: extra.body || {}
});

test("the dashboard requires a paired device token", async () => {
  const { app } = setup();
  const anonymous = await invoke(app, "GET /device/habitat", {});
  assert.equal(anonymous.statusCode, 401);
  const wrongToken = await invoke(app, "GET /device/habitat", withAuth({ headers: { authorization: "Bearer nope" } }));
  assert.equal(wrongToken.statusCode, 401);
  const wrongDevice = await invoke(app, "GET /device/habitat", withAuth({ query: { deviceId: "other" } }));
  assert.equal(wrongDevice.statusCode, 401);
});

test("an unconfigured device store answers 503 instead of faking data", async () => {
  const app = makeApp();
  registerDeviceHabitat(app, { env: {}, fetchImpl: async () => { throw new Error("no"); } });
  const res = await invoke(app, "GET /device/habitat", {});
  assert.equal(res.statusCode, 503);
});

test("the payload reports relay state, tasks, replies and phone commands", async () => {
  const { app } = setup();
  const res = await invoke(app, "GET /device/habitat", auth);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const body = res.body;
  assert.equal(body.relay.health, "ok");
  assert.deepEqual(body.ax.counts, { queued: 0, working: 1, done: 1 });
  assert.equal(body.ax.tasks[0].artifacts.length, 1);
  assert.equal(body.buff.queue.length, 1);
  assert.equal(body.buff.replies[0].taskId, "t1");
  assert.equal(body.phone.online, false);
  assert.equal(body.phone.commands[0].status, "done");
  assert.equal(body.phone.commands[1].status, "queued");
  assert.equal(body.files.count, 1);
  assert.equal(body.cloud.github.commits[0].short, "bb51e97");
  assert.equal(body.workers.items.find((w) => w.name.startsWith("PHONE")).state, "idle");
  assert.equal(body.errors.length, 0);
});

test("business data is refused rather than invented", async () => {
  const { app } = setup();
  const body = (await invoke(app, "GET /device/habitat", auth)).body;
  assert.equal(body.business.available, false);
  assert.ok(body.business.reason.length > 20);
  assert.equal(body.business.dropPilot, null);
  assert.equal(body.business.viceCity, null);
});

test("the relay token never reaches the device payload", async () => {
  const { app } = setup();
  const serialized = JSON.stringify((await invoke(app, "GET /device/habitat", auth)).body);
  assert.equal(serialized.includes(AX), false);
  assert.equal(serialized.includes(BUFF), false);
  assert.equal(serialized.includes(DEVICE_TOKEN), false);
});

test("relay calls use the server-held role credentials", async () => {
  const { app, calls } = setup();
  await invoke(app, "GET /device/habitat", auth);
  assert.match(calls.find((c) => c.path === "/tasks").auth, /^Bearer hb_ax_/);
  assert.match(calls.find((c) => c.path === "/notes").auth, /^Bearer hb_buff_/);
  assert.match(calls.find((c) => c.path === "/state").auth, /^Bearer hb_ax_/);
});

test("a failing relay source is reported, not hidden", async () => {
  const { app } = setup({ failFiles: true });
  const body = (await invoke(app, "GET /device/habitat", auth)).body;
  assert.equal(body.files.ok, false);
  assert.equal(body.files.count, 0);
  assert.ok(body.errors.some((e) => e.source === "files"));
});

test("phone actions are allowlisted and sent with the ax credential", async () => {
  const { app, calls } = setup();
  const bad = await invoke(app, "POST /device/habitat/phone", {
    ...auth, body: { deviceId: DEVICE_ID, action: "shell", arg: "id" }
  });
  assert.equal(bad.statusCode, 400);
  const good = await invoke(app, "POST /device/habitat/phone", withAuth({
    body: { deviceId: DEVICE_ID, action: "torch", arg: "on" }
  }));
  assert.equal(good.statusCode, 200);
  assert.equal(good.body.action, "torch");
  assert.match(calls.find((c) => c.path === "/send").auth, /^Bearer hb_ax_/);
});

test("phone actions need the device token too", async () => {
  const { app } = setup();
  const res = await invoke(app, "POST /device/habitat/phone", { body: { deviceId: DEVICE_ID, action: "status" } });
  assert.equal(res.statusCode, 401);
});

test("reading one file needs a name and the device token", async () => {
  const { app } = setup();
  const missing = await invoke(app, "GET /device/habitat/file", withAuth());
  assert.equal(missing.statusCode, 400);
  const ok = await invoke(app, "GET /device/habitat/file", withAuth({ query: { name: "reports/x.md" } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data, "# report");
});
