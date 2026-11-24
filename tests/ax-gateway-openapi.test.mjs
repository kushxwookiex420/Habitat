import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OPENAPI } from "../ax-gateway.mjs";

const REQUIRED = [
  "/ax/v1/status",
  "/ax/v1/missions",
  "/ax/v1/missions/{id}",
  "/ax/v1/missions/{id}/decision",
  "/ax/v1/heartbeat",
  "/ax/v1/heartbeat/ack",
  "/ax/v1/recover",
  "/ax/v1/audit"
];

test("the served OpenAPI document is structurally valid and covers every gateway route", () => {
  assert.equal(OPENAPI.openapi, "3.1.0");
  assert.ok(OPENAPI.info?.title);
  assert.ok(OPENAPI.components?.securitySchemes?.bearerAuth);
  assert.deepEqual(OPENAPI.security, [{ bearerAuth: [] }]);
  for (const path of REQUIRED) assert.ok(OPENAPI.paths[path], "missing " + path);
  for (const [path, methods] of Object.entries(OPENAPI.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(operation.operationId, method + " " + path + " needs an operationId");
      assert.ok(Object.keys(operation.responses || {}).length > 0, method + " " + path + " needs responses");
      for (const response of Object.values(operation.responses)) {
        assert.ok(response.description, method + " " + path + " response needs a description");
      }
    }
  }
});

test("POST operations document nonce and timestamp requirements", () => {
  for (const [path, methods] of Object.entries(OPENAPI.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method !== "post") continue;
      const refs = (operation.parameters || []).map(parameter => parameter.$ref || "").join(" ");
      assert.match(refs, /nonce/, method + " " + path + " must document the nonce");
      assert.match(refs, /timestamp/, method + " " + path + " must document the timestamp");
    }
  }
});

test("the committed document matches the served specification and contains no credential", async () => {
  const text = await readFile(new URL("../openapi/ax-gateway.json", import.meta.url), "utf8");
  const document = JSON.parse(text);
  assert.deepEqual(document.paths, JSON.parse(JSON.stringify(OPENAPI.paths)));
  assert.equal(document.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.doesNotMatch(text, /axg_[a-z0-9-]+_[A-Za-z0-9_-]{20,}/i);
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{20,}/);
});
