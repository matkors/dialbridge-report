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
  const MIN_STEP_MS = REDUCED_MOTION ? 1200 : 3200; // each step stays up at least this long
  const DATA_CAP_MS = 18000; // never let one slow API hold a step longer than this
  const WEBSITE_CAP_MS = 30000; // phone speed tests are slower

  const STEPS = [
    { key: "profile", label: (name) => `Finding ${name} on Google` },
    { key: "competitors", label: () => "Comparing you to nearby competitors" },
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

  async function fetchProfile(placeId) {
    const p = await placesRequest(`/places/${encodeURIComponent(placeId)}`, { fieldMask: PROFILE_FIELDS });
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

  function toCompetitors(places, selfId) {
    return (places || [])
      .filter((c) => c.id && c.id !== selfId && typeof c.rating === "number")
      .map((c) => ({
        id: c.id,
        name: c.displayName?.text || "",
        rating: c.rating,
        reviewCount: c.userRatingCount || 0,
        location: c.location ? { lat: c.location.latitude, lng: c.location.longitude } : null,
      }))
      .sort((a, b) => b.reviewCount - a.reviewCount)
      .slice(0, 5);
  }

  async function fetchCompetitors(profile) {
    // Businesses with a storefront: search around their pin for the same category.
    if (profile.location && profile.primaryType) {
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

    // Service-area businesses have no pin, so search "<category> near <city>" instead.
    const what = profile.category || profile.primaryType.replace(/_/g, " ") || "local services";
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
  async function fetchWebsite(url) {
    const site = safeUrl(url, { allowHttp: true });
    if (!site) return { hasWebsite: false };

    const params = new URLSearchParams({ url: site, strategy: "mobile" });
    params.append("category", "performance");
    params.append("category", "seo");
    if (apiKey()) params.set("key", apiKey());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(`${PSI_URL}?${params}`, { signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error?.message || `PageSpeed returned ${res.status}`);

      const lighthouse = data.lighthouseResult || {};
      const audits = lighthouse.audits || {};
      const performance = lighthouse.categories?.performance?.score;
      const finalUrl = lighthouse.finalDisplayedUrl || lighthouse.finalUrl || site;
      return {
        hasWebsite: true,
        checked: true,
        url: site,
        speedScore: typeof performance === "number" ? Math.round(performance * 100) : null,
        loadTime: audits["largest-contentful-paint"]?.displayValue || "",
        mobileFriendly: audits.viewport ? audits.viewport.score === 1 : null,
        https: /^https:/i.test(finalUrl),
        hasTitle: audits["document-title"] ? audits["document-title"].score === 1 : null,
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

    document.querySelector("main.hero").hidden = true;
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
    const websiteReady = profileReady.then((p) => fetchWebsite(p.website));

    const results = {
      profile: baseline,
      competitors: [],
      website: { hasWebsite: Boolean(baseline.website), checked: false, url: baseline.website },
    };

    for (let i = 0; i < STEPS.length; i++) {
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
        } else if (step.key === "reviews") {
          showLive("What customers are saying", renderReviews(results.profile));
        } else if (step.key === "photos") {
          showLive("Photos homeowners see first", renderPhotos(results.profile));
        } else if (step.key === "website") {
          if (results.profile.website) showLive("Loading your site on a phone", waiting("Running a real phone speed test..."));
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

    setProgress(STEPS.length);
    $("scanAnnounce").textContent = "Scan complete";
    const findings = findingsFor(results.profile, results.competitors, results.website);
    window.scanResult = { ...results, findings };
    showDone(results.profile, findings);
    running = false;
  }

  function reset() {
    if (running) return;
    $("scan").hidden = true;
    document.querySelector("main.hero").hidden = false;
    document.getElementById("clearBtn")?.click();
    window.scrollTo({ top: 0 });
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("scanRestart")?.addEventListener("click", reset);
  });

  window.DialBridgeScan = { start, reset };
})();
