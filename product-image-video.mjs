/**
 * Product-picture video generator for DropPilot.
 * Builds an animated showcase from a product's own catalog image; it does not
 * claim to show the product operating. Output is temporary, QA-gated, and never
 * auto-published.
 */
import crypto from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runVisualQA } from "./visual-qa.mjs";
import { DEJAVU_REGULAR, DEJAVU_BOLD } from "./font-paths.mjs";
import { wrapOverlayText } from "./overlay-text.mjs";

const execFileAsync = promisify(execFile);
const ffprobePath = ffprobeStatic.path;
const outputs = new Map();
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DURATION_SECONDS = 12;
const WIDTH = 1080;
const HEIGHT = 1920;

function safeText(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") ||
      x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") ||
      x.startsWith("feb") || x.startsWith("::ffff:127.") || x.startsWith("::ffff:10.");
  }
  return true;
}

export async function validatePublicImageUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("imageUrl must be a valid public HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("Only public HTTPS product-image URLs are accepted.");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new Error("Private/local image hosts are not permitted.");
  }
  if (net.isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) throw new Error("Private IP addresses are not permitted.");
  } else {
    const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!records.length || records.some(record => isPrivateIp(record.address))) {
      throw new Error("The image host did not resolve exclusively to public IP addresses.");
    }
  }
  return url;
}

function sendError(res, status, error) {
  return res.status(status).json({ ok: false, error: String(error?.message || error).slice(0, 300) });
}

