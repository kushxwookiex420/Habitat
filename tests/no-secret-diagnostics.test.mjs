import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("public diagnostics never return API key prefixes or lengths", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bapiKeyPrefix\s*:/);
  assert.doesNotMatch(source, /\bruntimeKeyPrefix\s*:/);
  assert.doesNotMatch(source, /\bruntimeKeyLength\s*:/);
  assert.match(source, /runtimeKeyPresent:\s*true/);
  assert.match(source, /secretsExposed:\s*false/);
});
