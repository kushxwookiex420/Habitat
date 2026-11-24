import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Outbound webhook fetch with DNS pinning.
 *
 * The hostname is resolved once, every address is validated, and the socket is opened to the validated
 * address while TLS still verifies the original hostname. Node's `fetch` is not used: it re-resolves at
 * connection time, which is exactly the DNS-rebinding gap this closes. Redirects are rejected, not
 * followed, and URLs with credentials or fragments are refused.
 */

const RESERVED_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];

function ipv4ToInt(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function inV4Range(address, network, bits) {
  const value = ipv4ToInt(address);
  const base = ipv4ToInt(network);
  if (value === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isPrivateAddress(address) {
  const value = String(address || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(value);
  if (version === 4) return RESERVED_V4.some(([network, bits]) => inV4Range(value, network, bits));
  if (version === 6) {
    if (value === "::" || value === "::1") return true;
    const mapped = value.startsWith("::ffff:") ? value.slice(7) : value.startsWith("0:0:0:0:0:ffff:") ? value.slice(12) : null;
    if (mapped && isIP(mapped) === 4) return isPrivateAddress(mapped);
    return value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")
      || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff")
      || value.startsWith("2001:db8") || value.startsWith("2002:") || value.startsWith("3fff:");
  }
  return true; // not an IP at all: refuse rather than guess
}

function blocked(reason) {
  const error = new Error(reason);
  error.code = reason;
  return error;
}

export function createPinnedCallbackFetch({ allowInsecure = false, resolveHost = dnsLookup, timeoutMs = 10_000, maxResponseBytes = 1024 * 1024 } = {}) {
  return async function pinnedFetch(url, { method = "POST", headers = {}, body = null, signal = null } = {}) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { throw blocked("url_invalid"); }
    if (parsed.username || parsed.password) throw blocked("url_credentials_forbidden");
    if (parsed.hash) throw blocked("url_fragment_forbidden");
    if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:")) throw blocked("https_required");

    let address = parsed.hostname;
    let family = isIP(parsed.hostname);
    if (!family) {
      const resolved = await resolveHost(parsed.hostname, { all: true, verbatim: true });
      const list = Array.isArray(resolved) ? resolved : [resolved];
      if (!list.length) throw blocked("host_unresolved");
      if (!allowInsecure) {
        for (const entry of list) if (isPrivateAddress(entry.address)) throw blocked("private_address_forbidden");
      }
      address = list[0].address;
      family = Number(list[0].family) || isIP(address);
    } else if (!allowInsecure && isPrivateAddress(address)) {
      throw blocked("private_address_forbidden");
    }

    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const transport = parsed.protocol === "https:" ? https : http;
    const requestHeaders = { ...headers, host: parsed.host };
    return await new Promise((resolve, reject) => {
      const request = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method,
        headers: requestHeaders,
        // pin: the callback address is used for this connection only; TLS SNI/Host stay the hostname.
        lookup: (_hostname, _options, callback) => callback(null, address, family || 4),
        servername: parsed.hostname,
        timeout: timeoutMs,
        rejectUnauthorized: true
      }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          return reject(blocked("redirect_forbidden"));
        }
        const chunks = [];
        let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > maxResponseBytes) { request.destroy(); reject(blocked("response_too_large")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            headers: response.headers,
            text: async () => text,
            json: async () => JSON.parse(text)
          });
        });
      });
      request.on("timeout", () => request.destroy(blocked("timeout")));
      request.on("error", error => reject(blocked(error?.code || "request_failed")));
      if (signal) {
        if (signal.aborted) { request.destroy(blocked("aborted")); return; }
        signal.addEventListener("abort", () => request.destroy(blocked("aborted")), { once: true });
      }
      if (body !== null && body !== undefined) request.write(body);
      request.end();
    });
  };
}
