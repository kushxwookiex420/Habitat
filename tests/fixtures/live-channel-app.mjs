import { DatabaseSync } from "node:sqlite";
import express from "express";
import { registerDeviceCommandBridge } from "../../device-command-bridge.mjs";

/**
 * Live HTTP app for the Mission 15 activation proof.
 *
 * This mounts the real composition root (`registerDeviceCommandBridge`) on a real Express server and
 * a real TCP socket. The only substitution is the D1 transport: statements are executed by
 * `node:sqlite` through a fetch shim shaped like the Cloudflare D1 HTTP API. No Cloudflare account,
 * no D1 database and no Render service is contacted, so this is LOCAL evidence.
 *
 * Started by `scripts/activation-live-test.mjs`, which kills and restarts it over the same SQLite
 * file to prove that channel state is reconstructed from storage rather than process memory.
 */

const quiet = { log() {}, warn() {}, error() {} };
const sqlitePath = String(process.env.ACTIVATION_SQLITE_PATH || "").trim();
if (!sqlitePath) {
  console.error("ACTIVATION_SQLITE_PATH is required.");
  process.exit(2);
}

function sqliteD1Fetch({ db }) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/chat/completions")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: JSON.stringify({ steps: [] }) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          };
        }
      };
    }
    const { sql, params = [] } = JSON.parse(init.body || "{}");
    const statement = db.prepare(sql);
    const rows = /^\s*SELECT/i.test(sql) || /RETURNING/i.test(sql)
      ? statement.all(...params)
      : (statement.run(...params), []);
    return { ok: true, status: 200, async json() { return { success: true, result: [{ results: rows }] }; } };
  };
}

const db = new DatabaseSync(sqlitePath);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA journal_mode = WAL");

const env = { ...process.env };
const app = express();
app.use(express.json({ limit: "1mb" }));

const bridge = registerDeviceCommandBridge(app, {
  env,
  fetchImpl: sqliteD1Fetch({ db }),
  handleSignals: false,
  exitOnSignal: false,
  log: quiet
});

const init = await bridge.initialize({ startWorker: false });
if (!init?.ok) {
  console.error("ACTIVATION_APP_INIT_FAILED", JSON.stringify(init));
  process.exit(3);
}

const server = app.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ ready: true, port }) + "\n");
});

async function shutdown() {
  await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
