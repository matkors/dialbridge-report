// Business search using the Google Places API (New) web service, called from the browser.
// We call the REST API directly (not the Maps JavaScript library) because only the REST API
// can include service-area businesses, and most contractors are service-area businesses.
// The key lives in config.js (written at deploy from a GitHub secret). See README.md.

const input = document.getElementById("bizInput");
const resultsBox = document.getElementById("bizResults");
const list = document.getElementById("bizList");
const statusEl = document.getElementById("status");
const reportBtn = document.getElementById("reportBtn");
const pickedEl = document.getElementById("picked");

const API_KEY = window.DIALBRIDGE_CONFIG?.GOOGLE_MAPS_API_KEY || "";
const REPORT_WEBHOOK_URL = window.DIALBRIDGE_CONFIG?.N8N_REPORT_WEBHOOK_URL || "";
const PLACES_URL = "https://places.googleapis.com/v1";
const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;

// Place Details fields. Phone, website, rating and review count bill as Place Details Enterprise.
// Everything the search box AND the scan need, in one lookup. The scan used to fetch the
// same place again with a longer list of fields, which Google bills as a second call at a
// higher tier. Asking once for the union costs less than asking twice for halves, and the
// scan starts a round trip sooner. Google prices Place Details by the priciest field asked
// for, and reviews plus editorialSummary are the top tier, so those two set the price here.
const DETAIL_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "shortFormattedAddress",
  "nationalPhoneNumber",
  "websiteUri",
  "rating",
  "userRatingCount",
  "googleMapsUri",
  "location",
  "primaryType",
  "primaryTypeDisplayName",
  "pureServiceAreaBusiness",
  "photos",
  "reviews",
  "editorialSummary",
  "regularOpeningHours",
].join(",");

// Streets, cities and zip codes aren't businesses, so keep them out of the dropdown.
const ADDRESS_TYPES = new Set([
  "route", "street_address", "street_number", "intersection", "premise", "subpremise",
  "locality", "sublocality", "neighborhood", "postal_code", "political", "country",
  "administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3",
  "geocode",
]);

let sessionToken = crypto.randomUUID(); // groups one search + one details lookup into a billing session
let suggestions = [];
let activeIndex = -1;
let debounceTimer = null;
let latestRequest = 0; // ignore responses that arrive out of order

window.selectedBusiness = null;

function setStatus(message, isError = false, isSuccess = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.toggle("success", isSuccess);
}

function isAddressOnly(prediction) {
  const types = prediction.types || [];
  return types.length > 0 && types.every((t) => ADDRESS_TYPES.has(t));
}

