/**
 * Contract checks for the Ax OpenAPI document served at /ax/command/openapi.json.
 *
 * This module validates three things that a document-only lint cannot:
 *   1. the document is a valid OpenAPI 3.1 description that OpenAI's Action importer accepts
 *      (unique operationIds, bounded descriptions, declared path parameters, no 3.0 `nullable`);
 *   2. every endpoint it advertises is actually registered by `command-routes.mjs` — no invented
 *      endpoints — and every registered `/ax/command` route is either documented or explicitly
 *      excluded with a reason;
 *   3. the document carries no credential and every server URL is HTTPS (loopback is allowed only
 *      for local checks).
 *
 * It never reads a token and never reports a matched secret value.
 */

export const OPENAPI_LIMITS = Object.freeze({
  descriptionMax: 300,
  operationIdMax: 128
});

export const HTTP_METHODS = Object.freeze(["get", "post", "put", "patch", "delete", "head", "options"]);

const SECRET_PATTERNS = Object.freeze([
  { name: "habitat ax token", pattern: /\bax(?:cmd|bridge|nexus)_[A-Za-z0-9_-]{8,}/i },
  { name: "openai api key", pattern: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { name: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9]{12,}/ },
  { name: "bearer credential", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { name: "owner device token", pattern: /x-owner-device-token"?\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}/i }
]);

/**
 * Routes that are deliberately outside the ChatGPT-facing contract. Each rule carries the reason
 * so a future route cannot be added without a decision: an unclassified route fails the check.
 */
const EXCLUSIONS = Object.freeze([
  {
    test: key => key.endsWith(" /ax/command/openapi.json"),
    reason: "the document itself; public and unauthenticated"
  },
  {
    test: key => / \/ax\/nexus(\/|$)/.test(key),
    reason: "NEXUS surface guarded by AX_NEXUS_TOKEN; an Ax client must never receive it"
  },
  {
    test: key => / \/ax\/command\/network(\/|$)/.test(key),
    reason: "capability network, supplier catalog, approvals and treasury; decisions need the paired owner device and are never exposed to ChatGPT"
  },
  {
    test: key => / \/ax\/command\/(memory|notifications|history)(\/|$)/.test(key),
    reason: "operator memory, inbox and mission history; not needed to submit or follow work"
  },
  {
    test: key => / \/ax\/command\/(runs|agents|objectives|projects|roles)(\/|$)/.test(key),
    reason: "Habitat-native orchestration and operator views; the Action contract stays narrow"
  },
  {
    test: key => / \/ax\/command\/(recovery|providers|diagnostics|scheduler|security|device)(\/|$)/.test(key),
    reason: "operator diagnostics, recovery, scheduler and device control; never exposed to ChatGPT"
  },
  {
    test: key => / \/ax\/command\/tasks\/:[^/]+\/(plan|checkpoint|approval|approve|deny|complete|fail|cancel|retry)$/.test(key),
    reason: "task state transitions belong to the owner or the fenced worker, not to a model"
  },
  {
    test: key => key === "GET /ax/command/messages/:id",
    reason: "single-message read is covered by getNexusThread; keeps the Action surface minimal"
  }
]);

export function specOperations(spec) {
  const operations = [];
  for (const [path, item] of Object.entries(spec?.paths || {})) {
    for (const [method, operation] of Object.entries(item || {})) {
      if (!HTTP_METHODS.includes(method)) continue;
      operations.push({ method: method.toUpperCase(), path, operationId: operation?.operationId || null });
    }
  }
  return operations.sort((a, b) => (a.path + " " + a.method).localeCompare(b.path + " " + b.method));
}

/** `/ax/command/tasks/:id` -> `/ax/command/tasks/{id}` */
export function expressToSpecPath(path) {
  return String(path).replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** `/ax/command/tasks/{id}` -> `/ax/command/tasks/:id` */
export function specToExpressPath(path) {
  return String(path).replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
}

export function routeKey(method, path) {
  return String(method).toUpperCase() + " " + String(path);
}

/**
 * Express 5 keeps the router on `app.router`; Express 4 used `app._router`. Both are read so the
 * check works against either, and a missing router is reported instead of silently passing.
 */
export function expressRouteKeys(app) {
  const stack = app?.router?.stack || app?._router?.stack || [];
  const keys = [];
  for (const layer of stack) {
    if (!layer?.route) continue;
    for (const method of Object.keys(layer.route.methods || {})) {
      if (!HTTP_METHODS.includes(method)) continue;
      keys.push(routeKey(method, layer.route.path));
    }
  }
  return [...new Set(keys)].sort();
}

export function classifyRouteKey(key) {
  for (const rule of EXCLUSIONS) {
    if (rule.test(key)) return { documented: false, allowed: true, reason: rule.reason };
  }
  return { documented: false, allowed: false, reason: null };
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function templateParameters(path) {
  return [...String(path).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]);
}

/** Returns the file paths of every `nullable` keyword; OpenAPI 3.1 uses a type union instead. */
function findNullableKeyword(value, at = "$") {
  const found = [];
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findNullableKeyword(item, at + "[" + index + "]")));
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "nullable") found.push(at + ".nullable");
    else found.push(...findNullableKeyword(item, at + "." + key));
  }
  return found;
}

