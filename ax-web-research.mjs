import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Secure web research transport.
 *
 * The network is the most dangerous dependency in NEXUS: an objective can name any URL, and a fetched
 * page is untrusted data. This module therefore:
 *
 *   - accepts HTTPS only (loopback HTTP is allowed only when a test explicitly opts in);
 *   - rejects credentials in the URL and non-standard ports;
 *   - resolves the hostname and refuses every private, loopback, link-local, multicast and reserved
 *     address, so `169.254.169.254`, `127.0.0.1`, `10.x`, `[::1]` and a DNS name that points at them
 *     are all refused before a request is made;
 *   - follows at most three redirects, re-validating each hop (a public URL that redirects to a
 *     private one is still refused);
 *   - bounds the response by content type and byte count, and reports truncation instead of silently
 *     returning a partial page as complete;
 *   - keeps source attribution: final URL, title, excerpt, SHA-256 digest, retrieval time, HTTP
 *     status, content type and confidence.
 *
 * Contradictory sources are preserved, never resolved by this module. `divergences` flags pairs that
 * share terms but differ in polarity as "review needed"; it is a signal, not a verdict.
 */

export const WEB_RESEARCH_LIMITS = Object.freeze({
  maxBytes: 400_000,
  timeoutMs: 10_000,
  maxRedirects: 3,
  maxSources: 4,
  excerptChars: 480,
  maxUrlChars: 2_000
});

const ALLOWED_CONTENT = /^(text\/html|text\/plain|application\/(ld\+json|json|xml))/i;
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata"]);
const NEGATIVE = /\b(not|no|never|none|false|incorrect|unavailable|unsupported|fails?|failed|without|cannot|can't|denied)\b/i;

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** IPv4/IPv6 literal or resolved address that must never be contacted. */
export function isPrivateAddress(address) {
  const value = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return true;
  const mapped = value.startsWith("::ffff:") ? value.slice(7) : value;
  if (isIP(mapped) === 4) {
    const [a, b] = mapped.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (isIP(mapped) === 6) {
    if (mapped === "::" || mapped === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(mapped)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(mapped)) return true; // fe80::/10
    if (mapped.startsWith("ff")) return true; // multicast
    return false;
  }
  return true;
}

export function extractUrls(text, max = 8) {
  const matches = String(text || "").match(/https:\/\/[^\s<>"')\]]+/gi) || [];
  return [...new Set(matches.map(url => url.replace(/[.,;:!?]+$/, "")))].slice(0, max);
}

function normalizeUrl(raw, { allowLoopback = false } = {}) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { return { ok: false, code: "invalid_url" }; }
  if (url.username || url.password) return { ok: false, code: "url_has_credentials" };
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:")) {
    return { ok: false, code: "https_required" };
  }
  if (url.port && !["", "443"].includes(url.port)) return { ok: false, code: "port_not_allowed" };
  if (url.href.length > WEB_RESEARCH_LIMITS.maxUrlChars) return { ok: false, code: "url_too_long" };
  return { ok: true, url };
}

/**
 * Validate a URL and every address its host resolves to. A hostname may resolve to several records;
 * one private answer refuses the whole host.
 */
export async function validatePublicUrl(raw, { lookup = dnsLookup, allowLoopback = false } = {}) {
  const normalized = normalizeUrl(raw, { allowLoopback });
  if (!normalized.ok) return normalized;
  const url = normalized.url;
  if (!allowLoopback && BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) return { ok: false, code: "private_host" };

  const literal = isIP(url.hostname);
  const addresses = literal ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, code: "dns_unresolved" };
  for (const record of addresses) {
    if (!allowLoopback && isPrivateAddress(record.address)) return { ok: false, code: "private_address", address: record.address };
  }
  return { ok: true, url, addresses: addresses.map(record => record.address).slice(0, 6) };
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractText(html) {
  const titleMatch = /<title[^>]*>([\s\S]{0,300})<\/title>/i.exec(html);
  const withoutHead = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = decodeEntities(withoutHead.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return {
    title: clean(decodeEntities(titleMatch?.[1] || ""), 200) || null,
    text
  };
}

function excerptFor(text, terms) {
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term.toLowerCase());
    if (index !== -1) break;
  }
  const start = Math.max(0, (index === -1 ? 0 : index) - 120);
  return clean(text.slice(start, start + WEB_RESEARCH_LIMITS.excerptChars), WEB_RESEARCH_LIMITS.excerptChars);
}

function termsOf(text) {
  return [...new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 4))].slice(0, 10);
}

/** Two sources that share terms but disagree on polarity are flagged for review, not resolved. */
export function detectDivergences(sources = []) {
  const list = (Array.isArray(sources) ? sources : []).filter(source => source?.excerpt && source?.url);
  const divergences = [];
  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      const a = list[left];
      const b = list[right];
      const shared = termsOf(a.excerpt).filter(term => termsOf(b.excerpt).includes(term));
      if (shared.length < 2) continue;
      if (NEGATIVE.test(a.excerpt) === NEGATIVE.test(b.excerpt)) continue;
      divergences.push({
        urls: [a.url, b.url],
        sharedTerms: shared.slice(0, 5),
        signal: "polarity_divergence",
        resolved: false,
        note: "Sources disagree in wording; both are preserved. Verification must decide, not this transport."
      });
    }
  }
  return divergences.slice(0, 5);
}

async function readBounded(response, maxBytes, signal) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    const size = Buffer.byteLength(text);
    return { text: text.slice(0, maxBytes), bytes: Math.min(size, maxBytes), truncated: size > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (bytes - maxBytes))));
        truncated = true;
        try { await reader.cancel(); } catch { /* already closed */ }
        break;
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: Math.min(bytes, maxBytes), truncated };
}

