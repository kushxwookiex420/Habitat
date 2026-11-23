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
  assert.match(cookie, /SameSite=Strict/);
  const session = cookie.split(";")[0];
  const dashboard = await invoke(app, "GET /bridge/console/dashboard", { headers: { cookie: session } });
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.body.phone.online, true);
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

test("AX Core reports the device bridge credential, not the legacy relay token", async () => {
  const app = makeApp();
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("should not be called"); },
    bridgeStatus: () => ({ ready: true, durable: true, axTokenConfigured: true, perDeviceTokens: true })
  });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  // the surface the phone depends on
  assert.equal(res.body.deviceBridge.available, true);
  assert.equal(res.body.deviceBridge.axTokenConfigured, true);
  assert.equal(res.body.deviceBridge.ready, true);
  // the legacy relay keeps its own, separately reported credential state
  assert.equal(res.body.relay.credentials.ax, false);
  assert.equal(res.body.relay.credentials.buff, false);
  assert.equal(res.body.relay.health, "unavailable");
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes(OPERATOR), false);
  assert.equal(serialized.includes("hb_ax_"), false);
});

test("a device bridge status probe that fails degrades to missing, never to present", async () => {
  const app = makeApp();
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("no"); },
    bridgeStatus: () => { throw new Error("store unavailable"); }
  });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deviceBridge.available, false);
  assert.equal(res.body.deviceBridge.axTokenConfigured, false);
});

test("the console page separates AX Core from the legacy home relay", async () => {
  const { app } = setup();
  const res = await invoke(app, "GET /bridge/console", {});
  const html = String(res.html);
  assert.match(html, /AX · CORE/);
  assert.match(html, /HOME RELAY/);
  assert.match(html, /device bridge ax credential/);
  assert.match(html, /home relay credentials/);
  assert.equal(html.includes("AX · brain"), false);
  assert.equal(html.includes("RELAY · home bridge"), false);
});

function registryStub(seenAt) {
  return {
    async listDevices() {
      return [{ device_id: "android-87ccece6", created_at: "2026-11-23T20:00:00.000Z", last_seen_at: seenAt, device_json: null, revoked_at: null }];
    }
  };
}

test("phone last check-in falls back to the durable registry when the relay is down", async () => {
  const seenAt = new Date().toISOString();
  const app = makeApp();
  // Same shape as production: the operator credential is set, the legacy relay roles are not.
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("relay unreachable"); },
    deviceRepository: registryStub(seenAt)
  });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.relay.health, "unavailable", "relay health stays separately reported");
  assert.equal(res.body.phone.ok, true);
  assert.equal(res.body.phone.name, "android-87ccece6");
  assert.equal(res.body.phone.lastSeen, seenAt);
  assert.equal(res.body.phone.online, true);
  assert.equal(res.body.devices.link, "LIVE");
});

test("a healthy relay still wins for the phone check-in values", async () => {
  const seenAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const app = makeApp();
  registerHomeBridgeConsole(app, {
    env: {
      HABITAT_AX_BRIDGE_TOKEN: OPERATOR,
      HOME_BRIDGE_AX_TOKEN: "hb_ax_" + "1".repeat(48),
      HOME_BRIDGE_BUFF_TOKEN: "hb_buff_" + "2".repeat(48),
      HOME_BRIDGE_URL: "https://relay.test"
    },
    fetchImpl: relayStub([]),
    deviceRepository: registryStub(seenAt)
  });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.relay.health, "ok");
  // The relay reports epoch milliseconds and the name "phone"; the registry would supply an ISO
  // string and a device id, so these two assertions prove the relay path was taken.
  assert.equal(typeof res.body.phone.lastSeen, "number");
  assert.notEqual(res.body.phone.lastSeen, seenAt);
  assert.equal(res.body.phone.name, "phone");
  assert.equal(res.body.phone.online, true);
});

