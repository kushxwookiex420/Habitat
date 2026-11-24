import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";

function makeApp() {
  const routes = new Map();
  return { routes, get: (path) => routes.set("GET " + path, true), post: (path) => routes.set("POST " + path, true) };
}

const document = async () => JSON.parse(await readFile(new URL("../docs/openapi-missions.json", import.meta.url), "utf8"));

test("the mission OpenAPI document documents exactly the mission routes that are mounted", async () => {
  const app = makeApp();
  registerUniversalCommandRoutes(app, { env: { HABITAT_AX_COMMAND_TOKEN: "x".repeat(32) } });
  const mounted = [...app.routes.keys()]
    .filter((key) => key.includes(" /ax/missions"))
    .map((key) => {
      const [method, path] = key.split(" ");
      return method.toLowerCase() + " " + path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    })
    .sort();
  assert.deepEqual(mounted, [
    "get /ax/missions/{missionId}",
    "post /ax/missions",
    "post /ax/missions/{missionId}/approve",
    "post /ax/missions/{missionId}/run"
  ], "the documented surface is the mounted surface");

  const spec = await document();
  const documented = Object.entries(spec.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map((method) => method + " " + path))
    .sort();
  assert.deepEqual(documented, mounted);
});

test("the mission document is a valid OpenAPI 3.1 description with honest responses", async () => {
  const spec = await document();
  assert.equal(spec.openapi, "3.1.0");
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths)) {
    assert.match(path, /^\/ax\/missions/, "mission paths only");
    for (const [method, operation] of Object.entries(methods)) {
      assert.equal(typeof operation.operationId, "string");
      assert.ok(!ids.has(operation.operationId), "operation ids are unique");
      ids.add(operation.operationId);
      assert.ok(operation.description.length <= 300, "descriptions stay under the action limit");
      assert.equal(typeof operation.responses, "object");
      assert.ok(operation.responses["401"] || operation.responses["503"], "auth or unavailability is documented");
      assert.notEqual(method, "delete", "the mission surface has no destructive operation");
    }
  }
  const submit = spec.paths["/ax/missions"].post;
  assert.equal(submit["x-openai-isConsequential"], true, "creating and running missions is consequential");
  assert.equal(spec.paths["/ax/missions/{missionId}"].get["x-openai-isConsequential"], false, "reading is not");
});
