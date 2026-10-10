/**
 * Guard the autonomous Vice City Files render against malformed model output.
 * The current deterministic renderer is a GTA VI fact-update template, so the
 * fallback stays inside claims already represented by its official-source scene plan.
 */
export function normalizeViceCityScript(script) {
  const value = script && typeof script === "object" ? script : {};
  if (typeof value.voiceover === "string" && value.voiceover.trim().length >= 80) {
    return { ...value, voiceover: value.voiceover.trim() };
  }
  return {
    title: "GTA VI: Confirmed Details, Not Rumors",
    hook: "Here are the GTA VI details Rockstar has officially announced.",
    voiceover: "Rockstar Games has announced Grand Theft Auto Six for November nineteenth, twenty twenty-six. The story introduces Jason Duval and Lucia Caminos, with events set in the fictional state of Leonida and Vice City at its center. Rockstar has announced PlayStation Five and Xbox Series X and Series S as launch platforms. Those are the details to separate from rumors. Treat claims about unannounced features, performance, or additional platforms as unconfirmed unless Rockstar says otherwise. Follow Vice City Files for clear gaming updates based on official announcements.",
    onScreenText: ["GTA VI: CONFIRMED DETAILS", "NOVEMBER 19, 2026", "JASON + LUCIA", "VICE CITY • LEONIDA", "PS5 • XBOX SERIES X|S", "FACTS, NOT RUMORS"],
    shotList: ["opening title", "announced release date", "Jason and Lucia", "Vice City and Leonida", "announced launch platforms", "branded closing"],
    caption: "GTA VI details from official Rockstar announcements. Facts, not rumors.",
    hashtags: ["#GTA6", "#GTAVI", "#ViceCity", "#RockstarGames", "#GamingNews"],
    sources: ["https://www.rockstargames.com/VI", "https://www.rockstargames.com/newswire"],
    fallbackReason: "model voiceover was missing or shorter than 80 characters; deterministic fact-safe script used"
  };
}
