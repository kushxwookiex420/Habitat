const ALLOWED_NETWORKS = new Set(["tiktok", "instagram", "facebook", "pinterest", "youtube", "x", "threads", "bluesky", "linkedin"]);
const CAPTION_LIMITS = { tiktok: 2200, instagram: 2200, facebook: 63206, pinterest: 500, youtube: 5000, x: 280, threads: 500, bluesky: 300, linkedin: 3000 };
const DEFAULT_STORE_HOST = "2tanuk-yx.myshopify.com";
const HASHTAGS = {
  tiktok: ["#DropPilotMarket", "#EverydayFinds", "#ProductFinds", "#ShopSmall", "#UsefulFinds"],
  instagram: ["#DropPilotMarket", "#EverydayFinds", "#HomeFinds", "#ProductFinds", "#ShopOnline", "#FindsOfTheDay"],
  facebook: ["#DropPilotMarket", "#EverydayFinds"],
  pinterest: ["#DropPilotMarket", "#ProductIdeas", "#ShoppingFinds"],
  youtube: ["#DropPilotMarket", "#ProductFinds", "#Shorts"],
  x: ["#DropPilotMarket"],
  threads: ["#DropPilotMarket", "#EverydayFinds"],
  bluesky: ["#DropPilotMarket"],
  linkedin: ["#DropPilotMarket", "#Ecommerce"]
};

function clean(value, max = 500) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function slug(value) {
  return clean(value, 100).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "product";
}
function titleCaseNetwork(network) {
  return network === "x" ? "X" : network.charAt(0).toUpperCase() + network.slice(1);
}
function trackedUrl(rawUrl, campaign, network) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("productUrl must be a valid HTTPS product URL"); }
  if (url.protocol !== "https:") throw new Error("productUrl must use HTTPS");
  const configuredHost = String(process.env.SHOPIFY_STORE_DOMAIN || DEFAULT_STORE_HOST).trim().toLowerCase();
  if (url.hostname.toLowerCase() !== configuredHost) throw new Error("productUrl must use the configured DropPilot Shopify store domain");
  if (!/^\\/products\\/[^/]+\\/?$/.test(url.pathname)) throw new Error("productUrl must point directly to a Shopify product page");
  url.searchParams.set("utm_source", network);
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", campaign);
  url.searchParams.set("utm_content", network + "-product-post");
  return url.toString();
}
function compactTags(network) {
  return HASHTAGS[network] || ["#DropPilotMarket"];
}
function captionFor(network, productName, category, features, link) {
  const detail = features.length ? " " + features.slice(0, 3).join(" · ") + "." : "";
  const categoryLine = category ? " " + category + " find." : "";
  const base = {
    tiktok: "Worth a closer look 👀 " + productName + "." + detail + categoryLine + " Check product details, options and availability at DropPilot Market: " + link,
    instagram: "A new find to explore ✨ " + productName + "." + detail + categoryLine + " See the details and available options at DropPilot Market: " + link,
    facebook: "Today's product find: " + productName + "." + detail + categoryLine + " Check details and availability before ordering: " + link,
    pinterest: productName + " — a product idea to save for later." + detail + " View details and available options at DropPilot Market: " + link,
    youtube: productName + " | Product details and options at DropPilot Market: " + link + (features.length ? "\n" + features.slice(0, 2).join(" • ") : ""),
    x: "Product find: " + productName + "." + (features.length ? " " + features.slice(0, 2).join(" · ") + "." : "") + " Details: " + link,
    threads: "Adding this one to the everyday-finds list: " + productName + "." + detail + " Check the details and options here: " + link,
    bluesky: "Product find: " + productName + ". Details and available options: " + link,
    linkedin: "Product spotlight: " + productName + "." + detail + " Product details and availability: " + link
  };
  return base[network];
}

export function buildPromotionPlan(input = {}) {
  const productName = clean(input.productName, 180);
  const rawUrl = clean(input.productUrl, 1000);
  if (!productName) throw new Error("productName is required");
  if (!rawUrl) throw new Error("productUrl is required");
  if (input.productActive !== true) throw new Error("productActive must be true after verifying the Shopify product is active");
  if (input.productAvailable !== true) throw new Error("productAvailable must be true after verifying inventory or supplier availability");
  const category = clean(input.category, 80);
  const features = Array.isArray(input.features)
    ? input.features.map(value => clean(value, 100)).filter(Boolean).slice(0, 5)
    : [];
  const requested = Array.isArray(input.networks) && input.networks.length
    ? input.networks
    : ["tiktok", "instagram", "facebook", "pinterest", "youtube", "x", "threads", "bluesky"];
  const networks = [...new Set(requested.map(value => clean(value, 30).toLowerCase()))];
  const unsupported = networks.filter(network => !ALLOWED_NETWORKS.has(network));
  if (unsupported.length) throw new Error("Unsupported network(s): " + unsupported.join(", "));
  if (!networks.length) throw new Error("At least one supported network is required");
  const campaign = "droppilot-" + slug(productName);
  const drafts = networks.map(network => {
    const url = trackedUrl(rawUrl, campaign, network);
    const hashtags = compactTags(network);
    const caption = captionFor(network, productName, category, features, url) + "\n\n" + hashtags.join(" ");
    const limit = CAPTION_LIMITS[network];
    if (caption.length > limit) throw new Error(network + " caption exceeds its " + limit + "-character limit; shorten product details or features");
    return {
      network,
      networkLabel: titleCaseNetwork(network),
      title: productName.length > 80 ? productName.slice(0, 77).trimEnd() + "..." : productName,
      caption,
      trackedUrl: url,
      hashtags,
      mediaRequired: ["tiktok", "instagram", "pinterest", "youtube"].includes(network),
      status: "draft",
      published: false
    };
  });
  return {
    ok: true,
    campaign,
    product: { productName, category: category || null, productUrl: rawUrl, features },
    drafts,
    count: drafts.length,
    tracking: { utm: true, campaign },
    publishing: { status: "not_published", requiresConnectedAccount: true, requiresMediaWhenPlatformDemandsIt: true, humanReviewRequired: true },
    guardrails: [
      "Drafts only: this endpoint never publishes or schedules posts.",
      "Copy is based only on supplied product details; verify claims, stock, price, shipping and the destination before publishing.",
      "Use media you own or have explicit commercial reuse permission to use."
    ]
  };
}

export function registerPromotionEngine(app) {
  app.get("/promotion/status", (_req, res) => res.json({
    ok: true,
    feature: "multichannel-promotion-planner",
    supportedNetworks: [...ALLOWED_NETWORKS],
    trackedLinks: true,
    autoPublishing: false,
    requiresHumanReview: true
  }));
  app.post("/promotion/plan", (req, res) => {
    try {
      return res.json(buildPromotionPlan(req.body || {}));
    } catch (error) {
      return res.status(400).json({ ok: false, error: clean(error?.message || error, 240) });
    }
  });
}
