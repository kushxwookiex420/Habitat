import crypto from "node:crypto";

export const SHOPIFY_REDIRECT_URI = "https://habitat-1-szzd.onrender.com/auth/shopify/callback";
export const SHOPIFY_SCOPES = ["read_products"];
const STATE_TTL_MS = 10 * 60 * 1000;
const API_VERSION = "2026-07";

function readCookie(req, name) {
  for (const item of String(req.headers?.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) {
      try { return decodeURIComponent(item.slice(index + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

function setStateCookie(res, state) {
  res.setHeader("Set-Cookie", `habitat_shopify_state=${encodeURIComponent(state)}; Max-Age=600; Path=/auth/shopify; HttpOnly; Secure; SameSite=Lax`);
}
function clearStateCookie(res) {
  res.setHeader("Set-Cookie", "habitat_shopify_state=; Max-Age=0; Path=/auth/shopify; HttpOnly; Secure; SameSite=Lax");
}

export function normalizeShopDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : "";
}

export function buildShopifyAuthorizationUrl({ shop, clientId, state, redirectUri = SHOPIFY_REDIRECT_URI }) {
  const domain = normalizeShopDomain(shop);
  if (!domain) throw new Error("A valid *.myshopify.com shop domain is required.");
  const url = new URL(`https://${domain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", String(clientId || "").trim());
  url.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", String(state || ""));
  return url.toString();
}

export function verifyShopifyCallbackHmac(query, clientSecret) {
  const hmac = String(query?.hmac || "");
  if (!/^[a-f0-9]{64}$/i.test(hmac) || !String(clientSecret || "")) return false;
  const message = Object.keys(query)
    .filter(key => key !== "hmac" && key !== "signature")
    .sort()
    .map(key => `${key}=${Array.isArray(query[key]) ? query[key].join(",") : String(query[key])}`)
    .join("&");
  const digest = crypto.createHmac("sha256", String(clientSecret)).update(message).digest();
  const provided = Buffer.from(hmac, "hex");
  return provided.length === digest.length && crypto.timingSafeEqual(provided, digest);
}

function queryFromRequest(req) {
  if (typeof req.originalUrl === "string") {
    try {
      const url = new URL(req.originalUrl, "https://habitat.invalid");
      const out = {};
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(out, key)) out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
        else out[key] = value;
      }
      return out;
    } catch {}
  }
  return req.query || {};
}

export function buildShopifyStatus({ clientId, clientSecret, token, vaultReady }) {
  const credentialsConfigured = Boolean(String(clientId || "").trim() && String(clientSecret || "").trim());
  return {
    ok: true,
    configured: credentialsConfigured,
    credentialsConfigured,
    durableStorageReady: vaultReady === true,
    canConnect: credentialsConfigured && vaultReady === true,
    connected: Boolean(token?.access_token && normalizeShopDomain(token?.shop)),
    shop: token?.shop || null,
    scopes: token?.scope ? String(token.scope).split(/[ ,]+/).filter(Boolean) : SHOPIFY_SCOPES,
    tokenStorage: vaultReady === true ? "cloudflare-d1-aes-256-gcm" : "unavailable",
    connectedAt: token?.connected_at || null,
    note: !credentialsConfigured ? "Shopify client credentials are missing."
      : vaultReady !== true ? "Durable encrypted token storage is unavailable."
      : token?.access_token ? "Shopify token is stored. Run the product catalog test to verify access."
      : "Ready to authorize a Shopify store."
  };
}

export function registerShopifyOAuth(app, secretVault = null, { fetchImpl = fetch } = {}) {
  const vaultReady = secretVault?.durable === true &&
    typeof secretVault.get === "function" && typeof secretVault.set === "function" &&
    typeof secretVault.delete === "function";

  app.get("/auth/shopify/status", async (req, res) => {
    try {
      const shop = normalizeShopDomain(req.query?.shop);
      const token = vaultReady && shop ? await secretVault.get("shopify_tokens:" + shop) : null;
      return res.json(buildShopifyStatus({
        clientId: process.env.SHOPIFY_API_KEY,
        clientSecret: process.env.SHOPIFY_API_SECRET,
        token,
        vaultReady
      }));
    } catch (error) {
      console.error("SHOPIFY_STATUS_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, configured: Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET), connected: false, error: "Shopify connection status could not be read securely." });
    }
  });

  app.get("/auth/shopify", async (req, res) => {
    const clientId = String(process.env.SHOPIFY_API_KEY || "").trim();
    const clientSecret = String(process.env.SHOPIFY_API_SECRET || "").trim();
    const shop = normalizeShopDomain(req.query?.shop);
    if (!clientId || !clientSecret) return res.status(503).type("text/plain").send("Shopify client credentials are missing from Habitat runtime configuration.");
    if (!shop) return res.status(400).type("text/plain").send("Provide your store's exact *.myshopify.com domain, for example store-name.myshopify.com.");
    if (!vaultReady) return res.status(503).type("text/plain").send("Habitat encrypted durable storage is unavailable; Shopify authorization was not started.");
    const state = crypto.randomBytes(32).toString("hex");
    try {
      await secretVault.set("shopify_oauth_state:" + state, { state, shop, expiresAt: Date.now() + STATE_TTL_MS });
      setStateCookie(res, state);
      return res.redirect(302, buildShopifyAuthorizationUrl({ shop, clientId, state }));
    } catch (error) {
      console.error("SHOPIFY_STATE_SAVE_FAILED", String(error?.message || error));
      return res.status(503).type("text/plain").send("Habitat could not securely save Shopify authorization state. Please retry.");
    }
  });

  app.get("/auth/shopify/callback", async (req, res) => {
    const query = queryFromRequest(req);
    clearStateCookie(res);
    const clientSecret = String(process.env.SHOPIFY_API_SECRET || "").trim();
    if (query.error) return res.status(400).type("text/plain").send("Shopify authorization was declined or failed.");
    if (!verifyShopifyCallbackHmac(query, clientSecret)) return res.status(400).type("text/plain").send("Shopify callback signature check failed. Restart Connect Shopify from Habitat.");
    const shop = normalizeShopDomain(query.shop);
    if (!shop || !query.code || !query.state) return res.status(400).type("text/plain").send("Shopify callback is missing required authorization fields.");
    if (!vaultReady) return res.status(503).type("text/plain").send("Encrypted durable storage is unavailable; authorization cannot be completed safely.");
    if (readCookie(req, "habitat_shopify_state") !== String(query.state)) return res.status(400).type("text/plain").send("Shopify authorization state check failed. Restart Connect Shopify.");
    const stateKey = "shopify_oauth_state:" + String(query.state);
    let savedState;
    try {
      savedState = await secretVault.get(stateKey);
      await secretVault.delete(stateKey);
    } catch (error) {
      console.error("SHOPIFY_STATE_READ_FAILED", String(error?.message || error));
      return res.status(503).type("text/plain").send("Habitat could not verify Shopify authorization state in durable storage.");
    }
    if (!savedState || savedState.state !== String(query.state) || savedState.shop !== shop ||
        !Number.isFinite(Number(savedState.expiresAt)) || Date.now() > Number(savedState.expiresAt)) {
      return res.status(400).type("text/plain").send("Shopify authorization state expired or was already used. Restart Connect Shopify.");
    }
    const clientId = String(process.env.SHOPIFY_API_KEY || "").trim();
    if (!clientId || !clientSecret) return res.status(503).type("text/plain").send("Shopify client credentials are missing.");
    try {
      const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: String(query.code) }),
        signal: AbortSignal.timeout(20000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.access_token) {
        console.error("SHOPIFY_TOKEN_EXCHANGE_FAILED", JSON.stringify({ shop, httpStatus: response.status, error: String(payload?.error || payload?.error_description || "token exchange rejected").slice(0, 180) }));
        return res.status(502).type("text/plain").send("Shopify authorization returned, but token exchange failed. Check Habitat Render logs for SHOPIFY_TOKEN_EXCHANGE_FAILED.");
      }
      const bundle = {
        shop,
        access_token: String(payload.access_token),
        scope: String(payload.scope || SHOPIFY_SCOPES.join(",")),
        expires_in: payload.expires_in ? Number(payload.expires_in) : null,
        refresh_token: payload.refresh_token ? String(payload.refresh_token) : null,
        refresh_token_expires_in: payload.refresh_token_expires_in ? Number(payload.refresh_token_expires_in) : null,
        connected_at: new Date().toISOString()
      };
      await secretVault.set("shopify_tokens:" + shop, bundle);
      console.log("SHOPIFY_OAUTH_CONNECTED", JSON.stringify({ shop, scopes: bundle.scope.split(/[ ,]+/).filter(Boolean), tokenPresent: true }));
      return res.type("text/html").send("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Shopify connected</title></head><body style=\"font-family:system-ui;max-width:640px;margin:48px auto;padding:20px\"><h1>Shopify authorization completed</h1><p>Habitat securely stored the Shopify token. Next, test the product catalog before treating the connection as verified.</p><p><a href=\"/auth/shopify/status?shop=" + encodeURIComponent(shop) + "\">Check connection status</a> · <a href=\"/shopify/products?shop=" + encodeURIComponent(shop) + "\">Test product catalog</a></p></body></html>");
    } catch (error) {
      console.error("SHOPIFY_TOKEN_EXCHANGE_ERROR", String(error?.message || error).slice(0, 200));
      return res.status(502).type("text/plain").send("Habitat could not complete Shopify token exchange. Check Render logs and retry.");
    }
  });

  app.get("/shopify/products", async (req, res) => {
    const shop = normalizeShopDomain(req.query?.shop);
    if (!shop) return res.status(400).json({ ok: false, error: "A valid *.myshopify.com shop domain is required." });
    if (!vaultReady) return res.status(503).json({ ok: false, error: "Encrypted durable token storage is unavailable." });
    let token;
    try { token = await secretVault.get("shopify_tokens:" + shop); }
    catch (error) {
      console.error("SHOPIFY_TOKEN_READ_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Shopify token storage could not be read." });
    }
    if (!token?.access_token) return res.status(401).json({ ok: false, connected: false, error: "Shopify is not connected for this store. Authorize it first at /auth/shopify?shop=YOUR-STORE.myshopify.com." });
    try {
      const response = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token.access_token },
        body: JSON.stringify({ query: "query HabitatCatalogRead($after: String) { products(first: 100, after: $after, sortKey: UPDATED_AT, reverse: true) { edges { node { id title handle vendor status totalInventory featuredImage { url altText } priceRangeV2 { minVariantPrice { amount currencyCode } } } } pageInfo { hasNextPage endCursor } } }", variables: { after: typeof req.query?.cursor === "string" && req.query.cursor.length <= 2048 ? req.query.cursor : null } }),
        signal: AbortSignal.timeout(20000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.errors?.length) {
        console.error("SHOPIFY_CATALOG_READ_FAILED", JSON.stringify({ shop, httpStatus: response.status, errors: (payload?.errors || []).map(e => String(e?.message || "GraphQL error").slice(0, 180)) }));
        return res.status(502).json({ ok: false, connected: true, error: "Shopify authorized Habitat, but the catalog query failed. Check the granted read_products scope and Render logs." });
      }
      const edges = payload?.data?.products?.edges;
      if (!Array.isArray(edges)) return res.status(502).json({ ok: false, connected: true, error: "Shopify returned an unexpected catalog response." });
      return res.json({
        ok: true, connected: true, shop, apiVersion: API_VERSION,
        scopes: String(token.scope || "").split(/[ ,]+/).filter(Boolean),
        productCountReturned: edges.length,
        hasNextPage: Boolean(payload?.data?.products?.pageInfo?.hasNextPage),
        endCursor: payload?.data?.products?.pageInfo?.endCursor || null,
        products: edges.map(({ node }) => ({
          id: node.id, title: node.title, handle: node.handle, vendor: node.vendor,
          status: node.status, inventory: node.totalInventory,
          image: node.featuredImage?.url || null, imageAlt: node.featuredImage?.altText || null,
          price: node.priceRangeV2?.minVariantPrice?.amount || null,
          currency: node.priceRangeV2?.minVariantPrice?.currencyCode || null
        }))
      });
    } catch (error) {
      console.error("SHOPIFY_CATALOG_READ_ERROR", String(error?.message || error).slice(0, 180));
      return res.status(502).json({ ok: false, connected: true, error: "Habitat could not reach Shopify's catalog API. Retry after checking Render logs." });
    }

  app.get("/shopify/audit", async (req, res) => {
    const shop = normalizeShopDomain(req.query?.shop);
    if (!shop) return res.status(400).json({ ok: false, error: "A valid *.myshopify.com shop domain is required." });
    if (!vaultReady) return res.status(503).json({ ok: false, error: "Encrypted durable token storage is unavailable." });
    let token;
    try { token = await secretVault.get("shopify_tokens:" + shop); }
    catch (error) {
      console.error("SHOPIFY_AUDIT_TOKEN_READ_FAILED", String(error?.message || error));
      return res.status(503).json({ ok: false, error: "Shopify token storage could not be read." });
    }
    if (!token?.access_token) return res.status(401).json({ ok: false, connected: false, error: "Shopify is not connected for this store." });
    try {
      const products = [];
      let cursor = null;
      let hasNextPage = true;
      let pageCount = 0;
      while (hasNextPage && pageCount < 100) {
        const response = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token.access_token },
          body: JSON.stringify({
            query: "query HabitatCatalogAudit($after: String) { products(first: 100, after: $after, sortKey: UPDATED_AT, reverse: true) { edges { node { id title handle vendor status totalInventory priceRangeV2 { minVariantPrice { amount currencyCode } } } } pageInfo { hasNextPage endCursor } } }",
            variables: { after: cursor }
          }),
          signal: AbortSignal.timeout(20000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.errors?.length || !Array.isArray(payload?.data?.products?.edges)) {
          console.error("SHOPIFY_CATALOG_AUDIT_PAGE_FAILED", JSON.stringify({ shop, pageCount, httpStatus: response.status }));
          return res.status(502).json({ ok: false, connected: true, error: "Catalog audit stopped because Shopify returned an incomplete page; no partial audit is reported." });
        }
        const connection = payload.data.products;
        for (const edge of connection.edges) {
          const node = edge.node;
          products.push({
            id: node.id, title: node.title, handle: node.handle, vendor: node.vendor,
            status: String(node.status || "UNKNOWN").toUpperCase(),
            inventory: Number.isFinite(Number(node.totalInventory)) ? Number(node.totalInventory) : null,
            price: node.priceRangeV2?.minVariantPrice?.amount || null,
            currency: node.priceRangeV2?.minVariantPrice?.currencyCode || null
          });
        }
        hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
        cursor = connection.pageInfo?.endCursor || null;
        pageCount += 1;
        if (hasNextPage && !cursor) {
          return res.status(502).json({ ok: false, connected: true, error: "Shopify pagination cursor was missing; no partial audit is reported." });
        }
      }
      if (hasNextPage) return res.status(502).json({ ok: false, connected: true, error: "Catalog exceeds the safe audit page limit; no partial audit is reported." });
      const count = status => products.filter(product => product.status === status).length;
      const activeOutOfStock = products.filter(product => product.status === "ACTIVE" && product.inventory !== null && product.inventory <= 0);
      const activeUnknownInventory = products.filter(product => product.status === "ACTIVE" && product.inventory === null);
      return res.json({
        ok: true, complete: true, shop, apiVersion: API_VERSION, pagesRead: pageCount,
        totalProducts: products.length,
        counts: { active: count("ACTIVE"), draft: count("DRAFT"), archived: count("ARCHIVED"), other: products.length - count("ACTIVE") - count("DRAFT") - count("ARCHIVED") },
        activeOutOfStockCount: activeOutOfStock.length,
        activeUnknownInventoryCount: activeUnknownInventory.length,
        activeOutOfStock,
        activeUnknownInventory,
        note: "Inventory is the Shopify catalog snapshot, not a supplier fulfillment guarantee. Supplier cost, shipping, and fees require separate verification."
      });
    } catch (error) {
      console.error("SHOPIFY_CATALOG_AUDIT_ERROR", String(error?.message || error).slice(0, 180));
      return res.status(502).json({ ok: false, connected: true, error: "Habitat could not complete the Shopify catalog audit. Retry after checking Render logs." });
    }
  });
  });
}
