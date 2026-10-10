/**
 * Guard autonomous Vice City Files narration against malformed or off-objective model output.
 * Fallbacks use only the official Rockstar fact package and are selected by the requested
 * daily topic, so an unavailable free model does not silently repeat the same generic script.
 */
const SOURCES = ["https://www.rockstargames.com/VI", "https://www.rockstargames.com/newswire"];

const FALLBACK = {
  title: "GTA VI: Confirmed Details, Not Rumors",
  hook: "Here are the GTA VI details Rockstar has officially announced.",
  voiceover: "Rockstar Games has announced Grand Theft Auto Six for November nineteenth, twenty twenty-six. The story follows Jason Duval and Lucia Caminos through Leonida, with Vice City at the center of the setting. PlayStation Five and Xbox Series X and Series S are the announced launch platforms. Keep rumors separate from official announcements, and check Rockstar sources before treating new claims as facts. Follow Vice City Files for clear updates without speculation.",
  onScreenText: ["GTA VI CONFIRMED DETAILS", "NOVEMBER 19, 2026", "JASON + LUCIA", "VICE CITY • LEONIDA", "PS5 • XBOX SERIES X|S", "FACTS, NOT RUMORS"],
  shotList: ["opening title", "announced release date", "Jason and Lucia", "Vice City and Leonida", "announced launch platforms", "follow for official updates"],
  caption: "GTA VI details from official Rockstar announcements. Facts, not rumors.",
  hashtags: ["#GTA6", "#GTAVI", "#ViceCity", "#RockstarGames", "#GamingNews"],
  sources: SOURCES
};

