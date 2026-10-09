/**
 * Wrap overlay copy for vertical mobile video safe areas.
 * Long tokens are split too, so a SKU or unbroken URL cannot overflow the frame.
 */
export function wrapOverlayText(value, maxChars) {
  const limit = Math.max(1, Math.floor(Number(maxChars) || 1));
  const words = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const rawWord of words) {
    let word = rawWord;
    while (word.length > limit) {
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (!line) line = word;
    else if ((line + " " + word).length <= limit) line += " " + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
