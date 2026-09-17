// Loading screen shown after "Get my report". While the report request goes to n8n,
// this scans the business in the browser: Google profile, nearby competitors, reviews,
// photos, a real phone speed test of their website, and how customers can reach them.
// Adapted from the Business Grader prototype, rebuilt for a static site on Places API (New).
(() => {
  "use strict";

  const PLACES_URL = "https://places.googleapis.com/v1";
  const PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
  const STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Every lookup starts at once, so these are about pacing what the lead sees, not waiting
  // on data. Each step holds long enough to actually read, and no step stalls on a slow API.
  const MIN_STEP_MS = REDUCED_MOTION ? 1200 : 3800; // each step stays up at least this long
  const DATA_CAP_MS = 9000; // never let one slow API hold a step longer than this
  const WEBSITE_CAP_MS = 11000; // the speed test keeps running in the background if it is slower
  const WEBSITE_FINAL_CAP_MS = 12000; // and the report gives it this long at the end, no more
  const DESKTOP_CAP_MS = 9000; // the phone test is what the report uses, so desktop never holds it up

  const STEPS = [
    { key: "profile", label: (name) => `Finding ${name} on Google` },
    { key: "competitors", label: () => "Comparing you to nearby competitors" },
    { key: "ranking", label: () => "Checking where you rank on Google Maps" },
    { key: "reviews", label: () => "Reading your latest Google reviews" },
    { key: "photos", label: () => "Checking your photos" },
    { key: "website", label: () => "Testing your website on a phone" },
    { key: "reach", label: () => "Checking how customers can reach you" },
  ];

  const $ = (id) => document.getElementById(id);
  const apiKey = () => window.DIALBRIDGE_CONFIG?.GOOGLE_MAPS_API_KEY || "";
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const withCap = (promise, ms, fallback) => Promise.race([promise, wait(ms).then(() => fallback)]);

  let running = false;
  // Set when they leave the scan. The steps already in flight cannot be recalled, so they
  // check this and stop rather than drawing a report over the page they went back to.
  let cancelled = false;

  // ============ SMALL HELPERS ============

  // Builds DOM nodes. Business data only ever goes in as text, never as HTML.
  function h(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style") node.style.cssText = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function safeUrl(url, { allowHttp = false } = {}) {
    if (typeof url !== "string") return "";
    if (url.startsWith("//")) url = "https:" + url;
    if (/^https:\/\//i.test(url)) return url;
    if (allowHttp && /^http:\/\//i.test(url)) return url;
    return "";
  }

  function stars(rating) {
    const rounded = Math.max(0, Math.min(5, Math.round(rating || 0)));
    return "★".repeat(rounded) + "☆".repeat(5 - rounded);
  }

  function photoUrl(photoName, width) {
    if (!/^places\/[^/]+\/photos\/[^/]+$/.test(photoName || "")) return "";
    return `${PLACES_URL}/${photoName}/media?maxWidthPx=${width}&key=${encodeURIComponent(apiKey())}`;
  }

  // "4422 Lareina Dr, Austin, TX 78745, USA" -> "Austin, TX"; "Mahwah, NJ, USA" -> "Mahwah, NJ"
  function cityOf(address) {
    const parts = String(address || "").split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length && /^(USA|United States)$/i.test(parts[parts.length - 1])) parts.pop();
    let state = "";
    if (parts.length) {
      const match = parts[parts.length - 1].match(/^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
      if (match) {
        state = match[1];
        parts.pop();
      }
    }
    const city = parts.length ? parts[parts.length - 1] : "";
    return [city, state].filter(Boolean).join(", ");
  }

  function img(src, props = {}) {
    if (!src) return null;
    const node = h("img", { src, alt: "", ...props });
    node.addEventListener("error", () => node.remove());
    return node;
  }

  // ============ DATA ============

  async function placesRequest(path, { method = "GET", body, fieldMask }) {
    const headers = { "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": fieldMask };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${PLACES_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error?.message || `Google returned ${res.status}`);
    return data;
  }

  // Reviews and editorial summary bill as Place Details Enterprise + Atmosphere.
  const PROFILE_FIELDS = [
    "id", "displayName", "formattedAddress", "location", "rating", "userRatingCount",
    "websiteUri", "nationalPhoneNumber", "primaryType", "primaryTypeDisplayName", "photos",
    "reviews", "editorialSummary", "regularOpeningHours", "pureServiceAreaBusiness",
  ].join(",");

  // The search box already looked this place up, with every field we need, inside the
  // session that makes the autocomplete keystrokes free. Reusing it saves a paid call and
  // a round trip. We only go back to Google if that handover is missing or stale.
  async function fetchProfile(placeId) {
    const handed = window.selectedPlace;
    const p = handed && handed.id === placeId
      ? handed
      : await placesRequest(`/places/${encodeURIComponent(placeId)}`, { fieldMask: PROFILE_FIELDS });
    return normaliseProfile(p);
  }

  function normaliseProfile(p) {
    return {
      id: p.id,
      name: p.displayName?.text || "",
      address: p.formattedAddress || "",
      location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null,
      rating: typeof p.rating === "number" ? p.rating : null,
      reviewCount: p.userRatingCount || 0,
      website: p.websiteUri || "",
      phone: p.nationalPhoneNumber || "",
      primaryType: p.primaryType || "",
      category: p.primaryTypeDisplayName?.text || "",
      photos: (p.photos || []).map((photo) => photo.name).filter(Boolean).slice(0, 10),
      reviews: (p.reviews || []).slice(0, 5).map((r) => ({
        author: r.authorAttribution?.displayName || "Google user",
        authorPhoto: safeUrl(r.authorAttribution?.photoUri),
        rating: Math.max(0, Math.min(5, r.rating || 0)),
        when: r.relativePublishTimeDescription || "",
        publishedAt: r.publishTime || "",
        text: r.text?.text || r.originalText?.text || "",
      })),
      summary: p.editorialSummary?.text || "",
      hasHours: Boolean(p.regularOpeningHours?.weekdayDescriptions?.length),
      serviceAreaOnly: Boolean(p.pureServiceAreaBusiness),
    };
  }

  const COMPETITOR_FIELDS = [
    "places.id", "places.displayName", "places.rating", "places.userRatingCount", "places.location",
  ].join(",");

  // Categories too vague to find real competitors ("Services" returns hospitals and hardware stores).
  // Categories that tell us nothing about the trade. Google files a great many real trades
  // under plain "service", and its display label for that is "Services", so both spellings
  // and both plurals have to be caught. Store types are here too: searching "home
  // improvement store" returns Home Depot, never the contractor filed under it.
  const GENERIC_TYPES = new Set([
    "service", "point of interest", "establishment", "store", "manufacturer", "corporate office",
    "business center", "consultant", "general contractor", "contractor",
    "home improvement store", "home goods store", "",
  ]);

  // "Services" and "service", "general_contractor" and "General Contractor" are the same
  // uselessness wearing different clothes.
  function isGeneric(label) {
    const flat = String(label || "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
    return GENERIC_TYPES.has(flat) || GENERIC_TYPES.has(flat.replace(/s$/, ""));
  }

  // One word in a business name, and the trade a homeowner would actually search for.
  // "Junk King" is not "junk king", it is junk removal.
  const TRADE_ANCHORS = [
    ["junk", "junk removal"], ["hauling", "junk removal"], ["dumpster", "dumpster rental"],
    ["window", "window cleaning"], ["roof", "roofing"], ["plumb", "plumbing"],
    ["hvac", "hvac"], ["heating", "hvac"], ["cooling", "hvac"], ["furnace", "hvac"],
    ["a/c", "hvac"], ["air condition", "hvac"], ["boiler", "hvac"],
    ["electric", "electrician"], ["paint", "painting"], ["landscap", "landscaping"],
    ["lawn", "lawn care"], ["tree", "tree service"], ["pest", "pest control"],
    ["fence", "fencing"], ["fencing", "fencing"], ["concrete", "concrete"],
    ["paving", "paving"], ["asphalt", "paving"], ["masonry", "masonry"],
    ["moving", "movers"], ["movers", "movers"], ["gutter", "gutter"],
    ["chimney", "chimney"], ["septic", "septic"], ["pool", "pool"], ["solar", "solar"],
    ["locksmith", "locksmith"], ["restoration", "restoration"], ["contracting", "general contractor"],
    ["remodel", "remodeling"], ["renovat", "renovation"], ["floor", "flooring"],
    ["deck", "deck"], ["garage", "garage door"], ["towing", "towing"],
    ["appliance", "appliance repair"], ["insulation", "insulation"],
    ["waterproof", "waterproofing"], ["drywall", "drywall"], ["siding", "siding"],
    ["washing", "pressure washing"], ["clean", "cleaning"], ["maid", "house cleaning"],
  ];

  // Trades we can recognise from a business name when Google's category is vague.
  const TRADE_TERMS = [
    "junk removal", "junk hauling", "dumpster rental", "demolition", "tree service", "tree removal",
    "stump grinding", "landscaping", "lawn care", "hardscaping", "roofing", "gutter", "siding",
    "plumbing", "drain cleaning", "septic", "hvac", "heating", "air conditioning", "electrical",
    "electrician", "solar", "painting", "pressure washing", "power washing", "window cleaning",
    "carpet cleaning", "house cleaning", "cleaning", "pest control", "exterminator", "garage door",
    "fencing", "fence", "deck", "concrete", "paving", "asphalt", "masonry", "remodeling", "renovation",
    "flooring", "tile", "cabinet", "countertop", "handyman",
    "moving", "movers", "restoration", "water damage", "mold", "pool", "irrigation", "locksmith",
    "appliance repair", "insulation", "foundation", "waterproofing", "chimney", "drywall",
    // Last, and deliberately so. Broad but real: people do search "general contractor near
    // me". Anything more specific in the same name wins because it is matched first.
    "general contractor", "contractor",
  ];

  // Different words for the same trade, mapped to the one a homeowner actually types into
  // Google. Without this a plumbing and heating company comes back as four "trades"
  // (plumber, plumbing, heating, hvac) that are really two.
  const CANON = {
    plumber: "plumber", plumbing: "plumber", "drain cleaning": "drain cleaning",
    hvac: "hvac", heating: "hvac", "air conditioning": "hvac", cooling: "hvac", furnace: "hvac",
    "hvac contractor": "hvac", "heating contractor": "hvac", "air conditioning contractor": "hvac",
    electrician: "electrician", electrical: "electrician",
    roofing: "roofer", roofer: "roofer", "roofing contractor": "roofer",
    painting: "painter", painter: "painter", "painting contractor": "painter",
    landscaping: "landscaping", landscaper: "landscaping", "lawn care": "lawn care",
    "tree service": "tree service", "tree removal": "tree service", "stump grinding": "tree service",
    "junk removal": "junk removal", "junk hauling": "junk removal",
    "pressure washing": "pressure washing", "power washing": "pressure washing",
    "window cleaning": "window cleaning", "house cleaning": "house cleaning", maid: "house cleaning",
    "pest control": "pest control", exterminator: "pest control",
    movers: "movers", moving: "movers", "moving company": "movers",
    fencing: "fencing", fence: "fencing", "fence contractor": "fencing",
    "garage door": "garage door", flooring: "flooring", remodeling: "remodeling",
    renovation: "remodeling", concrete: "concrete", "concrete contractor": "concrete",
    paving: "paving", asphalt: "paving", masonry: "masonry", siding: "siding",
    gutter: "gutter", chimney: "chimney", septic: "septic", solar: "solar",
    locksmith: "locksmith", restoration: "restoration", "water damage": "restoration",
    "appliance repair": "appliance repair", insulation: "insulation", waterproofing: "waterproofing",
    drywall: "drywall", deck: "deck builder", handyman: "handyman", towing: "towing",
    "general contractor": "general contractor", contractor: "general contractor",
  };

  const canon = (term) => {
    const flat = String(term || "").toLowerCase().replace(/_/g, " ").trim();
    return CANON[flat] || flat;
  };

  // Every trade this business plausibly sells, best guess first. Plenty of contractors do
  // two or three: "Dustin's Plumbing Heating and A/C Repair" is not just a plumber, so
  // picking one silently and never saying which was the wrong shape for this. Google's own
  // primary category leads, because the grid measures Google's ranking and that is the
  // category Google ranks them under. The rest are read out of the name.
  // Useless as a Google category, real as a search. "general contractor near me" is typed
  // by actual homeowners, so it stays available as a last resort even though it tells us
  // nothing about the trade.
  const SEARCHABLE_GENERIC = new Set(["general contractor"]);

  function tradesOf(profile) {
    const out = [];
    const add = (term) => {
      const t = canon(term);
      if (!t) return;
      if (isGeneric(t) && !SEARCHABLE_GENERIC.has(t)) return;
      if (out.includes(t)) return;
      // "window cleaning" already covers "cleaning", and offering both as separate keywords
      // invites someone to measure the vaguer of the two. Keep whichever is more specific.
      const broaderIndex = out.findIndex((have) => t.includes(have));
      if (out.some((have) => have.includes(t))) return;
      if (broaderIndex > -1) {
        out[broaderIndex] = t;
        return;
      }
      out.push(t);
    };

    if (!isGeneric(profile.primaryType)) add(profile.primaryType.replace(/_/g, " "));
    if (profile.category && !isGeneric(profile.category)) add(profile.category);

    const name = String(profile.name || "").toLowerCase();
    for (const term of TRADE_TERMS) {
      if (new RegExp("\\b" + term).test(name)) add(term);
    }
    for (const [word, trade] of TRADE_ANCHORS) {
      if (new RegExp("\\b" + word).test(name)) add(trade);
    }

    // "general contractor" is a real search but the vaguest one we recognise, so it never
    // outranks a specific trade found in the same name.
    const generalAt = out.indexOf("general contractor");
    if (generalAt > -1 && out.length > 1) {
      out.splice(generalAt, 1);
      out.push("general contractor");
    }
    return out.slice(0, 4);
  }

  // The one the grid searches. Returns "" when we genuinely cannot tell, and an empty
  // answer is the right answer: searching a business's own name back at Google either ranks
  // it first for a term nobody types, or nowhere at all, and both make a liar of the map.
  function tradeOf(profile) {
    return tradesOf(profile)[0] || "";
  }

  function toCompetitors(places, selfId) {
    // Keep Google's relevance order; sorting by review count floats big unrelated brands to the top.
    return (places || [])
      .filter((c) => c.id && c.id !== selfId && typeof c.rating === "number")
      .map((c) => ({
        id: c.id,
        name: c.displayName?.text || "",
        rating: c.rating,
        reviewCount: c.userRatingCount || 0,
        location: c.location ? { lat: c.location.latitude, lng: c.location.longitude } : null,
      }))
      .slice(0, 5);
  }

  async function fetchCompetitors(profile) {
    // Storefront with a specific category: search around their pin for the same category.
    if (profile.location && !GENERIC_TYPES.has(profile.primaryType)) {
      try {
        const data = await placesRequest("/places:searchNearby", {
          method: "POST",
          fieldMask: COMPETITOR_FIELDS,
          body: {
            includedPrimaryTypes: [profile.primaryType],
            maxResultCount: 10,
            rankPreference: "POPULARITY",
            locationRestriction: {
              circle: { center: { latitude: profile.location.lat, longitude: profile.location.lng }, radius: 25000 },
            },
          },
        });
        const found = toCompetitors(data.places, profile.id);
        if (found.length >= 2) return found;
      } catch (err) {
        console.warn("Nearby search failed, falling back to text search", err);
      }
    }

    // Otherwise search "<trade> near <city>" (service-area businesses have no pin at all).
    const what = tradeOf(profile);
    if (!what) return [];
    const where = cityOf(profile.address);
    const body = {
      textQuery: where ? `${what} near ${where}` : what,
      maxResultCount: 10,
      includePureServiceAreaBusinesses: true,
    };
    if (profile.location) {
      body.locationBias = {
        circle: { center: { latitude: profile.location.lat, longitude: profile.location.lng }, radius: 25000 },
      };
    }
    const data = await placesRequest("/places:searchText", { method: "POST", fieldMask: COMPETITOR_FIELDS, body });
    return toCompetitors(data.places, profile.id);
  }

  // Google PageSpeed Insights: a real mobile Lighthouse run. Needs the PageSpeed Insights API
  // enabled on the key; if it isn't, the step says the test will be in the full report.
  async function pageSpeed(site, strategy, signal) {
    const params = new URLSearchParams({ url: site, strategy });
    params.append("category", "performance");
    params.append("category", "seo");
    params.append("category", "accessibility");
    params.append("category", "best-practices");
    if (apiKey()) params.set("key", apiKey());

    let data = {};
    // Lighthouse occasionally fails a run with a 500; one retry usually succeeds.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${PSI_URL}?${params}`, { signal });
      data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) return data;
      if (attempt === 1 || res.status < 500) {
        throw new Error(data.error?.message || `PageSpeed returned ${res.status}`);
      }
    }
    return data;
  }

  // Some checks need the page source, which a browser cannot read cross-origin. When the
  // n8n site check is configured, it fetches the page and answers in about a second.
  // Without it the report simply leaves those findings out.
  async function fetchSiteCheck(url) {
    const endpoint = window.DIALBRIDGE_CONFIG?.N8N_SITE_CHECK_URL || "";
    if (!endpoint || !url) return null;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === "object" ? data : null;
    } catch (err) {
      console.warn("Site check unavailable", err);
      return null;
    }
  }

  async function fetchWebsite(url) {
    const site = safeUrl(url, { allowHttp: true });
    if (!site) return { hasWebsite: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      // Both runs at once: a phone test and a computer test cost the same wall clock as one.
      // The phone score is the one the report is built on. Desktop is a nice extra, so it
      // gets its own short leash: a slow desktop run can't sit on the whole report.
      const desktopRun = pageSpeed(site, "desktop", controller.signal).catch((err) => {
        console.warn("Desktop speed test unavailable", err);
        return null;
      });
      const [data, desktop] = await Promise.all([
        pageSpeed(site, "mobile", controller.signal),
        Promise.race([desktopRun, new Promise((resolve) => setTimeout(() => resolve(null), DESKTOP_CAP_MS))]),
      ]);

      const lighthouse = data.lighthouseResult || {};
      const audits = lighthouse.audits || {};
      const performance = lighthouse.categories?.performance?.score;
      const finalUrl = lighthouse.finalDisplayedUrl || lighthouse.finalUrl || site;
      // Lighthouse 13 renamed the "viewport" audit to "viewport-insight"; accept either.
      const viewportAudit = audits["viewport-insight"] || audits.viewport;
      const scoreOf = (audit) => (audit && typeof audit.score === "number" ? audit.score === 1 : null);
      const desktopLighthouse = desktop?.lighthouseResult || {};
      const desktopPerformance = desktopLighthouse.categories?.performance?.score;

      // Lighthouse renames audits between versions, so accept either id.
      const audit = (...ids) => ids.map((id) => audits[id]).find(Boolean);
      const failed = (a) => (a && typeof a.score === "number" ? a.score < 0.9 : null);
      const itemCount = (a) => (a?.details?.items?.length ?? null);
      const shot = audits["final-screenshot"]?.details?.data || "";

      const tapTargets = audit("target-size", "tap-targets");
      const fontSize = audit("font-size", "legible-font-sizes");
      const contrast = audit("color-contrast");

      return {
        hasWebsite: true,
        checked: true,
        url: site,
        speedScore: typeof performance === "number" ? Math.round(performance * 100) : null,
        loadTime: audits["largest-contentful-paint"]?.displayValue || "",
        desktopScore: typeof desktopPerformance === "number" ? Math.round(desktopPerformance * 100) : null,
        desktopLoadTime: desktopLighthouse.audits?.["largest-contentful-paint"]?.displayValue || "",
        seoScore: typeof lighthouse.categories?.seo?.score === "number" ? Math.round(lighthouse.categories.seo.score * 100) : null,
        mobileFriendly: scoreOf(viewportAudit),
        https: /^https:/i.test(finalUrl),
        hasTitle: scoreOf(audits["document-title"]),
        // How the site actually comes across on a phone, not just how fast it is.
        screenshot: /^data:image\//.test(shot) ? shot : "",
        accessibilityScore: typeof lighthouse.categories?.accessibility?.score === "number"
          ? Math.round(lighthouse.categories.accessibility.score * 100) : null,
        bestPracticesScore: typeof lighthouse.categories?.["best-practices"]?.score === "number"
          ? Math.round(lighthouse.categories["best-practices"].score * 100) : null,
        tinyTapTargets: failed(tapTargets) ? itemCount(tapTargets) ?? true : false,
        tinyText: failed(fontSize) === null ? null : failed(fontSize),
        poorContrast: failed(contrast) ? itemCount(contrast) ?? true : false,
      };
    } catch (err) {
      console.warn("Website speed test unavailable", err);
      return { hasWebsite: true, checked: false, url: site };
    } finally {
      clearTimeout(timer);
    }
  }

  // ============ SCREEN ============

  function resetSteps(name) {
    $("scanSteps").replaceChildren(
      ...STEPS.map((step) =>
        h("li", { class: "scan-step", id: `scanStep-${step.key}` }, [
          h("span", { class: "scan-step-icon", "aria-hidden": "true" }),
          h("span", { class: "scan-step-label", text: step.label(name) }),
        ])
      )
    );
    setProgress(0);
  }

  function setProgress(completed) {
    const pct = Math.round((completed / STEPS.length) * 100);
    $("scanProgressFill").style.width = `${pct}%`;
    $("scanProgress").setAttribute("aria-valuenow", String(pct));
    $("scanProgressLabel").textContent =
      completed >= STEPS.length ? "Scan complete" : `Step ${completed + 1} of ${STEPS.length}`;
  }

  function setStepState(key, state) {
    const item = $(`scanStep-${key}`);
    if (!item) return;
    item.classList.toggle("is-active", state === "active");
    item.classList.toggle("is-done", state === "done");
  }

  function showLive(label, content) {
    const live = $("scanLive");
    live.replaceChildren(h("p", { class: "live-label", text: label }), content);
    live.classList.remove("is-entering");
    void live.offsetWidth; // restart the fade-in
    live.classList.add("is-entering");
  }

  function waiting(text) {
    return h("div", { class: "live-waiting" }, [
      h("span", { class: "spinner", "aria-hidden": "true" }),
      h("p", { class: "muted", text }),
    ]);
  }

  // ============ STEP VISUALS ============

  function renderProfile(p) {
    const photo = photoUrl(p.photos[0], 640);
    const where = p.serviceAreaOnly ? `Serves ${cityOf(p.address) || "a service area"}` : p.address;
    return h("div", { class: "live-profile" }, [
      photo
        ? img(photo, { class: "live-profile-photo" })
        : h("div", { class: "live-profile-photo is-empty", text: "No photos on this profile" }),
      h("div", { class: "live-profile-body" }, [
        h("h3", { text: p.name }),
        p.rating !== null
          ? h("p", { class: "live-rating" }, [
              h("span", { class: "stars", "aria-hidden": "true", text: stars(p.rating) }),
              ` ${p.rating.toFixed(1)} · ${p.reviewCount} review${p.reviewCount === 1 ? "" : "s"}`,
            ])
          : h("p", { class: "muted", text: "No Google reviews yet" }),
        p.category ? h("p", { class: "muted", text: p.category }) : null,
        where ? h("p", { class: "muted", text: where }) : null,
      ]),
    ]);
  }

  function staticMapUrl(p, competitors) {
    const rivals = competitors
      .filter((c) => c.location)
      .map((c) => `${c.location.lat.toFixed(5)},${c.location.lng.toFixed(5)}`);
    if (!rivals.length && !p.location) return "";
    const url = new URL(STATIC_MAP_URL);
    url.searchParams.set("size", "640x320");
    url.searchParams.set("scale", "2");
    url.searchParams.set("key", apiKey());
    if (rivals.length) url.searchParams.append("markers", `size:mid|color:0x44526a|${rivals.join("|")}`);
    if (p.location) {
      url.searchParams.append("markers", `color:0xe8702a|label:Y|${p.location.lat.toFixed(5)},${p.location.lng.toFixed(5)}`);
    }
    return url.toString();
  }

  function renderCompetitors(p, competitors) {
    const rows = [{ name: `${p.name} (you)`, rating: p.rating, reviewCount: p.reviewCount, you: true }]
      .concat(competitors.slice(0, 3));
    return h("div", { class: "live-competitors" }, [
      img(staticMapUrl(p, competitors), { class: "live-map", alt: "Map of nearby competitors" }),
      competitors.length
        ? h("table", { class: "live-compare" }, [
            h("thead", {}, h("tr", {}, [h("th", { text: "Business" }), h("th", { text: "Rating" }), h("th", { text: "Reviews" })])),
            h("tbody", {}, rows.map((row) =>
              h("tr", { class: row.you ? "is-you" : null }, [
                h("td", { text: row.name }),
                h("td", { text: typeof row.rating === "number" ? `${row.rating.toFixed(1)}★` : "None" }),
                h("td", { text: String(row.reviewCount || 0) }),
              ])
            )),
          ])
        : h("p", { class: "muted", text: "We couldn't find close competitors on Google for this category." }),
    ]);
  }

  // What this step did, not what it found. The map and the positions are the payoff of the
  // report, and showing them here spends the reveal before the lead has given us anything.
  function renderRankGrid(ranking) {
    if (!ranking || !Array.isArray(ranking.ranks) || !ranking.ranks.length) {
      return h("p", { class: "muted", text: "We could not measure your map position for this business. The rest of your report is not affected." });
    }
    return h("div", { class: "live-rank" }, [
      h("p", { class: "live-rank-line" }, [
        `We searched "${ranking.keyword}" from `,
        h("strong", { text: `${ranking.ranks.length} spots` }),
        " around your address.",
      ]),
      h("p", { class: "muted", text: `About ${ranking.pointDistanceMiles} miles apart, the way a homeowner across town would search. Your position at each one is in your report.` }),
    ]);
  }

  function sentimentOf(reviews) {
    if (!reviews.length) return { label: "No reviews to read yet", tone: "warn" };
    const average = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
    if (average >= 4.5) return { label: "Recent customers sound happy", tone: "good" };
    if (average >= 3.5) return { label: "Recent reviews are mixed", tone: "warn" };
    return { label: "Recent reviews are hurting you", tone: "bad" };
  }

  function renderReviews(p) {
    const sentiment = sentimentOf(p.reviews);
    const cards = p.reviews.slice(0, 3).map((r) =>
      h("article", { class: "live-review" }, [
        h("div", { class: "live-review-head" }, [
          r.authorPhoto
            ? img(r.authorPhoto, { class: "avatar", referrerpolicy: "no-referrer" })
            : h("span", { class: "avatar is-initial", "aria-hidden": "true", text: r.author.charAt(0).toUpperCase() }),
          h("span", { class: "live-review-author" }, [h("strong", { text: r.author }), h("span", { class: "muted", text: r.when })]),
          h("span", { class: "stars", "aria-label": `${r.rating} out of 5 stars`, text: "★".repeat(r.rating) }),
        ]),
        r.text ? h("p", { class: "live-review-text", text: r.text.length > 170 ? `${r.text.slice(0, 170).trimEnd()}…` : r.text }) : null,
      ])
    );
    return h("div", { class: "live-reviews" }, [
      h("p", { class: `badge badge-${sentiment.tone}`, text: sentiment.label }),
      ...(cards.length ? cards : [h("p", { class: "muted", text: "Homeowners look at reviews before they call anyone." })]),
    ]);
  }

  function renderPhotos(p) {
    const count = p.photos.length; // Google returns at most 10
    const tone = count >= 10 ? "good" : count >= 5 ? "warn" : "bad";
    const text =
      count >= 10 ? "10 or more photos on your profile"
        : count === 0 ? "No photos on your profile"
        : `Only ${count} photo${count === 1 ? "" : "s"} on your profile`;
    return h("div", { class: "live-photos" }, [
      count ? h("div", { class: "collage" }, p.photos.slice(0, 4).map((name) => img(photoUrl(name, 360)))) : null,
      h("p", { class: `badge badge-${tone}`, text }),
    ]);
  }

  function speedTone(score) {
    if (score === null) return "warn";
    return score >= 90 ? "good" : score >= 50 ? "warn" : "bad";
  }

  function renderWebsite(w) {
    if (!w.hasWebsite) {
      return h("div", { class: "live-website" }, [
        h("p", { class: "badge badge-bad", text: "No website linked on Google" }),
        h("p", { class: "muted", text: "Homeowners who can't find a website usually call the next company on the list." }),
      ]);
    }
    const domain = w.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    if (!w.checked) {
      return h("div", { class: "live-website" }, [
        h("p", { class: "live-domain", text: domain }),
        h("p", { class: "muted", text: "The full phone speed test will be in your report." }),
      ]);
    }
    const checks = [
      { ok: w.mobileFriendly, text: w.mobileFriendly ? "Fits a phone screen" : "Not set up for phones" },
      { ok: w.https, text: w.https ? "Secure (HTTPS)" : "Not secure (no HTTPS)" },
      { ok: w.hasTitle, text: w.hasTitle ? "Has a page title for Google" : "Missing a page title for Google" },
    ].filter((c) => c.ok !== null);
    return h("div", { class: "live-website" }, [
      h("div", { class: "phone" }, h("div", { class: "phone-screen" }, [
        h("div", { class: `score-ring tone-${speedTone(w.speedScore)}`, style: `--pct:${w.speedScore ?? 0}` },
          h("span", {}, [h("strong", { text: w.speedScore ?? "?" }), h("small", { text: "phone speed" })])),
        w.loadTime ? h("p", { class: "muted", text: `Main content shows in ${w.loadTime}` }) : null,
      ])),
      h("p", { class: "live-domain", text: domain }),
      h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
    ]);
  }

  function renderReach(p) {
    const items = [
      { ok: Boolean(p.phone), text: p.phone ? `Phone number listed: ${p.phone}` : "No phone number on Google" },
      { ok: Boolean(p.website), text: p.website ? "Website linked from Google" : "No website linked from Google" },
      { ok: p.hasHours, text: p.hasHours ? "Business hours listed" : "No business hours listed" },
    ];
    return h("div", { class: "live-reach" }, [
      h("ul", { class: "checks checks-lg" }, items.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
      h("p", { class: "muted", text: "Your full report also covers what happens when a customer calls, texts or messages you." }),
    ]);
  }

  // ============ FINDINGS ============

  function findingsFor(p, competitors, w) {
    const out = [];
    const leader = competitors[0];
    if (leader && leader.reviewCount > p.reviewCount) {
      out.push({ tone: "bad", text: `${leader.name} has ${leader.reviewCount} Google reviews. You have ${p.reviewCount}.` });
    }
    if (competitors.length && p.rating !== null) {
      const average = competitors.reduce((sum, c) => sum + c.rating, 0) / competitors.length;
      if (p.rating < average - 0.1) {
        out.push({ tone: "warn", text: `Your ${p.rating.toFixed(1)}★ rating is below the local average of ${average.toFixed(1)}★.` });
      }
    }
    if (!w.hasWebsite) out.push({ tone: "bad", text: "There's no website linked on your Google profile." });
    else if (w.checked && w.speedScore !== null && w.speedScore < 50) {
      out.push({ tone: "bad", text: `Your website scored ${w.speedScore} out of 100 for speed on a phone.` });
    }
    if (w.checked && w.https === false) {
      out.push({ tone: "bad", text: "Browsers label your website \"Not secure\" because it has no HTTPS." });
    }
    if (w.checked && w.mobileFriendly === false) {
      out.push({ tone: "bad", text: "Your website isn't set up to fit a phone screen." });
    }
    if (!p.phone) out.push({ tone: "bad", text: "There's no phone number on your Google profile." });
    if (p.photos.length < 5) {
      out.push({ tone: "warn", text: p.photos.length ? `Your profile only has ${p.photos.length} photos.` : "Your profile has no photos." });
    }
    if (!p.hasHours) out.push({ tone: "warn", text: "Your business hours aren't listed on Google." });
    return out.slice(0, 3);
  }

  function showDone(p, findings) {
    $("scanDoneTitle").textContent = findings.length
      ? `We found ${findings.length === 1 ? "1 thing" : `${findings.length} things`} that could be costing ${p.name} jobs`
      : `${p.name} looks strong on Google`;
    $("scanFindings").replaceChildren(
      ...findings.map((f) => h("li", { class: `finding finding-${f.tone}`, text: f.text }))
    );
    const done = $("scanDone");
    done.hidden = false;
    done.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "nearest" });
  }

  // ============ RUN ============

  async function start(business) {
    if (running || !business?.placeId) return;
    running = true;
    cancelled = false;
    showBack(true);

    document.querySelector("main.hero").hidden = true;
    // How-it-works lives outside the hero so it can be wider than it; that means it has to
    // be hidden alongside it rather than with it.
    const how = $("how");
    if (how) how.hidden = true;
    $("scanDone").hidden = true;
    $("scan").hidden = false;
    $("scanTitle").textContent = `Scanning ${business.name}`;
    resetSteps(business.name);
    $("scanLive").replaceChildren(waiting("Connecting to Google..."));
    window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? "auto" : "smooth" });

    // Fall back to what the search step already loaded if the deeper lookup fails.
    const baseline = {
      id: business.placeId,
      name: business.name,
      address: business.address || "",
      location: business.lat != null && business.lng != null ? { lat: business.lat, lng: business.lng } : null,
      rating: typeof business.rating === "number" ? business.rating : null,
      reviewCount: business.reviewCount || 0,
      website: business.website || "",
      phone: business.phone || "",
      primaryType: business.primaryType || "",
      category: "",
      photos: [],
      reviews: [],
      summary: "",
      hasHours: false,
      serviceAreaOnly: Boolean(business.serviceAreaOnly),
    };

    // Start every lookup right away; the steps below reveal them one at a time.
    const profileReady = fetchProfile(business.placeId).catch((err) => {
      console.warn("Profile lookup failed", err);
      return baseline;
    });
    const competitorsReady = profileReady.then(fetchCompetitors).catch((err) => {
      console.warn("Competitor lookup failed", err);
      return [];
    });
    // The grid needs the pin to search around and the competitor list to put names to the
    // companies beating them, so it waits on both. Nine searches in parallel, about a
    // second, and free: the field mask asks Google for place IDs and nothing else.
    const rankingReady = Promise.all([profileReady, competitorsReady])
      .then(([p, comps]) => window.DialBridgeEngine?.fetchRanking(p, tradeOf(p), comps) || null)
      .catch((err) => {
        console.warn("Ranking grid failed", err);
        return null;
      });

    const websiteReady = profileReady.then(async (p) => {
      const [site, extra] = await Promise.all([fetchWebsite(p.website), fetchSiteCheck(p.website)]);
      if (!extra || !extra.checked) return site;
      // A tappable number that isn't the one on Google is worse than no number at all.
      const googleDigits = String(p.phone || "").replace(/\D/g, "").slice(-10);
      const callNumberMatchesGoogle = (extra.telNumbers || []).length && googleDigits
        ? extra.telNumbers.some((t) => t === googleDigits)
        : null;
      return { ...site, ...extra, callNumberMatchesGoogle };
    });

    const results = {
      profile: baseline,
      competitors: [],
      ranking: null,
      website: { hasWebsite: Boolean(baseline.website), checked: false, url: baseline.website },
    };

    for (let i = 0; i < STEPS.length; i++) {
      if (cancelled) return;
      const step = STEPS[i];
      const minimum = wait(MIN_STEP_MS);
      setProgress(i);
      setStepState(step.key, "active");
      $("scanAnnounce").textContent = step.label(business.name);

      try {
        if (step.key === "profile") {
          results.profile = await withCap(profileReady, DATA_CAP_MS, baseline);
          showLive("Found your Google profile", renderProfile(results.profile));
        } else if (step.key === "competitors") {
          showLive("Looking around your area", waiting("Finding the businesses competing for your customers..."));
          results.competitors = await withCap(competitorsReady, DATA_CAP_MS, []);
          showLive("Who homeowners compare you to", renderCompetitors(results.profile, results.competitors));
        } else if (step.key === "ranking") {
          showLive("Searching from nine spots around you", waiting("Asking Google where you come up from each corner of your service area..."));
          results.ranking = await withCap(rankingReady, DATA_CAP_MS, null);
          showLive("Where you show up on the map", renderRankGrid(results.ranking));
        } else if (step.key === "reviews") {
          showLive("What customers are saying", renderReviews(results.profile));
        } else if (step.key === "photos") {
          showLive("Photos homeowners see first", renderPhotos(results.profile));
        } else if (step.key === "website") {
          if (results.profile.website) showLive("Loading your site on a phone", waiting("Running a real speed test on a phone and a computer..."));
          results.website = await withCap(websiteReady, WEBSITE_CAP_MS, results.website);
          showLive("How your website does on a phone", renderWebsite(results.website));
        } else if (step.key === "reach") {
          showLive("How customers can reach you", renderReach(results.profile));
        }
      } catch (err) {
        console.warn(`Scan step "${step.key}" failed`, err);
      }

      await minimum;
      setStepState(step.key, "done");
    }

    if (cancelled) return;
    setProgress(STEPS.length);
    $("scanAnnounce").textContent = "Scan complete";
    const findings = findingsFor(results.profile, results.competitors, results.website);
    // The trade we searched for, kept so the emailed ranking grid asks the same question.
    // Google's category is "service" for a lot of real trades, and a grid built on that
    // word finds nothing and reports the business as ranking nowhere.
    // Every candidate trade goes with it, so the report can offer to re-measure the map on
    // another one. The grid is free, so a second opinion costs nothing.
    window.scanResult = { ...results, findings, trade: tradeOf(results.profile), trades: tradesOf(results.profile) };
    running = false;

    // Build the report right here from what we already pulled from Google, map included.
    // Nothing waits on n8n or GHL, and nothing is held back for an email address.
    try {
      // If the speed test was still running when its step ended, wait for it here, but say
      // so on screen. A silent gap after "Scan complete" reads as a broken page.
      if (results.profile.website && !results.website.checked) {
        $("scanAnnounce").textContent = "Finishing the website test";
        showLive("Finishing the website test", waiting("Waiting on the last of the speed test, then your report opens..."));
        results.website = await withCap(websiteReady, WEBSITE_FINAL_CAP_MS, results.website);
        window.scanResult.website = results.website;
      }
      if (cancelled) return;
      const built = window.DialBridgeEngine?.buildReport({
        profile: results.profile,
        competitors: results.competitors,
        website: results.website,
        ranking: results.ranking,
        trade: tradeOf(results.profile),
        answers: window.leadAnswers || {},
        submissionId: window.reportSubmissionId || null,
      });
      if (built) window.DialBridgeReport?.showLocal(built);
      else showDone(results.profile, findings);
    } catch (err) {
      console.warn("Could not build the report", err);
      showDone(results.profile, findings);
    }
  }

  function showBack(on) {
    const back = document.getElementById("homeBack");
    if (back) back.hidden = !on;
  }

  function reset() {
    // No running guard here: a way out that stops working halfway through a scan is not a
    // way out. The scan sees cancelled and gives up on its own.
    cancelled = true;
    running = false;
    window.DialBridgeReport?.reset();
    window.DialBridgeQuestions?.reset();
    $("scan").hidden = true;
    document.querySelector("main.hero").hidden = false;
    const how = $("how");
    if (how) how.hidden = false;
    document.getElementById("clearBtn")?.click();
    showBack(false);
    window.scrollTo({ top: 0 });
    document.getElementById("bizInput")?.focus();
  }

  // h is shared with report.js so the full report is built with the same safe, text-only DOM helper.
  window.DialBridgeScan = { start, reset, showBack, h, img, tradesOf, tradeOf };
})();