/**
 * Reports matched secret-shaped strings by pattern name and JSON path only. The matched value is
 * never returned, so a failing check cannot leak the credential it found.
 */
export function scanForSecrets(value, at = "$") {
  const findings = [];
  const walk = (node, location) => {
    if (typeof node === "string") {
      for (const rule of SECRET_PATTERNS) {
        if (rule.pattern.test(node)) findings.push({ pattern: rule.name, path: location });
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, location + "[" + index + "]"));
      return;
    }
    for (const [key, item] of Object.entries(node)) walk(item, location + "." + key);
  };
  walk(value, at);
  return findings;
}

export function validateSpec(spec, { allowLoopbackHttp = true } = {}) {
  const errors = [];
  const warnings = [];
  const fail = message => errors.push(message);

  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, errors: ["the document is not an object"], warnings };
  }
  if (spec.openapi !== "3.1.0") fail("openapi must be exactly 3.1.0 (got " + JSON.stringify(spec.openapi) + ")");
  if (!spec.info || typeof spec.info !== "object") fail("info is required");
  else {
    if (typeof spec.info.title !== "string" || !spec.info.title.trim()) fail("info.title is required");
    if (typeof spec.info.version !== "string" || !spec.info.version.trim()) fail("info.version is required");
  }

  if (!Array.isArray(spec.servers) || spec.servers.length === 0) fail("servers must contain at least one origin");
  else {
    for (const server of spec.servers) {
      let url = null;
      try { url = new URL(String(server?.url || "")); } catch { fail("server url is not absolute: " + String(server?.url)); continue; }
      if (url.username || url.password) fail("server url must not embed credentials: " + url.origin);
      if (url.search || url.hash) fail("server url must not carry a query or fragment: " + server.url);
      const loopback = isLoopbackHost(url.hostname);
      if (url.protocol !== "https:" && !(loopback && allowLoopbackHttp)) {
        fail("server url must be HTTPS unless it is loopback: " + server.url);
      }
    }
  }

  const schemes = spec?.components?.securitySchemes || {};
  const bearer = schemes.bearerAuth;
  if (!bearer) fail("components.securitySchemes.bearerAuth is required");
  else {
    if (bearer.type !== "http") fail("bearerAuth.type must be http");
    if (String(bearer.scheme || "").toLowerCase() !== "bearer") fail("bearerAuth.scheme must be bearer");
    if (Object.prototype.hasOwnProperty.call(bearer, "bearerFormat") && typeof bearer.bearerFormat !== "string") {
      fail("bearerAuth.bearerFormat must be a string when present");
    }
  }
  const globalSecurity = Array.isArray(spec.security) ? spec.security : [];
  if (!globalSecurity.some(entry => entry && Array.isArray(entry.bearerAuth))) {
    fail("a global security requirement for bearerAuth is required");
  }

  const operationIds = new Set();
  const operations = specOperations(spec);
  if (operations.length === 0) fail("the document declares no operations");

  for (const [path, item] of Object.entries(spec.paths || {})) {
    if (!path.startsWith("/")) fail("path must start with /: " + path);
    if (path.includes(":") && !path.includes("{")) fail("path uses Express syntax instead of an OpenAPI template: " + path);
    if (/^\/*$/.test(path)) fail("path must not be the root: " + path);
    if (path.startsWith("/ax/nexus")) fail("the NEXUS surface must never appear in the Ax document: " + path);
    if (path !== "/ax/command/openapi.json" && !path.startsWith("/ax/command/")) {
      fail("unexpected path outside /ax/command: " + path);
    }
    const expectedParams = new Set(templateParameters(path));
    for (const [method, operation] of Object.entries(item || {})) {
      if (!HTTP_METHODS.includes(method)) {
        warnings.push("ignored non-method key " + path + " " + method);
        continue;
      }
      const label = method.toUpperCase() + " " + path;
      if (!operation || typeof operation !== "object") { fail("operation is not an object: " + label); continue; }

      const operationId = operation.operationId;
      if (typeof operationId !== "string" || !operationId.trim()) fail("operationId is required: " + label);
      else if (operationId.length > OPENAPI_LIMITS.operationIdMax) fail("operationId is too long: " + label);
      else if (operationIds.has(operationId)) fail("operationId is duplicated: " + operationId);
      else operationIds.add(operationId);

      if (typeof operation.summary !== "string" || !operation.summary.trim()) fail("summary is required: " + label);
      if (typeof operation.description === "string" && operation.description.length > OPENAPI_LIMITS.descriptionMax) {
        fail("description exceeds " + OPENAPI_LIMITS.descriptionMax + " characters: " + label);
      } else if (operation.description === undefined) {
        warnings.push("no description: " + label);
      }
      if (Object.prototype.hasOwnProperty.call(operation, "x-openai-isConsequential") &&
          typeof operation["x-openai-isConsequential"] !== "boolean") {
        fail("x-openai-isConsequential must be a boolean: " + label);
      }

      const responses = operation.responses;
      if (!responses || typeof responses !== "object" || Array.isArray(responses) || Object.keys(responses).length === 0) {
        fail("responses are required: " + label);
      } else {
        for (const code of Object.keys(responses)) {
          if (!/^(?:[1-5]\d{2}|default)$/.test(code)) fail("invalid response code " + code + ": " + label);
        }
      }

      if (operation.requestBody && !operation.requestBody?.content?.["application/json"]) {
        fail("requestBody must declare application/json: " + label);
      }

      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const declaredPath = new Map();
      for (const parameter of parameters) {
        if (!parameter || typeof parameter !== "object") { fail("parameter is not an object: " + label); continue; }
        if (!["path", "query", "header", "cookie"].includes(parameter.in)) fail("invalid parameter location: " + label);
        if (parameter.in === "path") {
          if (!expectedParams.has(parameter.name)) fail("path parameter " + parameter.name + " is not in the template: " + label);
          if (parameter.required !== true) fail("path parameter must be required: " + parameter.name + " in " + label);
          declaredPath.set(parameter.name, (declaredPath.get(parameter.name) || 0) + 1);
        }
      }
      for (const name of expectedParams) {
        if (!declaredPath.has(name)) fail("path parameter " + name + " is not declared: " + label);
        if (declaredPath.get(name) > 1) fail("path parameter " + name + " is declared more than once: " + label);
      }
    }
  }

  for (const location of findNullableKeyword(spec)) {
    fail("`nullable` is OpenAPI 3.0 syntax and is invalid in 3.1; use a type union (" + location + ")");
  }
  for (const finding of scanForSecrets(spec)) {
    fail("the document contains a " + finding.pattern + " at " + finding.path);
  }

  return { ok: errors.length === 0, errors, warnings, operations: operations.length };
}

/**
 * Compares the document with the routes the real module registered.
 * `routeKeys` is a list of `"METHOD /path"` strings from `expressRouteKeys(app)`.
 */
export function compareSpecToRoutes(spec, routeKeys) {
  const errors = [];
  const implemented = new Set(routeKeys);
  const documented = new Set();
  for (const { method, path } of specOperations(spec)) {
    const key = routeKey(method, specToExpressPath(path));
    documented.add(key);
    if (!implemented.has(key)) errors.push("documented but not implemented: " + key);
  }
  const excluded = [];
  for (const key of implemented) {
    if (documented.has(key)) continue;
    const classification = classifyRouteKey(key);
    if (classification.allowed) excluded.push({ route: key, reason: classification.reason });
    else errors.push("implemented but neither documented nor excluded: " + key);
  }
  return {
    ok: errors.length === 0,
    errors,
    documented: [...documented].sort(),
    implemented: implemented.size,
    excluded
  };
}

export function checkAxContract({ spec, routeKeys, allowLoopbackHttp = true }) {
  const validation = validateSpec(spec, { allowLoopbackHttp });
  const parity = compareSpecToRoutes(spec, routeKeys);
  const errors = [...validation.errors, ...parity.errors];
  return {
    ok: errors.length === 0,
    errors,
    warnings: validation.warnings,
    validation,
    parity
  };
}