const TOPIC_FALLBACKS = {
  legacy: {
    title: "VICE CITY'S RETURN",
    hook: "Vice City is returning—here is what connects the old setting to GTA VI.",
    voiceover: "Grand Theft Auto VI brings Vice City back as a central setting, while the official story reaches beyond the city into the fictional state of Leonida. Rockstar names Jason Duval and Lucia Caminos as the two leads and describes a story that draws them into a criminal conspiracy after a score goes wrong. The game is scheduled for November nineteenth, twenty twenty-six, with PlayStation Five and Xbox Series X and Series S as launch platforms. That is the confirmed bridge to the Vice City legacy: the city returns, the setting expands into Leonida, and a new pair of leads anchors the story. Details beyond official announcements remain unconfirmed. Follow Vice City Files for source-based updates.",
    onScreenText: ["VICE CITY RETURNS", "A NEW LEONIDA STORY", "JASON + LUCIA", "THE CITY IS BACK", "NOVEMBER 19, 2026", "VERIFIED UPDATES ONLY"],
    shotList: ["Vice City legacy", "Leonida setting", "Jason and Lucia", "the city returns", "official release date", "follow for official updates"],
    caption: "What is officially confirmed about Vice City's return in GTA VI—no rumors.",
    hashtags: ["#GTA6", "#ViceCity", "#GTAVI", "#RockstarGames", "#GamingNews"],
    sources: SOURCES
  },
  release: {
    title: "GTA VI RELEASE DATE",
    hook: "The GTA VI release date is official—here are the details to remember.",
    voiceover: "Rockstar's official release date for Grand Theft Auto VI is November nineteenth, twenty twenty-six, and pre-orders are open on the official site. Rockstar currently lists PlayStation Five and Xbox Series X and Series S as launch platforms. Those are the release details that are safe to repeat. A date or platform shared by a rumor account is not the same as a company announcement, so do not treat an unannounced PC date, performance target, or extra edition as confirmed unless Rockstar publishes it. If the details change, the official GTA VI page and Rockstar Newswire are the places to check. Follow Vice City Files for release updates based on official sources.",
    onScreenText: ["OFFICIAL RELEASE DATE", "NOVEMBER 19, 2026", "PRE-ORDERS ARE OPEN", "PS5 + XBOX SERIES", "CHECK ROCKSTAR SOURCES", "FACTS, NOT RUMORS"],
    shotList: ["release date hook", "official November date", "pre-order status", "announced consoles", "source check", "verified closing"],
    caption: "GTA VI release details from Rockstar's official announcements.",
    hashtags: ["#GTA6", "#GTAVI", "#GTA6ReleaseDate", "#RockstarGames", "#GamingNews"],
    sources: SOURCES
  },
  characters: {
    title: "MEET JASON AND LUCIA",
    hook: "Jason and Lucia are the two leads Rockstar has officially named.",
    voiceover: "Rockstar's official description introduces Jason Duval and Lucia Caminos as the leads of Grand Theft Auto VI. Their story begins after a score goes wrong and draws them into a criminal conspiracy across Leonida. That is the confirmed story setup; details about every mission, ending, or additional playable character should not be treated as fact unless Rockstar announces them. Vice City remains at the center of the setting, and Rockstar lists November nineteenth, twenty twenty-six as the release date. PlayStation Five and Xbox Series X and Series S are the announced launch platforms. Follow Vice City Files for character and story updates grounded in official material.",
    onScreenText: ["JASON + LUCIA", "TWO STORY LEADS", "A SCORE GOES WRONG", "ACROSS LEONIDA", "NOVEMBER 19, 2026", "OFFICIAL DETAILS ONLY"],
    shotList: ["character hook", "Jason Duval", "Lucia Caminos", "confirmed story setup", "official release details", "verified closing"],
    caption: "What Rockstar has confirmed about Jason and Lucia in GTA VI.",
    hashtags: ["#GTA6", "#JasonAndLucia", "#GTAVI", "#ViceCity", "#RockstarGames"],
    sources: SOURCES
  },
  setting: {
    title: "VICE CITY AND LEONIDA",
    hook: "Vice City is central to GTA VI, but the announced setting is Leonida.",
    voiceover: "Grand Theft Auto VI is set in the fictional state of Leonida, with Vice City at the center of the story. That distinction matters: the official setting extends beyond the city name, and Rockstar's description connects the story to Jason Duval and Lucia Caminos. The confirmed release date is November nineteenth, twenty twenty-six, with PlayStation Five and Xbox Series X and Series S listed as launch platforms. Treat claims about exact map size, specific neighborhoods, or locations not confirmed in official material as unverified. Rockstar's official GTA VI page is the source to check when new details appear. Follow Vice City Files for clear updates about the world Rockstar has announced.",
    onScreenText: ["THE STATE OF LEONIDA", "VICE CITY AT THE CENTER", "JASON + LUCIA", "SETTING, NOT SPECULATION", "OFFICIAL DETAILS", "VERIFIED UPDATES ONLY"],
    shotList: ["setting hook", "Leonida", "Vice City", "confirmed protagonists", "official release information", "verified closing"],
    caption: "Vice City and Leonida: the GTA VI setting details Rockstar has confirmed.",
    hashtags: ["#GTA6", "#Leonida", "#ViceCity", "#GTAVI", "#RockstarGames"],
    sources: SOURCES
  },
  platforms: {
    title: "WHERE GTA VI IS ANNOUNCED",
    hook: "Here are the GTA VI launch platforms Rockstar currently lists.",
    voiceover: "If you are checking where Grand Theft Auto VI is announced to launch, Rockstar's official page lists PlayStation Five and Xbox Series X and Series S. The official release date is November nineteenth, twenty twenty-six, and pre-orders are open on Rockstar's site. That is the safe answer from the current announcement. If you see a post promising a PC release date or another console version, treat it as unconfirmed unless Rockstar publishes it. Platform rumors spread quickly, but the publisher's own listing is what matters. Check the official GTA VI page and Rockstar Newswire for changes. Follow Vice City Files for confirmed platform updates without rumor claims.",
    onScreenText: ["ANNOUNCED PLATFORMS", "PLAYSTATION 5", "XBOX SERIES X|S", "NOVEMBER 19, 2026", "UNANNOUNCED PLATFORMS = UNCONFIRMED", "OFFICIAL SOURCES ONLY"],
    shotList: ["platform hook", "PlayStation 5", "Xbox Series X and S", "official release date", "rumor check", "verified closing"],
    caption: "GTA VI launch platforms currently listed by Rockstar.",
    hashtags: ["#GTA6", "#PlayStation5", "#XboxSeriesX", "#GTAVI", "#RockstarGames"],
    sources: SOURCES
  },
  trailer: {
    title: "TRAILER FACTS, NOT THEORIES",
    hook: "A trailer can spark theories, but only announcements count as confirmed facts.",
    voiceover: "Stick to what Rockstar has actually shown and announced for Grand Theft Auto VI. The official materials identify Jason Duval and Lucia Caminos, place the story in Leonida with Vice City at its center, and list November nineteenth, twenty twenty-six as the release date. PlayStation Five and Xbox Series X and Series S are the announced launch platforms. A trailer can inspire theories about missions, map size, or hidden features, but those ideas are not confirmed facts unless Rockstar says so. Keep the official GTA VI page and Rockstar Newswire as the source of truth. Follow Vice City Files for verified trailer breakdowns that separate evidence from speculation.",
    onScreenText: ["TRAILER VS. RUMORS", "JASON + LUCIA", "LEONIDA + VICE CITY", "NOVEMBER 19, 2026", "PS5 + XBOX SERIES", "FACTS, NOT THEORIES"],
    shotList: ["trailer hook", "confirmed characters", "official setting", "release date", "announced platforms", "verified closing"],
    caption: "GTA VI trailer details: what is confirmed and what remains speculation.",
    hashtags: ["#GTA6", "#GTAVI", "#GTA6Trailer", "#ViceCity", "#RockstarGames"],
    sources: SOURCES
  }
};

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function narrationProblem(value) {
  const text = cleanText(value);
  if (/\b(lorem ipsum|insert narration|voiceover goes here|placeholder text|as an ai language model)\b/i.test(text)) return "voiceover contains placeholder or meta text";
  if (/^(\s*\{[\s\S]*\}|\s*\[[\s\S]*\])$/.test(text)) return "voiceover contains raw structured data instead of narration";
  if (text.length < 180) return "voiceover too short for a complete short-form narration";
  const words = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) || [];
  if (words.length < 35) return "voiceover has fewer than 35 spoken words";
  const unique = new Set(words.map(word => word.toLowerCase()));
  if (unique.size / words.length < 0.28) return "voiceover is excessively repetitive";
  if ((text.match(/[.!?](?:\s|$)/g) || []).length < 2) return "voiceover lacks sentence boundaries";
  return null;
}

