import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerUniversalCommandRoutes } from "../command-routes.mjs";
import { buildAxOpenApiSpec } from "../scripts/ax-openapi.mjs";
import {
  checkAxContract,
  classifyRouteKey,
  compareSpecToRoutes,
  expressRouteKeys,
  expressToSpecPath,
  scanForSecrets,
  specOperations,
  specToExpressPath,
  validateSpec
} from "../scripts/ax-openapi-contract.mjs";

const ENV = {
  HABITAT_AX_COMMAND_TOKEN: "axcmd_contract_test_0123456789",
  HABITAT_AX_BRIDGE_TOKEN: "axbridge_contract_test_0123456789",
  AX_NEXUS_TOKEN: "axnexus_contract_test_0123456789"
};

function mountRoutes() {
  const app = express();
  registerUniversalCommandRoutes(app, {
    env: ENV,
    repository: { initialize: async () => {}, get: async () => null, list: async () => [] }
  });
  return app;
}

function spec() {
  return buildAxOpenApiSpec({ origin: "https://habitat.example.test" });
}

test("the published document is a valid OpenAPI 3.1 description", () => {
  const report = validateSpec(spec());
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.operations, 10, "ten operations are advertised");
});

test("the document describes only endpoints the real module registers", () => {
  const routeKeys = expressRouteKeys(mountRoutes());
  // 84 through Mission 16, plus the three Mission 17 mission-work routes, Mission 19's
  // agents/restore and the 17 P1 capability-network routes. None of the operator routes enter the
  // ChatGPT-facing document, so the advertised surface stays at ten operations.
  // 105 routes plus the three mission-pipeline routes. They are mounted but documented in
  // docs/openapi-missions.json, because this document may only describe /ax/command paths.
  assert.equal(routeKeys.length, 109);
  const parity = compareSpecToRoutes(spec(), routeKeys);
  assert.equal(parity.ok, true, parity.errors.join("\n"));
  assert.equal(parity.documented.length, 10);
  assert.ok(parity.excluded.length >= 70, "operator routes are explicitly excluded, not silently missing");
  for (const excluded of parity.excluded) assert.ok(excluded.reason, "every exclusion carries a reason: " + excluded.route);
});

test("the full contract check passes and never reports a credential", () => {
  const report = checkAxContract({ spec: spec(), routeKeys: expressRouteKeys(mountRoutes()) });
  assert.equal(report.ok, true, report.errors.join("\n"));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(ENV.HABITAT_AX_COMMAND_TOKEN), false);
  assert.equal(serialized.includes(ENV.AX_NEXUS_TOKEN), false);
});

test("the Task schema matches the fields the API actually returns", () => {
  const task = spec().components.schemas.Task.properties;
  assert.ok(task.statusHistory, "statusHistory is documented, not the invented `history`");
  assert.equal(task.history, undefined);
  assert.ok(task.result.properties.verifiedBy, "verifiedBy is part of a completed result");
  assert.ok(task.status.enum.includes("blocked"), "a task with no adapter is reported as blocked");
});

test("an invented endpoint fails the route comparison", () => {
  const tampered = spec();
  tampered.paths["/ax/command/invented"] = {
    get: { operationId: "invented", summary: "does not exist", responses: { "200": { description: "ok" } } }
  };
  const parity = compareSpecToRoutes(tampered, expressRouteKeys(mountRoutes()));
  assert.equal(parity.ok, false);
  assert.match(parity.errors.join("\n"), /documented but not implemented: GET \/ax\/command\/invented/);
});

test("a new unclassified route fails the comparison instead of being ignored", () => {
  const routeKeys = [...expressRouteKeys(mountRoutes()), "POST /ax/command/owners/root"];
  const parity = compareSpecToRoutes(spec(), routeKeys);
  assert.equal(parity.ok, false);
  assert.match(parity.errors.join("\n"), /neither documented nor excluded: POST \/ax\/command\/owners\/root/);
  assert.equal(classifyRouteKey("POST /ax/command/owners/root").allowed, false);
});

test("the NEXUS surface and task transitions are classified with reasons", () => {
  const nexus = classifyRouteKey("GET /ax/nexus/channel");
  assert.equal(nexus.allowed, true);
  assert.match(nexus.reason, /NEXUS/);
  const approve = classifyRouteKey("POST /ax/command/tasks/:id/approve");
  assert.equal(approve.allowed, true);
  assert.match(approve.reason, /owner|worker/);
});

test("duplicate operation ids are refused", () => {
  const tampered = spec();
  tampered.paths["/ax/command/presence"].get.operationId = "listTasks";
  const report = validateSpec(tampered);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /operationId is duplicated: listTasks/);
});

test("a plain-HTTP server origin is refused", () => {
  const tampered = spec();
  tampered.servers = [{ url: "http://habitat.example.test" }];
  const report = validateSpec(tampered, { allowLoopbackHttp: false });
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /must be HTTPS/);
  assert.equal(validateSpec({ ...spec(), servers: [{ url: "http://127.0.0.1:8787" }] }).ok, true, "loopback stays usable for local checks");
});

test("OpenAPI 3.0 nullable syntax is refused", () => {
  const tampered = spec();
  tampered.components.schemas.Task.properties.adapter = { type: "string", nullable: true };
  const report = validateSpec(tampered);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /nullable/);
});

test("an oversized description is refused (OpenAI's 300-character guidance)", () => {
  const tampered = spec();
  tampered.paths["/ax/command/tools"].get.description = "x".repeat(301);
  const report = validateSpec(tampered);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /exceeds 300 characters/);
});

test("a path parameter must be declared and required", () => {
  const tampered = spec();
  tampered.paths["/ax/command/tasks/{id}"].get.parameters = [];
  const report = validateSpec(tampered);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /path parameter id is not declared/);
});

test("a credential in the document is found without being repeated", () => {
  const tampered = spec();
  tampered.info.description = "debug " + ENV.HABITAT_AX_COMMAND_TOKEN;
  const findings = scanForSecrets(tampered);
  assert.equal(findings.length, 1);
  const report = validateSpec(tampered);
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes(ENV.HABITAT_AX_COMMAND_TOKEN), false, "the failure must not echo the secret");
});

test("Express and OpenAPI path templates round-trip", () => {
  assert.equal(expressToSpecPath("/ax/command/tasks/:id"), "/ax/command/tasks/{id}");
  assert.equal(specToExpressPath("/ax/command/messages/thread/{correlationId}"), "/ax/command/messages/thread/:correlationId");
  assert.deepEqual(
    specOperations(spec()).map(operation => operation.operationId).sort(),
    ["answerNexusQuestion", "getEvents", "getNexusThread", "getPresence", "getTask", "listNexusMessages", "listTasks", "listTools", "sendNexusMessage", "submitTask"]
  );
});
