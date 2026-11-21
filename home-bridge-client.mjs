// Server-side client for the Home Bridge relay (home-launcher/bridge).
//
// Two credentials, never the owner pairing code:
//   HOME_BRIDGE_AX_TOKEN    role ax   - submit tasks, read status/replies/files, queue phone actions
//   HOME_BRIDGE_BUFF_TOKEN  role buff - read/claim the queue, post replies, upload artifacts
//
// Tokens stay in this process. They are never returned to the browser, written to logs, or
// included in error messages. Calls never throw: the caller gets { ok, status, data, error }.

const DEFAULT_BASE_URL = "https://home-bridge-qn2hnd-preview.freebuff.site";
const DEFAULT_TIMEOUT_MS = 12000;

function cleanBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(raw)) return DEFAULT_BASE_URL;
  return raw;
}

export function createHomeBridgeClient({
  baseUrl = process.env.HOME_BRIDGE_URL,
  axToken = process.env.HOME_BRIDGE_AX_TOKEN,
  buffToken = process.env.HOME_BRIDGE_BUFF_TOKEN,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const base = cleanBaseUrl(baseUrl);
  const tokens = {
    ax: String(axToken || "").trim(),
    buff: String(buffToken || "").trim()
  };

  function configured(role) {
    return Boolean(tokens[role]);
  }

  async function call(role, path, { method = "GET", query, body } = {}) {
    if (!configured(role)) {
      return { ok: false, status: 0, error: `no ${role} credential configured`, data: null };
    }
    const url = new URL(base + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${tokens[role]}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 400) };
      }
      const ok = response.ok && data?.ok !== false;
      return {
        ok,
        status: response.status,
        data,
        error: ok ? null : String(data?.error || `HTTP ${response.status}`).slice(0, 300)
      };
    } catch (error) {
      const aborted = error?.name === "AbortError";
      return {
        ok: false,
        status: 0,
        error: aborted ? "relay timed out" : "relay unreachable",
        data: null
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl: base,
    configured,
    roles: { ax: configured("ax"), buff: configured("buff") },
    health: () => call("ax", "/health"),
    // ax
    state: () => call("ax", "/state"),
    tasks: (query) => call("ax", "/tasks", { query }),
    replies: (query) => call("ax", "/replies", { query }),
    listFiles: () => call("ax", "/files"),
    readFile: (name) => call("ax", "/file", { query: { name } }),
    submitTask: (payload) => call("ax", "/note", { method: "POST", body: payload }),
    sendPhoneAction: (payload) => call("ax", "/send", { method: "POST", body: payload }),
    // buff
    queue: () => call("buff", "/notes"),
    claimTasks: (ids) => call("buff", "/notes/ack", { method: "POST", body: { ids } }),
    uploadArtifact: (payload) => call("buff", "/files", { method: "POST", body: payload }),
    buffTasks: (query) => call("buff", "/tasks", { query })
  };
}
