// Habitat's device-facing dashboard endpoint.
//
//   GET /device/habitat   -> one JSON payload for the launcher's Habitat panel
//
// The phone authenticates with the per-device bearer token it received from POST /device/pair.
// It never holds the relay's ax or buff credential: those stay in this process and are used here
// to read the relay on the device's behalf. That is the whole reason this endpoint exists — the
// Android client cannot be trusted with a role token, and the relay must never see a phone token.
//
// Every field that cannot be verified is reported as unavailable with a reason. There are no
// invented numbers, no placeholder success states and no simulated sales.

import { createD1DeviceCommandRepository } from "./d1-device-command-repository.mjs";
import { createHomeBridgeClient } from "./home-bridge-client.mjs";

const GITHUB_CACHE_MS = 60000;
// Same vocabulary the relay accepts; anything else is refused here before a request is made.
const PHONE_ACTIONS = new Set(["status", "page", "app", "torch", "clear", "remote", "url"]);

function short(value, max = 200) {
  return String(value == null ? "" : value).slice(0, max);
}

function bearer(req) {
  const value = String(req.headers?.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

/**
 * @param {object} app express app
 * @param {object} options
 * @param {object} [options.repository] device repository (verifyDeviceToken); built from env when omitted
 */
export function registerDeviceHabitat(app, { env = process.env, fetchImpl = fetch, repository = null } = {}) {
  const hasD1 = ["CLOUDFLARE_ACCOUNT_ID", "HABITAT_D1_DATABASE_ID", "HABITAT_D1_API_TOKEN"]
    .every((key) => String(env[key] || "").trim());
  const store = repository || (hasD1
    ? createD1DeviceCommandRepository({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: env.HABITAT_D1_DATABASE_ID,
        apiToken: env.HABITAT_D1_API_TOKEN,
        fetchImpl
      })
    : null);

  const client = createHomeBridgeClient({
    baseUrl: env.HOME_BRIDGE_URL,
    axToken: env.HOME_BRIDGE_AX_TOKEN,
    buffToken: env.HOME_BRIDGE_BUFF_TOKEN,
    fetchImpl
  });

  const githubRepo = String(env.HABITAT_GITHUB_REPO || "kushxwookiex420/home-launcher").trim();
  const githubToken = String(env.GITHUB_TOKEN || "").trim();
  const startedAt = Date.now();
  const githubCache = { at: 0, data: null };

  function deviceIdFrom(req) {
    return String(req.query?.deviceId || req.body?.deviceId || req.headers?.["x-device-id"] || "").trim();
  }

  async function requireDevice(req, res, next) {
    if (!store) {
      return res.status(503).json({ ok: false, error: "Device dashboard is unavailable: this Habitat process has no device store configured." });
    }
    const deviceId = deviceIdFrom(req);
    const token = bearer(req);
    if (!deviceId || !token) {
      return res.status(401).json({ ok: false, error: "A paired deviceId and device token are required." });
    }
    try {
      const valid = await store.verifyDeviceToken(token, deviceId);
      if (!valid) return res.status(401).json({ ok: false, error: "Unknown or revoked device token." });
      req.habitatDeviceId = deviceId;
      return next();
    } catch (error) {
      console.error("DEVICE_HABITAT_AUTH_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Device authentication is temporarily unavailable." });
    }
  }

  async function commits() {
    if (githubCache.data && Date.now() - githubCache.at < GITHUB_CACHE_MS) return githubCache.data;
    let data;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${githubRepo}/commits?per_page=5`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "habitat-device-dashboard",
          ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
        }
      });
      if (!response.ok) {
        data = { ok: false, status: response.status, commits: [], error: `github HTTP ${response.status}` };
      } else {
        const body = await response.json();
        data = {
          ok: true,
          status: response.status,
          repo: githubRepo,
          commits: (Array.isArray(body) ? body : []).slice(0, 5).map((entry) => ({
            sha: short(entry.sha, 40),
            short: short(entry.sha, 7),
            message: short(entry.commit?.message?.split("\n")[0], 160),
            author: short(entry.commit?.author?.name, 60),
            date: short(entry.commit?.author?.date, 40)
          }))
        };
      }
    } catch {
      data = { ok: false, status: 0, commits: [], error: "github unreachable" };
    }
    githubCache.at = Date.now();
    githubCache.data = data;
    return data;
  }

  async function buildPayload(deviceId) {
    const [health, state, tasks, replies, files, queue, github] = await Promise.all([
      client.health(),
      client.state(),
      client.tasks({ limit: 20 }),
      client.replies({ limit: 10 }),
      client.listFiles(),
      client.configured("buff") ? client.queue() : Promise.resolve({ ok: false, status: 0, error: "buff credential not configured" }),
      commits()
    ]);

    const taskRows = tasks.data?.tasks || [];
    const replyRows = replies.data?.replies || [];
    const queueRows = queue.data?.tasks || [];
    const commands = state.data?.commands || [];

    return {
      ok: true,
      deviceId,
      generatedAt: new Date().toISOString(),
      // Everything below is read from the relay or this process. Nothing is estimated.
      relay: {
        url: client.baseUrl,
        health: health.ok ? "ok" : "unavailable",
        detail: health.error || (health.data?.db ? "database reachable" : "database state unknown"),
        credentials: client.roles
      },
      ax: {
        ok: tasks.ok || replies.ok,
        counts: {
          queued: taskRows.filter((t) => t.status === "queued").length,
          working: taskRows.filter((t) => t.status === "working").length,
          done: taskRows.filter((t) => t.status === "done").length
        },
        tasks: taskRows.slice(0, 10).map((t) => ({
          id: t.id,
          title: t.title || null,
          text: short(t.text, 240),
          status: t.status,
          at: t.iso || null,
          artifacts: t.artifacts || []
        })),
        error: tasks.ok ? null : tasks.error
      },
      buff: {
        ok: queue.ok,
        queue: queueRows.slice(0, 10).map((t) => ({
          id: t.id,
          title: t.title || null,
          text: short(t.text, 240),
          status: t.status || "queued",
          at: t.iso || null
        })),
        replies: replyRows.map((r) => ({
          id: r.id,
          taskId: r.taskId || null,
          text: short(r.text, 300),
          at: r.iso || null,
          artifacts: r.artifacts || []
        })),
        error: queue.ok ? null : queue.error
      },
      phone: {
        ok: state.ok,
        name: state.data?.name || null,
        online: Boolean(state.data?.online),
        lastSeen: state.data?.lastSeen || null,
        commands: commands.slice(0, 10).map((c) => ({
          id: c.id,
          action: c.action,
          arg: c.arg || null,
          status: c.status,
          output: c.output ? short(c.output, 300) : null,
          at: c.iso || null
        })),
        error: state.ok ? null : state.error
      },
      workers: {
        // Derived from what the relay actually reports. A worker with no signal is "unknown",
        // never "healthy".
        items: [
          { name: "AX · brain", state: client.roles.ax && (tasks.ok || replies.ok) ? "active" : "offline" },
          { name: "BUFF · agent", state: queue.ok ? (queueRows.length ? "assigned" : "idle") : "offline" },
          { name: "PHONE · poller", state: state.ok && state.data?.online ? "polling" : "idle" },
          { name: "RELAY · bridge", state: health.ok ? "online" : "unreachable" },
          { name: "HABITAT · api", state: "serving" }
        ],
        pendingTasks: queueRows.length,
        workingTasks: taskRows.filter((t) => t.status === "working").length
      },
      business: {
        available: false,
        reason: "No verified business ledger is connected to this Habitat process. Sales, expenses and profit are not shown rather than estimated.",
        dropPilot: null,
        viceCity: null
      },
      cloud: {
        habitat: { status: "serving", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) },
        github,
        providers: {
          openRouter: Boolean(String(env.OPENROUTER_API_KEY || "").trim()),
          relay: client.roles.ax && client.roles.buff
        },
        deployments: {
          relay: { url: client.baseUrl, status: health.ok ? "online" : "unreachable" }
        }
      },
      files: {
        ok: files.ok,
        count: (files.data?.files || []).length,
        items: (files.data?.files || []).slice(0, 20).map((f) => ({
          name: f.name,
          size: f.size,
          encoding: f.encoding,
          at: f.iso || null
        })),
        error: files.ok ? null : files.error
      },
      errors: [
        tasks.ok ? null : { source: "tasks", error: tasks.error },
        replies.ok ? null : { source: "replies", error: replies.error },
        files.ok ? null : { source: "files", error: files.error },
        state.ok ? null : { source: "state", error: state.error },
        queue.ok ? null : { source: "queue", error: queue.error },
        github.ok ? null : { source: "github", error: github.error }
      ].filter(Boolean)
    };
  }

  app.get("/device/habitat", requireDevice, async (req, res) => {
    try {
      res.setHeader("cache-control", "no-store");
      return res.json(await buildPayload(req.habitatDeviceId));
    } catch (error) {
      console.error("DEVICE_HABITAT_FAILED", String(error?.message || error));
      return res.status(502).json({ ok: false, error: "Habitat could not assemble the dashboard." });
    }
  });

  // Queue one allowlisted phone action with the server-held ax credential. The phone never holds
  // that credential itself, and the relay still re-validates the action against its own whitelist.
  app.post("/device/habitat/phone", requireDevice, async (req, res) => {
    const action = String(req.body?.action || "").trim();
    const arg = String(req.body?.arg || "").trim().slice(0, 300);
    if (!PHONE_ACTIONS.has(action)) {
      return res.status(400).json({ ok: false, error: `action must be one of ${[...PHONE_ACTIONS].join(", ")}` });
    }
    const result = await client.sendPhoneAction({ action, arg });
    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      id: result.data?.id || null,
      action,
      arg,
      error: result.error
    });
  });

  // Read one shared file with the server-held ax credential, for the phone's files panel.
  app.get("/device/habitat/file", requireDevice, async (req, res) => {
    const name = String(req.query?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name is required" });
    const result = await client.readFile(name);
    return res.status(result.ok ? 200 : result.status === 404 ? 404 : 502).json({
      ok: result.ok,
      name,
      data: result.data?.data ?? null,
      encoding: result.data?.encoding ?? null,
      size: result.data?.size ?? null,
      error: result.error
    });
  });

  return { buildPayload, store: () => store };
}