test("status commands use the durable paired-device queue without a HOME RELAY credential", async () => {
  const app = makeApp();
  const queued = [];
  const calls = [];
  const deviceRepository = {
    async listDevices() {
      return [
        { device_id: "android-87ccece6-c9db-41c4-8956-b0e078b4d069", created_at: "2026-11-22T21:50:54.000Z", last_seen_at: new Date().toISOString(), revoked_at: null }
      ];
    },
    async enqueue(command) { queued.push(command); return command; }
  };
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: relayStub(calls),
    deviceRepository
  });

  const response = await invoke(app, "POST /bridge/console/send", {
    ...operator,
    body: { action: "status", arg: "" }
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action, "status");
  assert.equal(response.body.type, "device.status");
  assert.equal(response.body.deviceId, "android-87ccece6-c9db-41c4-8956-b0e078b4d069");
  assert.equal(response.body.status, "queued");
  assert.match(response.body.id, /^dc_/);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, "device.status");
  assert.deepEqual(queued[0].payload, {});
  assert.equal(queued[0].status, "queued");
  assert.equal(calls.some((call) => call.path === "/send"), false, "status must bypass legacy HOME RELAY");
});

test("status command rejects an unexpected argument", async () => {
  const app = makeApp();
  const deviceRepository = {
    async listDevices() { return [{ device_id: "android-87", created_at: new Date().toISOString(), revoked_at: null }]; },
    async enqueue() { assert.fail("invalid status argument must not enqueue"); }
  };
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("legacy relay must not be used"); },
    deviceRepository
  });
  const response = await invoke(app, "POST /bridge/console/send", {
    ...operator,
    body: { action: "status", arg: "unexpected" }
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /does not accept an argument/);
});

test("status command reports when no active paired phone exists", async () => {
  const app = makeApp();
  const deviceRepository = {
    async listDevices() { return [{ device_id: "android-old", revoked_at: "2026-11-22T00:00:00.000Z" }]; },
    async enqueue() { assert.fail("no active phone must not enqueue"); }
  };
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("legacy relay must not be used"); },
    deviceRepository
  });
  const response = await invoke(app, "POST /bridge/console/send", {
    ...operator,
    body: { action: "status", arg: "" }
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /No active paired phone/);
});

test("durable command receipts are read-only and map queued, received, completed and failed", async () => {
  const seenAt = new Date().toISOString();
  const t1 = "2026-11-23T20:00:00.000Z";
  const t2 = "2026-11-23T20:00:05.000Z";
  const t3 = "2026-11-23T20:00:09.000Z";
  const t4 = "2026-11-23T20:05:00.000Z";
  const queried = [];
  const app = makeApp();
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("relay unreachable"); },
    deviceRepository: {
      async listDevices() {
        return [{ device_id: "android-87ccece6", created_at: t1, last_seen_at: seenAt, revoked_at: null }];
      },
      async listCommands(args) {
        queried.push(args);
        return [
          { id: "dc_queued", deviceId: "android-87ccece6", type: "device.status", status: "queued", createdAt: t1, expiresAt: t4, payload: {} },
          { id: "dc_received", deviceId: "android-87ccece6", type: "device.status", status: "claimed", createdAt: t1, claimedAt: t2, expiresAt: t4, payload: {} },
          { id: "dc_completed", deviceId: "android-87ccece6", type: "device.status", status: "completed", createdAt: t1, claimedAt: t2, completedAt: t3, expiresAt: t4, result: { ok: true, summary: "Habitat Android device is online and responding" } },
          { id: "dc_failed", deviceId: "android-87ccece6", type: "device.status", status: "completed", createdAt: t1, claimedAt: t2, completedAt: t3, expiresAt: t4, result: { ok: false, summary: "Unsupported command rejected by Android agent" } }
        ];
      }
    }
  });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queried, [{ deviceId: "android-87ccece6", limit: 10 }], "receipts are scoped to the active phone and bounded");
  assert.equal(res.body.deviceCommands.available, true);
  assert.deepEqual(res.body.deviceCommands.items.map((item) => item.state), ["queued", "received", "completed", "failed"]);
  const completed = res.body.deviceCommands.items.find((item) => item.id === "dc_completed");
  assert.equal(completed.deviceId, "android-87ccece6");
  assert.equal(completed.queuedAt, t1);
  assert.equal(completed.receivedAt, t2);
  assert.equal(completed.completedAt, t3);
  assert.equal(completed.summary, "Habitat Android device is online and responding");
  const serialized = JSON.stringify(res.body.deviceCommands);
  assert.equal(serialized.includes(OPERATOR), false);
  assert.equal(serialized.includes("token"), false, "a receipt never carries a token field");
});