async function placesRequest(path, { method = "GET", body, fieldMask } = {}) {
  const headers = { "X-Goog-Api-Key": API_KEY };
  if (body) headers["Content-Type"] = "application/json";
  if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;

  const res = await fetch(`${PLACES_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const message = data.error?.message || `Google returned ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function openList() {
  resultsBox.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function closeList() {
  resultsBox.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  activeIndex = -1;
}

function renderSuggestions() {
  list.innerHTML = "";
  suggestions.forEach((s, i) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `opt-${i}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(i === activeIndex));

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.mainText;
    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = s.secondaryText;

    btn.append(name, addr);
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
    btn.addEventListener("click", () => selectSuggestion(i));
    li.appendChild(btn);
    list.appendChild(li);
  });

  if (suggestions.length) openList();
  else closeList();
}

async function fetchSuggestions(query) {
  const requestId = ++latestRequest;

  try {
    const data = await placesRequest("/places:autocomplete", {
      method: "POST",
      body: {
        input: query,
        sessionToken,
        includedRegionCodes: ["us"],
        // Most contractors hide their address and only list a service area.
        // Google leaves those businesses out unless this is on.
        includePureServiceAreaBusinesses: true,
      },
    });
    if (requestId !== latestRequest) return; // a newer keystroke already fired

    suggestions = (data.suggestions || [])
      .map((s) => s.placePrediction)
      .filter((p) => p && !isAddressOnly(p))
      .map((p) => ({
        placeId: p.placeId,
        mainText: p.structuredFormat?.mainText?.text || p.text?.text || "",
        secondaryText: p.structuredFormat?.secondaryText?.text || "",
      }));

    activeIndex = -1;
    renderSuggestions();
    setStatus(suggestions.length ? "" : "No matches yet. Try adding your city.");
  } catch (err) {
    if (requestId !== latestRequest) return;
    console.error(err);
    setStatus(`Search failed: ${err.message}`, true);
  }
}

async function selectSuggestion(index) {
  const chosen = suggestions[index];
  if (!chosen) return;

  input.value = chosen.mainText;
  closeList();
  window.selectedPlace = null;
  setStatus("Looking up business details...");

  try {
    const place = await placesRequest(
      `/places/${encodeURIComponent(chosen.placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`,
      { fieldMask: DETAIL_FIELDS }
    );

    // Handed to the scan so it does not pay for the same lookup twice.
    window.selectedPlace = place;

    window.selectedBusiness = {
      placeId: place.id,
      name: place.displayName?.text || chosen.mainText,
      address: place.formattedAddress || chosen.secondaryText || null,
      serviceAreaOnly: Boolean(place.pureServiceAreaBusiness),
      phone: place.nationalPhoneNumber || null,
      website: place.websiteUri || null,
      rating: place.rating ?? null,
      reviewCount: place.userRatingCount ?? null,
      primaryType: place.primaryType || null,
      mapsUrl: place.googleMapsUri || null,
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
    };

    renderPicked(window.selectedBusiness);
    reportBtn.disabled = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't load that business's details: ${err.message}`, true);
  } finally {
    sessionToken = crypto.randomUUID(); // next search starts a new session
  }
}

function linkOrText(url, label) {
  if (!url) return document.createTextNode("Not listed");
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = label || url;
  return a;
}

function renderPicked(b) {
  document.getElementById("pName").textContent = b.name || "";
  document.getElementById("pAddress").textContent = b.address
    ? `${b.address}${b.serviceAreaOnly ? " (service area, address hidden)" : ""}`
    : "Not listed";
  document.getElementById("pPhone").textContent = b.phone || "Not listed";
  document.getElementById("pWebsite").replaceChildren(linkOrText(b.website));
  document.getElementById("pRating").textContent =
    b.rating != null ? `${b.rating} stars from ${b.reviewCount ?? 0} reviews` : "No reviews yet";
  document.getElementById("pMaps").replaceChildren(linkOrText(b.mapsUrl, "Open listing"));
  document.getElementById("pId").textContent = b.placeId || "";
  pickedEl.hidden = false;
}

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  reportBtn.disabled = true;
  reportBtn.textContent = "Get my report";
  window.selectedBusiness = null;
  const query = input.value.trim();
  if (query.length < MIN_CHARS) {
    latestRequest++; // cancel any in-flight response
    suggestions = [];
    closeList();
    setStatus("");
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggestions(query), DEBOUNCE_MS);
});

input.addEventListener("keydown", (e) => {
  if (resultsBox.hidden || !suggestions.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex = (activeIndex + 1) % suggestions.length;
    renderSuggestions();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === "Enter" && activeIndex >= 0) {
    e.preventDefault();
    selectSuggestion(activeIndex);
    return;
  } else if (e.key === "Escape") {
    closeList();
    return;
  }
  if (activeIndex >= 0) input.setAttribute("aria-activedescendant", `opt-${activeIndex}`);
});

input.addEventListener("blur", () => setTimeout(closeList, 120));

document.getElementById("clearBtn").addEventListener("click", () => {
  input.value = "";
  pickedEl.hidden = true;
  reportBtn.disabled = true;
  reportBtn.textContent = "Get my report";
  window.selectedBusiness = null;
  input.focus();
});

document.getElementById("cantFind").addEventListener("click", () => {
  setStatus("Manual entry and phone number search come next in the build.");
});

// The logo goes home, the way it does on every other site, and there is an explicit way
// out beside it for anyone who does not think to try the logo.
function goHome() {
  window.DialBridgeScan?.reset();
}
document.getElementById("homeBrand")?.addEventListener("click", goHome);
document.getElementById("homeBack")?.addEventListener("click", goHome);

let submitting = false;

function requestReport() {
  const business = window.selectedBusiness;
  if (!business || submitting) return;

  // Ask the three questions first. Everything we read from Google is about getting found;
  // these answers are the only way to price what happens to a lead after it arrives.
  // Every new scan asks again: the answers belong to the business being scanned, and a
  // refresh restores the finished report instead of coming back through here.
  if (window.DialBridgeQuestions && !window.leadAnswers) {
    window.DialBridgeQuestions.start(() => runReport(business));
    return;
  }
  runReport(business);
}

async function runReport(business) {
  // Show the scanning screen immediately; the report request runs alongside it.
  window.DialBridgeScan?.start(business);

  if (!REPORT_WEBHOOK_URL) {
    console.warn("Report webhook URL missing; scan runs but no report request is sent.");
    return;
  }

  submitting = true;
  reportBtn.disabled = true;
  const originalLabel = reportBtn.textContent;
  reportBtn.textContent = "Sending...";

  try {
    const res = await fetch(REPORT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_fax: document.getElementById("companyFax").value,
        answers: window.leadAnswers || {},
        business: {
          placeId: business.placeId,
          name: business.name,
          address: business.address,
          serviceAreaOnly: business.serviceAreaOnly,
          phone: business.phone,
          website: business.website,
          rating: business.rating,
          reviewCount: business.reviewCount,
          primaryType: business.primaryType,
          mapsUrl: business.mapsUrl,
          lat: business.lat,
          lng: business.lng,
        },
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    window.reportSubmissionId = data.submissionId;
    reportBtn.textContent = "Report requested";
    // The page builds and shows its own report from Google. The deeper audit keeps running
    // in GHL and gets emailed once the lead gives us their address.
  } catch (err) {
    console.error("Report request failed", err);
    reportBtn.textContent = originalLabel;
    reportBtn.disabled = false;
  } finally {
    submitting = false;
  }
}

reportBtn.addEventListener("click", requestReport);

if (!API_KEY || API_KEY.startsWith("PASTE_")) {
  setStatus("No Google Maps API key yet. Add it to config.js locally or the GOOGLE_MAPS_API_KEY secret on GitHub.", true);
  input.disabled = true;
}