function topicForObjective(objective) {
  const text = cleanText(objective).toLowerCase();
  if (/legacy|history|return of vice city|returning to vice city/.test(text)) return "legacy";
  if (/platform|console availability|launch platform/.test(text)) return "platforms";
  if (/release timing|release date|pre.?order/.test(text)) return "release";
  if (/jason and lucia|character|story setup|protagonist/.test(text)) return "characters";
  if (/setting|leonida|miami context|vice city.*inspiration/.test(text)) return "setting";
  if (/trailer|rumor|speculation/.test(text)) return "trailer";
  return null;
}

function scriptMatchesTopic(script, topic) {
  const text = [script.title, script.hook, script.voiceover, ...(script.onScreenText || []), ...(script.shotList || [])].join(" ").toLowerCase();
  switch (topic) {
    case "legacy": return /\b(legacy|history|return of vice city|returning to vice city)\b/.test(text);
    case "platforms": return /\bplaystation\b/.test(text) && /\bxbox\b/.test(text);
    case "release": return /november nineteenth|november 19|release date|pre.?orders?/.test(text);
    case "characters": return /\bjason\b/.test(text) && /\blucia\b/.test(text) && /story|score|criminal conspiracy/.test(text);
    case "setting": return /\bleonida\b/.test(text) && /\bvice city\b/.test(text) && /setting|map|inspired|state/.test(text);
    case "trailer": return /\btrailer\b/.test(text) && /official|confirmed|announced/.test(text);
    default: return true;
  }
}

function fallbackForObjective(objective) {
  const topic = topicForObjective(objective);
  return topic ? TOPIC_FALLBACKS[topic] : FALLBACK;
}

/**
 * Normalize model output into a complete renderable script. If the model output
 * is malformed or does not address the requested daily topic, use the matching
 * official-fact fallback rather than silently repeating the generic script.
 */
export function normalizeViceCityScript(script, objective = "") {
  const value = script && typeof script === "object" && !Array.isArray(script) ? script : {};
  const hasRequiredFields =
    ["title", "hook", "caption"].every(key => cleanText(value[key])) &&
    ["onScreenText", "shotList", "hashtags"].every(key => Array.isArray(value[key]) && value[key].length > 0);
  const problem = narrationProblem(value.voiceover);
  const topic = topicForObjective(objective);
  const matchesTopic = !topic || scriptMatchesTopic(value, topic);
  if (hasRequiredFields && !problem && matchesTopic) {
    return { ...value, voiceover: cleanText(value.voiceover) };
  }
  const reasons = [];
  if (!hasRequiredFields) reasons.push("required production fields are missing or malformed");
  if (problem) reasons.push(problem);
  if (!matchesTopic) reasons.push("model script did not address the requested daily topic");
  return {
    ...fallbackForObjective(objective),
    fallbackReason: reasons.join("; ") || "objective-specific fallback selected"
  };
}
