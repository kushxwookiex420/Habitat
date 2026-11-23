// Multi-process fixture: one process = one real scheduler participant on a shared SQLite file.
import { createSchedulerService } from "../../ax-scheduler.mjs";
import { createSqliteSchedulerRepository } from "../../ax-scheduler-repository.mjs";

const [filename, action, ...args] = process.argv.slice(2);
if (!filename || !action) {
  console.error("usage: scheduler-process.mjs <db> <tick|acquire|heartbeat|complete|status> [...]");
  process.exit(2);
}

const repo = createSqliteSchedulerRepository({ filename });
const scheduler = createSchedulerService({
  ticks: repo,
  recovery: {
    async scanAndRecord() {
      const delay = Number(process.env.FIXTURE_TICK_DELAY_MS || 0);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      return { ok: true, recorded: [], report: { summary: { total: 0 } } };
    }
  }
});

try {
  let result;
  if (action === "tick") {
    const startAt = Number(process.env.FIXTURE_START_AT || 0);
    if (startAt > Date.now()) await new Promise(resolve => setTimeout(resolve, startAt - Date.now()));
    result = await scheduler.tick({ trigger: process.env.FIXTURE_TRIGGER || "fixture" });
  } else if (action === "acquire") {
    result = await repo.acquire({
      tickId: args[0] || "fixture-tick",
      owner: "fixture",
      ttlMs: Number(args[1] || 60_000),
      nowMs: Number(args[2] || Date.now())
    });
  } else if (action === "heartbeat") {
    result = await repo.heartbeat({
      tickId: args[0],
      ttlMs: Number(args[1] || 60_000),
      nowMs: Number(args[2] || Date.now())
    });
  } else if (action === "complete") {
    result = await repo.complete({ tickId: args[0], status: "ok", detail: "fixture", nowIso: new Date().toISOString() });
  } else if (action === "status") {
    result = await repo.status();
  } else {
    throw new Error("unknown action " + action);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  repo.close();
}
