export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&apos;"
  }[character]));
}

export function buildSceneOverlaySvg({ title, subtitle, fontScale = 1 }) {
  const safeTitle = escapeXml(title);
  const safeSubtitle = escapeXml(subtitle);
  const titleSize = Math.round(28 * Math.max(0.7, Math.min(1, Number(fontScale) || 1)));
  const subtitleSize = Math.round(17 * Math.max(0.7, Math.min(1, Number(fontScale) || 1)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960">
    <rect x="20" y="205" width="500" height="175" rx="10" fill="#000000" fill-opacity="0.72"/>
    <text x="270" y="267" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${titleSize}" font-weight="700" fill="#ffffff">${safeTitle}</text>
    <text x="270" y="316" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${subtitleSize}" font-weight="400" fill="#ffffff">${safeSubtitle}</text>
    <rect x="20" y="824" width="500" height="58" rx="8" fill="#000000" fill-opacity="0.70"/>
    <text x="270" y="859" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="12" font-weight="600" fill="#ffffff">VICE CITY FILES • FACT-CHECKED GAMING UPDATES</text>
  </svg>`;
}
