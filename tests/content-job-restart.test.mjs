import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { registerContentEngine } from "../content-engine.mjs";

function makeApp(repository) {
  const app = express();
  app.use(express.json());
  registerContentEngine(app, {
    nowIso: () => new Date().toISOString(),
    makeTaskId: () => "task-test-" + Math.random().toString(36).slice(2),
    taskStore: new Map(),
    workerRegistry: new Map(),
    brainChat: async () => ({
      choices: [{ message: { content: JSON.stringify({
        angle: "Verified facts only",
        audience: "GTA fans",
        hookIdeas: ["Official update"],
        keyClaims: ["Use official sources"],
        visualIdeas: ["Official game images"],
        risks: ["Avoid rumors"],
        nextBestAction: "Verify official sources"
      }) } }]
    }),
    contentJobRepository: repository,
    secretVault: null
  });
  return app;
}

async function withServer(app, callback) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  try { return await callback(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("content job survives a new app instance and can continue research from D1-backed repository", async () => {
  const durable = new Map();
  const repository = {
    async upsert(job) { durable.set(job.id, structuredClone(job)); return structuredClone(job); },
    async get(id) { return structuredClone(durable.get(id) || null); },
    async list() { return [...durable.values()].map(x => structuredClone(x)); },
    async healthCheck() { return { ok:true, durable:true }; }
  };

  let jobId;
  await withServer(makeApp(repository), async base => {
    const response = await fetch(base + "/content/jobs", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({project:"ViceCityFiles",objective:"test durable resume",platform:"tiktok",format:"9:16"})
    });
    assert.equal(response.status,200);
    const body = await response.json();
    assert.equal(body.ok,true);
    jobId = body.job.id;
    assert.ok(durable.has(jobId),"job must be persisted before the create response completes");
  });

  // Simulate a Render restart/new instance: the in-memory Map starts empty.
  await withServer(makeApp(repository), async base => {
    const response = await fetch(base + "/content/jobs/" + encodeURIComponent(jobId) + "/research", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:"{}"
    });
    const body = await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(body.ok,true);
    assert.equal(body.job.stages.research.status,"completed");
    assert.ok(durable.get(jobId).stages.research.result);
  });
});
