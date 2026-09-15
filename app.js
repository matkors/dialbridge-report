// Business search using Google Places (New) through the Maps JavaScript API.
// The key lives in config.js (gitignored). See README.md for setup.

const input = document.getElementById("bizInput");
const resultsBox = document.getElementById("bizResults");
const list = document.getElementById("bizList");
const statusEl = document.getElementById("status");
const reportBtn = document.getElementById("reportBtn");
const pickedEl = document.getElementById("picked");

const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;

let places = null;          // google.maps.places library once loaded
let sessionToken = null;    // groups one search + one details lookup into a billing session
let suggestions = [];
let activeIndex = -1;
let debounceTimer = null;
let latestRequest = 0;      // ignore responses that arrive out of order

window.selectedBusiness = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function loadGoogleMaps() {
  const key = window.DIALBRIDGE_CONFIG?.GOOGLE_MAPS_API_KEY;
  if (!key || key.startsWith("PASTE_")) {
    setStatus("No Google Maps API key yet. Copy config.example.js to config.js and add your key (see README).", true);
    input.disabled = true;
    return Promise.reject(new Error("missing key"));
  }

  return new Promise((resolve, reject) => {
    window.__dialbridgeMapsReady = resolve;
    // Surfaces key problems (invalid key, API not enabled, referrer not allowed).
    window.gm_authFailure = () => {
      setStatus("Google rejected the API key. Check that it's valid, the Places API (New) and Maps JavaScript API are enabled, and this page's address is allowed.", true);
    };
    const script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(key)}` +
      "&loading=async&libraries=places&v=weekly&callback=__dialbridgeMapsReady";
    script.async = true;
    script.onerror = () => reject(new Error("Could not load Google Maps"));
    document.head.appendChild(script);
  });
}

async function init() {
  try {
    await loadGoogleMaps();
    places = await google.maps.importLibrary("places");
    sessionToken = new places.AutocompleteSessionToken();
  } catch (err) {
    if (err.message !== "missing key") setStatus("Couldn't load Google Maps. Check your connection and API key.", true);
  }
}

function openList() {
  resultsBox.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function closeList() {
  resultsBox.hidden = true;
  input.setAttribute("aria-expanded", "false");
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
  if (!places) return;
  const requestId = ++latestRequest;

  try {
    const { suggestions: raw } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: query,
      sessionToken,
      includedRegionCodes: ["us"],
    });
    if (requestId !== latestRequest) return; // a newer keystroke already fired

    suggestions = (raw || [])
      .filter((s) => s.placePrediction)
      .map((s) => ({
        prediction: s.placePrediction,
        mainText: s.placePrediction.mainText?.text || s.placePrediction.text?.text || "",
        secondaryText: s.placePrediction.secondaryText?.text || "",
      }));
    activeIndex = -1;
    renderSuggestions();
    setStatus(suggestions.length ? "" : "No matches yet. Try adding your city.");
  } catch (err) {
    console.error(err);
    setStatus("Search failed. Check the browser console for the Google error.", true);
  }
}

async function selectSuggestion(index) {
  const chosen = suggestions[index];
  if (!chosen) return;

  input.value = chosen.mainText;
  closeList();
  setStatus("Looking up business details...");

  try {
    const place = chosen.prediction.toPlace();
    // These fields bill as Place Details Enterprise (phone, website, rating, review count).
    await place.fetchFields({
      fields: [
        "id",
        "displayName",
        "formattedAddress",
        "nationalPhoneNumber",
        "websiteURI",
        "rating",
        "userRatingCount",
        "googleMapsURI",
        "location",
      ],
    });

    window.selectedBusiness = {
      placeId: place.id,
      name: place.displayName,
      address: place.formattedAddress,
      phone: place.nationalPhoneNumber || null,
      website: place.websiteURI || null,
      rating: place.rating ?? null,
      reviewCount: place.userRatingCount ?? null,
      mapsUrl: place.googleMapsURI || null,
      lat: place.location?.lat() ?? null,
      lng: place.location?.lng() ?? null,
    };

    renderPicked(window.selectedBusiness);
    reportBtn.disabled = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("Couldn't load that business's details. Check the browser console.", true);
  } finally {
    sessionToken = new places.AutocompleteSessionToken(); // next search starts a new session
  }
}

function linkOrDash(url, label) {
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
  document.getElementById("pAddress").textContent = b.address || "Not listed";
  document.getElementById("pPhone").textContent = b.phone || "Not listed";
  document.getElementById("pWebsite").replaceChildren(linkOrDash(b.website));
  document.getElementById("pRating").textContent =
    b.rating != null ? `${b.rating} stars from ${b.reviewCount ?? 0} reviews` : "No reviews yet";
  document.getElementById("pMaps").replaceChildren(linkOrDash(b.mapsUrl, "Open listing"));
  document.getElementById("pId").textContent = b.placeId || "";
  pickedEl.hidden = false;
}

input.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  reportBtn.disabled = true;
  window.selectedBusiness = null;
  const query = input.value.trim();
  if (query.length < MIN_CHARS) {
    suggestions = [];
    closeList();
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
  } else if (e.key === "Escape") {
    closeList();
  }
  if (activeIndex >= 0) input.setAttribute("aria-activedescendant", `opt-${activeIndex}`);
});

input.addEventListener("blur", () => setTimeout(closeList, 120));

document.getElementById("clearBtn").addEventListener("click", () => {
  input.value = "";
  pickedEl.hidden = true;
  reportBtn.disabled = true;
  window.selectedBusiness = null;
  input.focus();
});

document.getElementById("cantFind").addEventListener("click", () => {
  setStatus("Manual entry and phone number search come next in the build.");
});

reportBtn.addEventListener("click", () => {
  console.log("selectedBusiness", window.selectedBusiness);
  setStatus("Business captured. The questions step gets built next.");
});

init();