test("a receipt read failure is logged structurally and leaves the dashboard working", async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.map((value) => String(value)).join(" ")); };
  try {
    const app = makeApp();
    registerHomeBridgeConsole(app, {
      env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
      fetchImpl: async () => { throw new Error("relay unreachable"); },
      deviceRepository: {
        async listDevices() { return []; },
        async listCommands() { const error = new Error("D1 read failed for habitat_device_commands"); error.code = "D1_ERROR"; throw error; }
      }
    });
    const res = await invoke(app, "GET /bridge/console/dashboard", operator);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deviceCommands.available, true);
    assert.deepEqual(res.body.deviceCommands.items, []);
    assert.match(res.body.deviceCommands.error, /unable to read durable command receipts/);
    const logged = logs.find((line) => line.includes("CONSOLE_DEVICE_RECEIPTS_READ_FAILED"));
    assert.ok(logged, "the read failure is logged");
    assert.match(logged, /device_receipts_read_failed/);
    assert.match(logged, /D1_ERROR/);
    assert.equal(logged.includes(OPERATOR), false);
  } finally {
    console.error = original;
  }
});

test("receipts report unavailability when the store cannot list commands", async () => {
  const app = makeApp();
  registerHomeBridgeConsole(app, {
    env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
    fetchImpl: async () => { throw new Error("relay unreachable"); },
    deviceRepository: { async listDevices() { return []; } }
  });
  const res = await invoke(app, "GET /bridge/console/dashboard", operator);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deviceCommands.available, false);
  assert.deepEqual(res.body.deviceCommands.items, []);
});

test("an enqueue failure is logged structurally without credentials and returns 503", async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.map((value) => String(value)).join(" ")); };
  try {
    const app = makeApp();
    registerHomeBridgeConsole(app, {
      env: { HABITAT_AX_BRIDGE_TOKEN: OPERATOR },
      fetchImpl: async () => { throw new Error("legacy relay must not be used"); },
      deviceRepository: {
        async listDevices() { return [{ device_id: "android-87ccece6", created_at: new Date().toISOString(), revoked_at: null }]; },
        async enqueue() { const error = new Error("D1 write failed"); error.code = "D1_ERROR"; throw error; }
      }
    });
    const res = await invoke(app, "POST /bridge/console/send", { ...operator, body: { action: "status", arg: "" } });
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /Unable to queue the paired-phone status command/);
    const logged = logs.find((line) => line.includes("CONSOLE_DEVICE_COMMAND_ENQUEUE_FAILED"));
    assert.ok(logged, "the enqueue failure is logged");
    assert.match(logged, /"event":"device_command_enqueue_failed"/);
    assert.match(logged, /"type":"device.status"/);
    assert.match(logged, /"deviceId":"android-87ccece6"/);
    assert.match(logged, /D1_ERROR/);
    assert.equal(logged.includes(OPERATOR), false);
    assert.equal(logged.includes("Bearer"), false);
    assert.equal(logged.includes("hb_ax_"), false);
  } finally {
    console.error = original;
  }
});

test("the console page exposes a read-only durable command receipt panel", async () => {
  const { app } = setup();
  const res = await invoke(app, "GET /bridge/console", {});
  const html = String(res.html);
  assert.match(html, /DURABLE DEVICE QUEUE/);
  assert.match(html, /id="device-cmd-list"/);
  assert.match(html, /deviceCommands\.items/);
  assert.match(html, /Read-only receipts from the durable paired-device queue/);
  assert.match(html, /id="cmd-list"/, "the legacy relay results list is preserved");
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
