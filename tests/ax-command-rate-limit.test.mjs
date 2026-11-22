import test from "node:test";
import assert from "node:assert/strict";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";

const COMMAND = "axcmd_rate_limit_test_0123456789";
const BRIDGE = "axbridge_rate_limit_test_0123456789";
const commandAuth = { authorization: "Bearer " + COMMAND };
const bridgeAuth = { authorization: "Bearer " + BRIDGE };

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set("GET " + path, handlers); },
    post(path, ...handlers) { routes.set("POST " + path, handlers); }
  };
}

function mount(app, env = {}) {
  registerUniversalCommandRoutes(app, {
    env: {
      HABITAT_AX_COMMAND_TOKEN: COMMAND,
      HABITAT_AX_BRIDGE_TOKEN: BRIDGE,
      AX_COMMAND_RATE_MAX: "2",
      AX_COMMAND_RATE_WINDOW_MS: "60000",
      ...env
    },
    repository: { initialize: async () => {}, get: async () => null, list: async () => [] }
  });
}

async function invoke(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, "registered route: " + key);
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; }
  };
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

test("the command surface refuses requests over its per-credential limit", async () => {
  const app = makeApp();
  mount(app);
  const first = await invoke(app, "GET /ax/command/presence", { headers: commandAuth });
  const second = await invoke(app, "GET /ax/command/presence", { headers: commandAuth });
  const third = await invoke(app, "GET /ax/command/presence", { headers: commandAuth });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.equal(third.body.code, "rate_limited");
  assert.ok(Number(third.body.retryAfterMs) > 0);
  assert.ok(Number(third.headers["retry-after"]) >= 1);
});

test("each credential has its own bucket, so one cannot exhaust the other", async () => {
  const app = makeApp();
  mount(app);
  await invoke(app, "GET /ax/command/presence", { headers: commandAuth });
  await invoke(app, "GET /ax/command/presence", { headers: commandAuth });
  const overCommand = await invoke(app, "GET /ax/command/presence", { headers: commandAuth });
  const bridge = await invoke(app, "GET /ax/command/presence", { headers: bridgeAuth });
  assert.equal(overCommand.statusCode, 429);
  assert.equal(bridge.statusCode, 200);
});

test("an unauthenticated caller is refused before the limiter and never fills a bucket", async () => {
  const app = makeApp();
  mount(app);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await invoke(app, "GET /ax/command/presence", { headers: { authorization: "Bearer wrong-" + attempt } });
    assert.equal(response.statusCode, 401);
  }
  const authenticated = await invoke(app, "GET /ax/command/presence", { headers: commandAuth });
  assert.equal(authenticated.statusCode, 200, "a failed credential must not consume the real bucket");
});
