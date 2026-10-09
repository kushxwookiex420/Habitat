/**
 * Habitat Product Demonstration Research
 *
 * Searches the public web for product-use footage and returns reviewable candidates.
 * Search results are leads, NOT proof of reuse rights. Never download or publish a
 * third-party clip unless permission/licence is confirmed by a human or trusted source.
 */
const SEARCH_TIMEOUT_MS = 12000;
const MAX_QUERY_LENGTH = 180;

function clean(value, max = 180) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function parseDuckDuckGo(html) {
  const results = [];
  const blocks = String(html || "").split(/<div class="result[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= 8) break;
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a/i);
    const title = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    if (!link || !title) continue;
    let url = decodeHtml(link[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch {} }
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: decodeHtml(title[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
      url,
      snippet: decodeHtml((snippet?.[1] || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
    });
  }
  return results;
}

async function searchWeb(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HabitatAx/1.0; product-demo research)" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error("Search provider returned HTTP " + response.status);
    return parseDuckDuckGo(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

export function registerProductDemoResearch(app) {
  app.get("/product-demo/status", (_req, res) => res.json({
    ok: true,
    feature: "product-demo-research",
    webSearch: true,
    automaticThirdPartyDownload: false,
    clipAssembly: "not configured by this research module",
    rightsPolicy: "Search results are leads only; verify commercial reuse permission before editing or publishing."
  }));

  app.post("/product-demo/research", async (req, res) => {
    const productName = clean(req.body?.productName, MAX_QUERY_LENGTH);
    const brand = clean(req.body?.brand, 100);
    const supplierUrl = clean(req.body?.supplierUrl, 500);
    const category = clean(req.body?.category, 100);
    if (!productName) return res.status(400).json({ ok: false, error: "productName is required" });

    const base = [brand, productName, category].filter(Boolean).join(" ");
    const queries = [
      '"' + base + '" product demonstration video',
      '"' + base + '" how to use video',
      (brand ? brand + " " : "") + productName + " official product video",
      (brand ? brand + " " : "") + productName + " supplier video commercial use"
    ];
    try {
      const settled = await Promise.allSettled(queries.map(searchWeb));
      const candidates = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status !== "fulfilled") continue;
        for (const row of result.value) {
          const key = row.url.toLowerCase();
          if (candidates.some(item => item.url.toLowerCase() === key)) continue;
          const host = (() => { try { return new URL(row.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
          const supplierOrOfficial = /manufacturer|official|supplier|wholesale/i.test(row.title + " " + host);
          candidates.push({
            ...row,
            host,
            query: queries[i],
            sourcePriority: supplierOrOfficial ? "check-first" : "review",
            rightsStatus: "UNVERIFIED — do not reuse until commercial permission/licence is confirmed",
            recommendedNextStep: "Open the source and verify the exact product, owner, and written commercial reuse permission."
          });
          if (candidates.length >= 20) break;
        }
        if (candidates.length >= 20) break;
      }
      const suppliedHost = (() => { try { return supplierUrl ? new URL(supplierUrl).hostname : null; } catch { return null; } })();
      return res.json({
        ok: true,
        product: { productName, brand: brand || null, category: category || null, supplierUrl: supplierUrl || null, supplierHost: suppliedHost },
        searchedAt: new Date().toISOString(),
        queries,
        candidates,
        candidateCount: candidates.length,
        searchProviderFailures: settled.filter(x => x.status === "rejected").length,
        nextStep: candidates.length
          ? "Review candidates and confirm rights. This endpoint discovers footage; it does not download, trim, or publish clips."
          : "No results parsed. Try the exact supplier model/SKU, alternate product names, or a direct supplier media library.",
        safety: {
          reuseAllowedBySearchResult: false,
          requiresPermissionCheck: true,
          neverPublishUnverifiedFootage: true
        }
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
        sourceUrl,
        startSeconds,
        endSeconds,
        durationSeconds: Number((endSeconds - startSeconds).toFixed(2)),
        permissionConfirmed: true,
        status: "READY_FOR_MEDIA_WORKER",
        note: "This validates a clip edit decision list only. A media worker with authorized source access and FFmpeg is still required to render the clip."
      }
    });
  });
}
