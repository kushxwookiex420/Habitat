import http from "node:http";

/**
 * Minimal express-compatible router over node:http.
 *
 * The production server mounts the same route handlers on express. This harness exists so the
 * acceptance tests make real HTTP requests over a real socket without installing dependencies or
 * needing a deployed service. It implements only the surface those handlers use:
 * app.get/post, req.query/body/params/headers, res.status().json()/send()/end(), and next().
 */
export function createApp() {
  const routes = [];
  const middleware = [];

  const app = {
    get(path, ...handlers) { routes.push({ method: "GET", path, handlers }); },
    post(path, ...handlers) { routes.push({ method: "POST", path, handlers }); },
    use(handler) { middleware.push(handler); },
    routes
  };

  function match(pattern, pathname) {
    const a = pattern.split("/").filter(Boolean);
    const b = pathname.split("/").filter(Boolean);
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) return null;
    }
    return params;
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) throw new Error("request body too large");
      chunks.push(chunk);
    }
    if (!chunks.length) return undefined;
    const text = Buffer.concat(chunks).toString("utf8");
    try { return JSON.parse(text); } catch { return undefined; }
  }

  function decorate(res) {
    res.statusCode = 200;
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => {
      const payload = JSON.stringify(body);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(payload);
      return res;
    };
    res.send = body => {
      if (typeof body === "string") res.end(body);
      else return res.json(body);
      return res;
    };
    res.type = value => { res.setHeader("Content-Type", value); return res; };
    res.setHeader = res.setHeader.bind(res);
    return res;
  }

  async function runChain(handlers, req, res) {
    const dispatch = async index => {
      if (index >= handlers.length) return;
      let advanced = false;
      let pending = null;
      const next = () => {
        advanced = true;
        pending = dispatch(index + 1);
        return pending;
      };
      await handlers[index](req, res, next);
      if (advanced) await pending;
    };
    await dispatch(0);
  }

  const server = http.createServer(async (rawReq, res) => {
    const started = Date.now();
    try {
      const url = new URL(rawReq.url, "http://127.0.0.1");
      const query = Object.fromEntries(url.searchParams.entries());
      const body = rawReq.method === "GET" || rawReq.method === "HEAD" ? undefined : await readBody(rawReq);
      const decorated = decorate(res);
      const baseReq = {
        method: rawReq.method,
        url: rawReq.url,
        headers: rawReq.headers,
        query,
        body,
        params: {}
      };
      for (const mw of middleware) {
        await new Promise((resolve, reject) => {
          try { mw(baseReq, decorated, resolve, reject); } catch (error) { reject(error); }
        });
      }
      let matched = null;
      for (const route of routes) {
        if (route.method !== rawReq.method) continue;
        const params = match(route.path, url.pathname);
        if (params) { matched = { route, params }; break; }
      }
      if (!matched) {
        decorated.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      const req = { ...baseReq, params: matched.params };
      await runChain(matched.route.handlers, req, decorated);
      if (!decorated.writableEnded) {
        decorated.status(404).json({ ok: false, error: "no_response" });
      }
    } catch (error) {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      }
    } finally {
      if (process.env.HABITAT_ACCEPTANCE_TRACE === "1") {
        console.log("HTTP", rawReq.method, rawReq.url, res.statusCode, Date.now() - started + "ms");
      }
    }
  });

  return { app, server };
}

export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return "http://127.0.0.1:" + address.port;
}

export async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(resolve));
}
