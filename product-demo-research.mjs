/**
 * Habitat Product Demonstration Research
 *
 * Searches for product-use footage and returns reviewable candidates.
 * Results are leads, NOT proof of reuse rights. Never download or publish third-party
 * clips unless commercial permission/licence is confirmed.
 */
const SEARCH_TIMEOUT_MS = 12000;
const MAX_QUERY_LENGTH = 180;
const MAX_RESULTS_PER_QUERY = 10;

function clean(value, max = 180) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function absoluteResultUrl(raw) {
  let url = decodeHtml(raw).replace(/&amp;/g, "&");
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const redirect = parsed.searchParams.get("uddg") || parsed.searchParams.get("url");
    if (redirect) url = decodeURIComponent(redirect);
    else url = parsed.href;
  } catch {}
  return /^https?:\/\//i.test(url) ? url : null;
}

// DDG changes its result markup periodically. Parse anchors globally instead of
// depending on one exact <div class="result..."> wrapper.
export function parseDuckDuckGo(html) {
  const source = String(html || "");
  const results = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(source)) && results.length < MAX_RESULTS_PER_QUERY) {
    const attrs = match[1];
    if (!/class=["'][^"']*result__a[^"']*["']/i.test(attrs)) continue;
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1];
    const url = href && absoluteResultUrl(href);
    const title = stripTags(match[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const around = source.slice(Math.max(0, match.index - 1800), Math.min(source.length, anchorPattern.lastIndex + 2600));
    const snippetMatch = around.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    results.push({ title, url, snippet: stripTags(snippetMatch?.[1] || "") });
  }

  // Fallback for the DDG lite layout, which does not always use result__a.
  if (!results.length) {
    const lite = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    while ((match = lite.exec(source)) && results.length < MAX_RESULTS_PER_QUERY) {
      const attrs = match[1] + " " + match[3];
      const href = match[2];
      const title = stripTags(match[4]);
      const url = absoluteResultUrl(href);
      if (!url || !title || !/https?:/i.test(url) || /duckduckgo\.com\/(?:html|lite)/i.test(url)) continue;
      if (/^(?:next|previous|images|videos|news|maps|settings|feedback)$/i.test(title)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ title, url, snippet: "" });
    }
  }
  return results;
}

async function searchWeb(query) {
  const providers = [
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
    "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query)
  ];
  let lastError;
  for (const url of providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HabitatAx/1.1; product-demo research)", "Accept": "text/html" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Search provider returned HTTP " + response.status);
      const html = await response.text();
      const results = parseDuckDuckGo(html);
      if (results.length) return { results, provider: url.includes("/lite/") ? "duckduckgo-lite" : "duckduckgo-html", responseBytes: Buffer.byteLength(html) };
      lastError = new Error("Search page returned no parseable results (" + html.length + " characters)");
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("No search provider returned results");
}

function hostOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function registerProductDemoResearch(app) {
  app.get("/product-demo/status", (_req, res) => res.json({
    ok: true,
    feature: "product-demo-research",
    webSearch: true,
    parserVersion: "1.1-fallback-html-lite",
    automaticThirdPartyDownload: false,
    clipAssembly: "not configured by this research module",
    rightsPolicy: "Search results are leads only; verify commercial reuse permission before editing or publishing."
  }));

  app.post("/product-demo/research", async (req, res) => {
    const productName = clean(req.body?.productName, MAX_QUERY_LENGTH);
    const brand = clean(req.body?.brand, 100);
    const supplierUrl = clean(req.body?.supplierUrl, 500);
    const category = clean(req.body?.category, 100);
    const model = clean(req.body?.model || req.body?.sku, 100);
    if (!productName) return res.status(400).json({ ok: false, error: "productName is required" });

    const base = [brand, productName, model, category].filter(Boolean).join(" ");
    const queries = [
      '"' + base + '" product demonstration video',
      '"' + base + '" how to use video',
      (brand ? brand + " " : "") + productName + " official product video",
      (brand ? brand + " " : "") + productName + " supplier video commercial use",
      '"' + productName + '" review demo hands-on',
      (model ? '"' + model + '" ' : "") + productName + " video product demo"
    ].map(q => clean(q, MAX_QUERY_LENGTH));

    try {
      const settled = await Promise.allSettled(queries.map(searchWeb));
      const candidates = [];
      const seen = new Set();
      const diagnostics = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status !== "fulfilled") {
          diagnostics.push({ query: queries[i], ok: false, error: clean(result.reason?.message || result.reason, 180) });
          continue;
        }
        diagnostics.push({ query: queries[i], ok: true, provider: result.value.provider, responseBytes: result.value.responseBytes, parsedCount: result.value.results.length });
        for (const row of result.value.results) {
          const key = row.url.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const host = hostOf(row.url);
          const officialOrSupplier = /manufacturer|official|supplier|wholesale/i.test(row.title + " " + host) ||
            (supplierUrl && host && host === hostOf(supplierUrl));
          const videoSignal = /video|watch|demo|demonstrat|how.to|review|youtube|vimeo|tiktok|mp4/i.test(row.title + " " + row.url + " " + row.snippet);
          const directVideo = /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(row.url);
          candidates.push({
            ...row, host, query: queries[i],
            sourcePriority: officialOrSupplier ? "check-first" : "review",
            mediaTypeHint: directVideo ? "direct-video-candidate" : videoSignal ? "video-page-candidate" : "ordinary-page",
            rightsStatus: "UNVERIFIED — do not reuse until commercial permission/licence is confirmed",
            recommendedNextStep: "Open the source; confirm exact product, video ownership, and written commercial reuse permission."
          });
          if (candidates.length >= 30) break;
        }
      }
      const supplierHost = supplierUrl ? hostOf(supplierUrl) : null;
      return res.json({
        ok: true,
        product: { productName, brand: brand || null, model: model || null, category: category || null, supplierUrl: supplierUrl || null, supplierHost },
        searchedAt: new Date().toISOString(),
        parserVersion: "1.1-fallback-html-lite",
        queries,
        diagnostics,
        candidates,
        candidateCount: candidates.length,
        videoPageCandidateCount: candidates.filter(c => c.mediaTypeHint === "video-page-candidate" || c.mediaTypeHint === "direct-video-candidate").length,
        directVideoCandidateCount: candidates.filter(c => c.mediaTypeHint === "direct-video-candidate").length,
        searchProviderFailures: diagnostics.filter(d => !d.ok).length,
        nextStep: candidates.length
          ? "Review candidates and confirm rights. This endpoint discovers sources; it does not download, trim, or publish clips."
          : "No results parsed. Inspect diagnostics, then try exact model/SKU, alternate product names, or the supplier's media library.",
        safety: { reuseAllowedBySearchResult: false, requiresPermissionCheck: true, neverPublishUnverifiedFootage: true }
      });
    } catch (error) {
      return res.status(502).json({ ok: false, error: "Product demonstration search failed", details: clean(error?.message || error, 240) });
    }
  });

  app.post("/product-demo/clip-plan", (req, res) => {
    const sourceUrl = clean(req.body?.sourceUrl, 1000);
    const durationSeconds = Number(req.body?.durationSeconds);
    const startSeconds = Number(req.body?.startSeconds);
    const endSeconds = Number(req.body?.endSeconds);
    const permissionConfirmed = req.body?.permissionConfirmed === true;
    let parsed;
    try { parsed = new URL(sourceUrl); } catch {}
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ ok: false, error: "A valid http(s) sourceUrl is required" });
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400 ||
        !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
        startSeconds < 0 || endSeconds <= startSeconds || endSeconds > durationSeconds) {
      return res.status(400).json({ ok: false, error: "Clip times must satisfy 0 <= start < end <= durationSeconds" });
    }
    if (!permissionConfirmed) {
      return res.status(403).json({
        ok: false,
        error: "Commercial reuse permission must be explicitly confirmed before creating an assembly-ready clip plan.",
        rightsStatus: "UNVERIFIED"
      });
    }
    return res.json({
      ok: true,
      clipPlan: {
        sourceUrl, startSeconds, endSeconds,
        durationSeconds: Number((endSeconds - startSeconds).toFixed(2)),
        permissionConfirmed: true,
        status: "READY_FOR_MEDIA_WORKER",
        note: "This validates a clip edit decision list only. A media worker with authorized source access and FFmpeg is still required to render the clip."
      }
    });
  });
}
