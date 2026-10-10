import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { buildSceneOverlaySvg, escapeXml } from "../scene-overlay.mjs";

test("escapes SVG text and produces a fixed mobile-safe overlay canvas", async () => {
  assert.equal(escapeXml("<GTA & Friends>"), "&lt;GTA &amp; Friends&gt;");
  const svg = buildSceneOverlaySvg({ title: "VICE CITY & LEONIDA", subtitle: "OFFICIAL <DETAILS>", fontScale: 0.82 });
  assert.match(svg, /width="540" height="960"/);
  assert.match(svg, /VICE CITY &amp; LEONIDA/);
  assert.match(svg, /OFFICIAL &lt;DETAILS&gt;/);
  const rendered = await sharp(Buffer.from(svg)).png().toBuffer();
  const metadata = await sharp(rendered).metadata();
  assert.equal(metadata.width, 540);
  assert.equal(metadata.height, 960);
  assert.equal(metadata.format, "png");
});
