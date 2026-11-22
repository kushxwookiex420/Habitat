import test from "node:test";
import assert from "node:assert/strict";
import { clientSource, CONTROL_CENTER_PATH, registerControlCenter, renderControlCenter } from "../control-center.mjs";

/**
 * The control center is a served page, so these are contract tests on the bytes we actually send:
 * the required sections exist, the browser talks to the real authenticated API, and no credential or
 * placeholder status is baked into the page.
 */

test("the page exposes every required control-center section", () => {
  const html = renderControlCenter({ version: "0.5.0" });
  for (const tab of ["chat", "workers", "tasks", "memory", "approvals", "missions", "health"]) {
    assert.match(html, new RegExp('data-tab="' + tab + '"'), "tab " + tab);
  }
  assert.equal((html.match(/role="tab"/g) || []).length, 7);
  assert.match(html, /id="brain"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /Version 0\.5\.0/);
});

test("the brain is a real 3D neural renderer, not a decorative sphere", () => {
  const source = clientSource();
  assert.match(source, /getContext\("webgl"/);
  assert.match(source, /NEURONS/);
  assert.match(source, /Cerebellum/);
  assert.match(source, /Brainstem/);
  assert.match(source, /Synapses/);
  assert.match(source, /gl\.drawArrays\(gl\.POINTS/);
  assert.match(source, /gl\.drawArrays\(gl\.LINES/);
  assert.match(source, /rotationY/);
});

test("every panel reads a real authenticated endpoint", () => {
  const source = clientSource();
  for (const path of [
    "/ax/command/runs",
    "/ax/command/presence",
    "/ax/command/tasks",
    "/ax/command/memory/stats",
    "/ax/command/memory/search",
    "/ax/command/history",
    "/ax/command/notifications",
    "/ax/command/diagnostics",
    "/ax/command/providers"
  ]) {
    assert.ok(source.includes(path), "must call " + path);
  }
  assert.match(source, /authorization: "Bearer " \+ token\(\)/);
});

test("no credential or placeholder status is baked into the page", () => {
  const html = renderControlCenter({ version: "0.5.0" });
  const source = clientSource();
  for (const text of [html, source]) {
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{16,}/);
    assert.doesNotMatch(text, /ghp_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(text, /localStorage/);
  }
  // The token is only ever read from sessionStorage, typed by the owner.
  assert.match(source, /sessionStorage\.getItem\(TOKEN_KEY\)/);
  assert.match(source, /sessionStorage\.setItem\(TOKEN_KEY, value\)/);
  // A missing token produces "locked", never a fabricated healthy state.
  assert.match(html, /Not connected/);
  assert.match(source, /it will not invent a status/);
  assert.match(source, /Configured is not tested/);
});

test("work is only shown from backend data, never seeded in the page", () => {
  const html = renderControlCenter({ version: "0.5.0" });
  assert.doesNotMatch(html, /worker-1|task-1|run_demo|example\.com/);
  assert.match(html, /Nothing here is simulated/);
  const source = clientSource();
  assert.match(source, /No runs recorded yet/);
  assert.match(source, /No command tasks exist/);
  assert.match(source, /No notifications recorded/);
});

test("the routes serve the page and its script", () => {
  const routes = new Map();
  const app = { get(path, handler) { routes.set(path, handler); } };
  registerControlCenter(app, { version: "9.9.9" });
  assert.equal(CONTROL_CENTER_PATH, "/control");
  assert.ok(routes.has("/control"));
  assert.ok(routes.has("/control/app.js"));

  const captured = {};
  const res = { type(value) { captured.type = value; return this; }, send(body) { captured.body = body; return this; } };
  routes.get("/control")({}, res);
  assert.equal(captured.type, "html");
  assert.match(captured.body, /Version 9\.9\.9/);

  routes.get("/control/app.js")({}, res);
  assert.equal(captured.type, "application/javascript");
  assert.match(captured.body, /^var startBrain = function startBrain/);
});