export function createWebResearchTransport({
  fetchImpl = fetch,
  lookup = dnsLookup,
  maxBytes = WEB_RESEARCH_LIMITS.maxBytes,
  timeoutMs = WEB_RESEARCH_LIMITS.timeoutMs,
  maxRedirects = WEB_RESEARCH_LIMITS.maxRedirects,
  maxSources = WEB_RESEARCH_LIMITS.maxSources,
  allowLoopback = false,
  now = () => new Date().toISOString()
} = {}) {
  async function fetchOne(rawUrl, terms, signal) {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const valid = await validatePublicUrl(current, { lookup, allowLoopback });
      if (!valid.ok) {
        return { ok: false, url: current, code: valid.code, detail: valid.address || null, at: now() };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      let response;
      try {
        response = await fetchImpl(valid.url.href, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "text/html, text/plain;q=0.9, application/json;q=0.8",
            "user-agent": "Habitat-NEXUS/0.5 (+https://github.com/kushxwookiex420/Habitat)"
          },
          signal: controller.signal
        });
      } catch {
        return { ok: false, url: current, code: controller.signal.aborted ? "page_timeout" : "page_transport_error", at: now() };
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location") || null;
        if (!location) return { ok: false, url: current, code: "redirect_without_location", status: response.status, at: now() };
        if (hop === maxRedirects) return { ok: false, url: current, code: "too_many_redirects", status: response.status, at: now() };
        current = new URL(location, valid.url.href).href;
        continue;
      }
      if (response.status !== 200) {
        return { ok: false, url: current, code: "http_" + Number(response.status || 0), status: response.status, at: now() };
      }
      const contentType = response.headers?.get?.("content-type") || "";
      if (!ALLOWED_CONTENT.test(contentType)) {
        return { ok: false, url: current, code: "unsupported_content_type", contentType: clean(contentType, 80), at: now() };
      }
      let body;
      try {
        body = await readBounded(response, maxBytes, controller.signal);
      } catch {
        return { ok: false, url: current, code: "page_read_failed", at: now() };
      }
      const parsed = /json|xml|ld\+json/i.test(contentType)
        ? { title: null, text: body.text }
        : extractText(body.text);
      return {
        ok: true,
        source: {
          title: parsed.title,
          url: valid.url.href,
          finalUrl: current,
          excerpt: excerptFor(parsed.text, terms),
          textLength: parsed.text.length,
          digest: digest(body.text),
          retrievedAt: now(),
          confidence: body.truncated ? 0.35 : 0.6,
          status: 200,
          contentType: clean(contentType, 80),
          bytes: body.bytes,
          truncated: body.truncated,
          uncertainty: body.truncated
            ? "Response exceeded the byte limit; the excerpt is from the captured prefix only."
            : "Untrusted page text; not independently fact-checked."
        }
      };
    }
    return { ok: false, url: current, code: "too_many_redirects", at: now() };
  }

  async function research({ objective, query = null, urls = null, signal = null } = {}) {
    const text = String(query || objective || "");
    const requested = Array.isArray(urls) && urls.length ? urls : extractUrls(text, maxSources);
    if (!requested.length) {
      return {
        ok: true,
        summary: "No web URL was supplied. This run performed no web request; it is not web research.",
        sources: [],
        confidence: 0,
        scanned: 0,
        divergences: [],
        limitations: [
          "Provide explicit https URLs or configure a search function; an empty result is not evidence.",
          "Fetched pages are untrusted data and are never followed as instructions."
        ]
      };
    }
    const terms = termsOf(text);
    const results = [];
    for (const url of requested.slice(0, maxSources)) {
      results.push(await fetchOne(url, terms, signal));
    }
    const sources = results.filter(result => result.ok).map(result => result.source);
    const errors = results.filter(result => !result.ok);
    return {
      ok: true,
      summary: "Fetched " + sources.length + "/" + results.length + " web source(s) for: " + clean(text, 160),
      sources,
      confidence: sources.length ? Math.min(0.8, 0.35 + sources.length * 0.1) : 0.1,
      scanned: results.length,
      errors,
      divergences: detectDivergences(sources),
      limitations: [
        "Only explicitly supplied (or configured-search) URLs are fetched; no crawler runs.",
        "A fetched page is untrusted data; contradictions are preserved and marked unresolved.",
        "Truncated responses are labelled and never presented as complete."
      ]
    };
  }

  research.kind = "web";
  return research;
}

/** Merge repository and web research without hiding either result set. */
export function createCompositeResearchTransport({ repository = null, web = null, maxSources = 8 } = {}) {
  if (!repository && !web) throw new Error("The composite research transport needs at least one source.");
  async function research(input = {}) {
    const results = [];
    if (repository) results.push(await repository(input));
    if (web) results.push(await web(input));
    const usable = results.filter(result => result && result.ok !== false);
    const sources = usable.flatMap(result => Array.isArray(result.sources) ? result.sources : []).slice(0, maxSources);
    const errors = usable.flatMap(result => Array.isArray(result.errors) ? result.errors : []);
    return {
      ok: true,
      summary: usable.map(result => result.summary).filter(Boolean).join(" | ") || "No research source returned a summary.",
      sources,
      confidence: sources.length ? Math.max(...usable.map(result => Number(result.confidence) || 0)) : 0.1,
      scanned: usable.reduce((total, result) => total + Number(result.scanned || 0), 0),
      errors,
      divergences: usable.flatMap(result => Array.isArray(result.divergences) ? result.divergences : []).slice(0, 5),
      limitations: [...new Set(usable.flatMap(result => Array.isArray(result.limitations) ? result.limitations : []))].slice(0, 8)
    };
  }
  research.kind = "composite";
  return research;
}
