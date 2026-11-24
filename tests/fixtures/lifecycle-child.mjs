import fs from "node:fs";
import {
  createNexusWorker, registerNexusRuntime, NEXUS_CLAIM_SQL
} from "../../nexus-runtime.mjs";

const marker = process.argv[2];
const mode = process.argv[3];
const holder = { fence: null, workerId: null };
let claimed = mode.startsWith("late");
let completions = 0;
let adapterCalls = 0;

const taskRecord = {
  id: "cmd_lifecycle", objective: "lifecycle probe", role: "ax", adapter: "repo.inspect",
  status: "working", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  attempts: 1, approvals: [], statusHistory: [], checkpoints: []
};

const repository = {
  durable: true,
  async initialize() {
    console.log("STORE_INIT_START");
    if (mode === "init-signal") await new Promise(r => setTimeout(r, 2000));
    if (mode === "init-shutdown") await new Promise(r => setTimeout(r, 300));
    console.log("STORE_INIT_DONE");
  },
  async get() { return { ...taskRecord, fence: holder.fence, claimedBy: holder.workerId }; },
  async create(t) { return t; },
  async update(id, patch) { return { ...taskRecord, ...patch }; },
  async transition(id, { next }) { return { ...taskRecord, ...next }; },
  async delete() { return true; }
};

const query = async (sql, params = []) => {
  if (sql === NEXUS_CLAIM_SQL) {
    if (claimed) return [{ results: [] }];
    claimed = true;
    holder.workerId = params[0];
    holder.fence = params[2];
    return [{ results: [{ record_json: JSON.stringify(taskRecord) }] }];
  }
  return [{ results: [] }];
};

const engine = {
  async complete() {
    completions += 1;
    console.log("COMPLETE_COUNT " + completions);
    return { ok: true, task: { status: "done" } };
  }
};

const adapters = { "repo.inspect": async () => {
  adapterCalls += 1;
  console.log("ADAPTER_START_" + adapterCalls);
  await new Promise(r => setTimeout(r, 600));
  fs.writeFileSync(marker, "adapter-" + adapterCalls + "-completed");
  console.log("ADAPTER_DONE_" + adapterCalls);
  return { ok: true, summary: "lifecycle probe complete", evidence: ["probe"] };
} };

const runtime = registerNexusRuntime({ get() {}, post() {} }, {
  env: {}, query, repository, adapters, engine,
  worker: createNexusWorker({ repository, engine, query, adapters, pollMs: 60000 }),
  handleSignals: mode !== "stop-twice" && mode !== "init-shutdown",
  exitOnSignal: true
});

if (mode === "init-shutdown") {
  const initializing = runtime.initialize({ startWorker: true });
  await new Promise(r => setTimeout(r, 50));
  const stopped = await runtime.shutdown("probe-interrupt");
  const result = await initializing;
  console.log("INIT_RESULT " + JSON.stringify(result));
  console.log("WORKER_STARTED " + runtime.worker.isStarted());
  console.log("IS_STOPPED " + runtime.worker.isStopped());
  console.log("ADAPTER_CALLS " + adapterCalls);
  process.exit(0);
}

if (mode === "stop-twice") {
  await runtime.initialize({ startWorker: true });
  console.log("INITIALIZED");
  const first = runtime.shutdown("probe-stop");
  const second = runtime.shutdown("probe-stop");
  await Promise.all([first, second]);
  console.log("WORKER_STARTED " + runtime.worker.isStarted());
  process.exit(0);
}

if (mode === "late-single" || mode === "late-double") {
  await runtime.initialize({ startWorker: true });
  console.log("INITIALIZED");
  claimed = false;
  const ticking = runtime.worker.tick();
  console.log("TICK2_ISSUED");
  await ticking;
  console.log("TICK2_DONE");
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
}

if (mode === "init-signal") {
  await runtime.initialize({ startWorker: true });
  console.log("INITIALIZED");
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
}
