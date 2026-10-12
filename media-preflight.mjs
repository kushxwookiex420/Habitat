import dns from "node:dns/promises";
import net from "node:net";
import sharp from "sharp";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 1920;
const MIN_DIMENSION = 320;
const NETWORKS = new Set(["tiktok", "instagram", "facebook", "pinterest", "youtube", "linkedin"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const p = address.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) {
      const mapped = value.slice("::ffff:".length);
      if (net.isIPv4(mapped)) return isPrivateAddress(mapped);
      return true;
    }
    return value === "::" || value === "::1" || value.startsWith("fc") ||
      value.startsWith("fd") || value.startsWith("ff") || /^fe[89ab]/.test(value) ||
      value.startsWith("2001:db8:");
  }
  return true;
}

function hold(reason, details = {}) {
  return { ok: false, decision: "HOLD", reason, ...details };
}

export async function preflightImage({
  url,
  network,
  fetchImpl = fetch,
  lookupImpl = dns.lookup,
  metadataReader = buffer => sharp(buffer, { failOn: "error" }).metadata(),
  maxBytes = MAX_BYTES,
  maxDimension = MAX_DIMENSION,
  minDimension = MIN_DIMENSION
} = {}) {
  const target = String(network || "").trim().toLowerCase();
  if (!NETWORKS.has(target)) return hold("unsupported_or_missing_target_network");
  let parsed;
  try { parsed = new URL(String(url || "")); }
  catch { return hold("invalid_media_url"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname ||
      parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost") ||
      parsed.hostname.endsWith(".local")) return hold("media_url_must_be_public_https");

  try {
    const addresses = net.isIP(parsed.hostname)
      ? [{ address: parsed.hostname }]
      : await lookupImpl(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
      return hold("media_host_not_confirmed_public");
    }
  } catch {
    return hold("media_host_dns_check_failed");
  }

  let response;
  try {
    response = await fetchImpl(parsed, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers: { Accept: "image/jpeg,image/png,image/webp" }
    });
  } catch {
    return hold("media_fetch_failed_or_redirected");
  }
  if (!response?.ok) return hold("media_http_not_successful", { httpStatus: Number(response?.status || 0) });
  const contentType = String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) return hold("unsupported_or_unknown_mime_type", { contentType: contentType || null });
  if (target === "tiktok" && contentType !== "image/jpeg") {
    return hold("tiktok_image_requires_jpeg_for_this_publishing_path", { contentType });
  }
  const declaredLength = Number(response.headers?.get?.("content-length") || 0);
  if (declaredLength > maxBytes) return hold("media_exceeds_byte_limit", { bytes: declaredLength, maxBytes });

  let bytes;
  try { bytes = Buffer.from(await response.arrayBuffer()); }
  catch { return hold("media_body_unreadable"); }
  if (!bytes.length) return hold("media_is_empty");
  if (bytes.length > maxBytes) return hold("media_exceeds_byte_limit", { bytes: bytes.length, maxBytes });
  if (declaredLength && declaredLength !== bytes.length) {
    return hold("media_content_length_mismatch", { declaredBytes: declaredLength, actualBytes: bytes.length });
  }

  let metadata;
  try { metadata = await metadataReader(bytes); }
  catch { return hold("media_bytes_are_not_a_valid_image"); }
  const width = Number(metadata?.width || 0);
  const height = Number(metadata?.height || 0);
  const format = String(metadata?.format || "").toLowerCase();
  const formatMime = ({ jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp" })[format];
  if (!width || !height || formatMime !== contentType) {
    return hold("mime_and_image_signature_do_not_match", { contentType, format: format || null });
  }
  if (width < minDimension || height < minDimension) {
    return hold("image_dimensions_too_small", { width, height, minDimension });
  }
  if (width > maxDimension || height > maxDimension) {
    return hold("image_exceeds_1080p_dimension_guard", { width, height, maxDimension });
  }
  return {
    ok: true,
    decision: "PASS",
    network: target,
    contentType,
    format,
    bytes: bytes.length,
    width,
    height,
    checkedAt: new Date().toISOString(),
    autoPublish: false,
    note: "Technical preflight only; caption, product economics, licensing, and platform review remain separate gates."
  };
}

export function registerMediaPreflight(app) {
  app.get("/media/preflight/status", (_req, res) => res.json({
    ok: true,
    feature: "fail-closed-image-preflight",
    supportedNetworks: [...NETWORKS],
    maxBytes: MAX_BYTES,
    minDimension: MIN_DIMENSION,
    maxDimension: MAX_DIMENSION,
    autoPublishing: false
  }));
  app.post("/media/preflight", async (req, res) => {
    const result = await preflightImage({ url: req.body?.url, network: req.body?.network });
    return res.status(result.ok ? 200 : 422).json(result);
  });
}