export function registerProductImageVideo(app) {
  app.get("/product-image-video/status", async (_req, res) => {
    const checks = {};
    for (const [name, file] of [["ffmpeg", ffmpegPath], ["ffprobe", ffprobePath], ["fontRegular", DEJAVU_REGULAR], ["fontBold", DEJAVU_BOLD]]) {
      try { await fs.access(file); checks[name] = { ok: true }; }
      catch { checks[name] = { ok: false }; }
    }
    try { await execFileAsync(ffmpegPath, ["-version"], { timeout: 5000 }); checks.ffmpegExecutable = { ok: true }; }
    catch (error) { checks.ffmpegExecutable = { ok: false, detail: String(error?.message || error).slice(0, 160) }; }
    const ready = Object.values(checks).every(check => check.ok);
    return res.status(ready ? 200 : 503).json({
      ok: ready, ready, feature: "product-image-video", format: "MP4", width: WIDTH, height: HEIGHT,
      durationSeconds: DURATION_SECONDS, maxImageBytes: MAX_IMAGE_BYTES,
      usesCatalogImagesOnly: true, animatedImageMotion: "slow zoom with safe-area text overlays",
      includesRealProductOperationFootage: false, autoPublish: false,
      outputPersistence: "temporary instance storage; render again after an instance restart",
      approvalRequired: true, checks
    });
  });

  app.post("/product-image-video/render", async (req, res) => {
    const productName = safeText(req.body?.productName, 120);
    const imageUrl = safeText(req.body?.imageUrl, 1800);
    const callToAction = safeText(req.body?.callToAction || "Explore it at DropPilot", 90);
    const price = safeText(req.body?.price, 32);
    const priceVerified = req.body?.priceVerified === true;
    if (!productName) return sendError(res, 400, "productName is required.");
    if (!imageUrl) return sendError(res, 400, "imageUrl is required.");
    if (price && !priceVerified) return sendError(res, 400, "A price can only be shown when priceVerified is true and the value was checked against the current catalog.");
    let dir;
    try {
      const url = await validatePublicImageUrl(imageUrl);
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "habitat-product-image-video-"));
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        headers: { "User-Agent": "HabitatAx/1.0 product-image-video", "Accept": "image/jpeg,image/png,image/webp" }
      });
      if (response.status >= 300 && response.status < 400) throw new Error("Image redirects are not accepted; provide the final catalog image URL.");
      if (!response.ok) throw new Error("Product image download failed with HTTP " + response.status);
      const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw new Error("The source must be a JPEG, PNG, or WebP product image.");
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error("The product image exceeds the 12 MB limit.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Could not read the product image.");
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error("The product image exceeds the 12 MB limit."); }
        chunks.push(Buffer.from(value));
      }
      if (bytes < 512) throw new Error("The product image is empty or too small.");
      const imagePath = path.join(dir, "catalog-image");
      await fs.writeFile(imagePath, Buffer.concat(chunks));
      await execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", imagePath], { timeout: 12000 });

      const titlePath = path.join(dir, "title.txt");
      const pricePath = path.join(dir, "price.txt");
      const ctaPath = path.join(dir, "cta.txt");
      const brandPath = path.join(dir, "brand.txt");
      await Promise.all([
        fs.writeFile(titlePath, wrapOverlayText(productName, 24), "utf8"),
        fs.writeFile(pricePath, price ? price : "", "utf8"),
        fs.writeFile(ctaPath, wrapOverlayText(callToAction, 32), "utf8"),
        fs.writeFile(brandPath, "DROPPILOT", "utf8")
      ]);
      const outputPath = path.join(dir, "droppilot-product-picture-video.mp4");
      const filter = [
        "scale=920:1120:force_original_aspect_ratio=decrease",
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=#0b1026",
        "zoompan=z='min(zoom+0.00022,1.08)':d=360:s=1080x1920:fps=30",
        "drawbox=x=0:y=0:w=iw:h=310:color=#07101f@0.78:t=fill",
        "drawbox=x=0:y=ih-390:w=iw:h=390:color=#07101f@0.82:t=fill",
        "drawtext=fontfile=" + DEJAVU_BOLD + ":textfile=" + brandPath + ":fontcolor=#62f5e7:fontsize=34:x=(w-text_w)/2:y=80",
        "drawtext=fontfile=" + DEJAVU_BOLD + ":textfile=" + titlePath + ":fontcolor=white:fontsize=48:line_spacing=8:box=1:boxcolor=black@0.0:boxborderw=10:x=(w-text_w)/2:y=145",
        ...(price ? ["drawtext=fontfile=" + DEJAVU_BOLD + ":textfile=" + pricePath + ":fontcolor=#62f5e7:fontsize=54:x=(w-text_w)/2:y=h-330"] : []),
        "drawtext=fontfile=" + DEJAVU_REGULAR + ":textfile=" + ctaPath + ":fontcolor=white:fontsize=34:line_spacing=6:x=(w-text_w)/2:y=h-220",
        "format=yuv420p"
      ].join(",");
      await execFileAsync(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-i", imagePath,
        "-vf", filter, "-t", String(DURATION_SECONDS), "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-movflags", "+faststart", outputPath
      ], { timeout: 120000 });
      const stat = await fs.stat(outputPath);
      if (!stat.size) throw new Error("FFmpeg produced an empty video.");
      const probe = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,width,height", "-of", "json", outputPath]);
      const meta = JSON.parse(probe.stdout);
      const video = (meta.streams || []).find(stream => stream.codec_type === "video") || {};
      const durationSeconds = Number(meta.format?.duration || 0);
      const qa = await runVisualQA({
        artifactPath: outputPath,
        renderPlan: {
          format: "9:16",
          scenes: [{ start: 0, end: DURATION_SECONDS, title: "Animated catalog image showcase; product operation is not depicted" }],
          onScreenText: [
            { text: "DROPPILOT", fontSize: 34, bold: true },
            { text: wrapOverlayText(productName, 24), fontSize: 48, bold: true },
            ...(price ? [{ text: price, fontSize: 54, bold: true }] : []),
            { text: wrapOverlayText(callToAction, 32), fontSize: 34, bold: false }
          ]
        },
        expectedSceneCount: 1,
        requireAudio: false
      });
      const verified = qa.status === "VISUAL_PASS" && Number(video.width) === WIDTH && Number(video.height) === HEIGHT && durationSeconds >= DURATION_SECONDS - 0.2;
      const id = crypto.randomUUID();
      outputs.set(id, { outputPath, dir, verified, qa, productName, createdAt: new Date().toISOString(), durationSeconds, bytes: stat.size });
      return res.status(verified ? 200 : 422).json({
        ok: verified, id, productName, status: verified ? "verified" : "blocked", verified,
        artifactUrl: "/product-image-video/" + id + "/artifact",
        artifact: { type: "mp4", durationSeconds, width: Number(video.width), height: Number(video.height), bytes: stat.size, audio: false },
        videoType: "animated product-image showcase", productOperationShown: false,
        visualQA: qa, approvalRequired: true, publishStatus: "not_published",
        note: verified ? "Product-picture video rendered and passed machine visual QA. Review it before posting; it uses no real-operation footage and has no audio." : "Visual QA blocked this output; resolve reported issues before approval."
      });
    } catch (error) {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return sendError(res, 502, error);
    }
  });

  app.get("/product-image-video/:id/artifact", async (req, res) => {
    const item = outputs.get(String(req.params.id || ""));
    if (!item) return res.status(404).json({ ok: false, error: "Rendered product-picture video is unavailable on this instance. Render again after a restart." });
    if (!item.verified) return res.status(403).json({ ok: false, error: "Only Visual-QA-verified videos can be retrieved." });
    res.type("video/mp4");
    return res.download(item.outputPath, "droppilot-product-picture-video.mp4");
  });
}
