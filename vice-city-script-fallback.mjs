/**
 * Guard autonomous Vice City Files narration against malformed or unusable model output.
 * The deterministic renderer expects coherent spoken prose, not just a long string.
 * Fallback claims remain limited to the official-source fact package.
 */
const FALLBACK = {
  title: "GTA VI: Confirmed Details, Not Rumors",
  hook: "Here are the GTA VI details Rockstar has officially announced.",
  voiceover: "Rockstar Games has announced Grand Theft Auto Six for November nineteenth, twenty twenty-six. The story introduces Jason Duval and Lucia Caminos, with events set in the fictional state of Leonida and Vice City at its center. Rockstar has announced PlayStation Five and Xbox Series X and Series S as launch platforms. Those are the details to separate from rumors. Treat claims about unannounced features, performance, or additional platforms as unconfirmed unless Rockstar says otherwise. Follow Vice City Files for clear gaming updates based on official announcements.",
  onScreenText: ["GTA VI: CONFIRMED DETAILS", "NOVEMBER 19, 2026", "JASON + LUCIA", "VICE CITY • LEONIDA", "PS5 • XBOX SERIES X|S", "FACTS, NOT RUMORS"],
  shotList: ["opening title", "announced release date", "Jason and Lucia", "Vice City and Leonida", "announced launch platforms", "branded closing"],
  caption: "GTA VI details from official Rockstar announcements. Facts, not rumors.",
  hashtags: ["#GTA6", "#GTAVI", "#ViceCity", "#RockstarGames", "#GamingNews"],
  sources: ["https://www.rockstargames.com/VI", "https://www.rockstargames.com/newswire"]
};

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function narrationProblem(value) {
  const text = cleanText(value);
  if (text.length < 180) return "voiceover too short for a complete short-form narration";
  const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) || [];
  if (words.length < 35) return "voiceover has fewer than 35 spoken words";
  if (/^(\s*\{[\s\S]*\}|\s*\[[\s\S]*\])$/.test(text)) return "voiceover contains raw structured data instead of narration";
  if (/\b(lorem ipsum|insert narration|voiceover goes here|placeholder text|as an ai language model)\b/i.test(text)) return "voiceover contains placeholder or meta text";
  const unique = new Set(words.map(word => word.toLowerCase()));
  if (words.length >= 35 && unique.size / words.length < 0.28) return "voiceover is excessively repetitive";
  if ((text.match(/[.!?](?:\s|$)/g) || []).length < 2) return "voiceover lacks sentence boundaries";
  return null;
}

/**
 * Normalize model output into a complete renderable script. A model response is
 * accepted only when the required fields and spoken narration pass production checks.
 */
export function normalizeViceCityScript(script) {
  const value = script && typeof script === "object" && !Array.isArray(script) ? script : {};
  const hasRequiredFields =
    ["title", "hook", "caption"].every(key => cleanText(value[key])) &&
    ["onScreenText", "shotList", "hashtags"].every(key => Array.isArray(value[key]) && value[key].length > 0);
  const problem = narrationProblem(value.voiceover);
  if (hasRequiredFields && !problem) {
    return { ...value, voiceover: cleanText(value.voiceover) };
  }
  const reasons = [];
  if (!hasRequiredFields) reasons.push("required production fields are missing or malformed");
  if (problem) reasons.push(problem);
  return {
    ...FALLBACK,
    fallbackReason: reasons.join("; ")
  };
}
