// Our own audit, run from the browser in about a second, from public Google APIs:
// profile, reviews, competitors, website, and where they rank on Google Maps.
//
// The ranking grid used to be held back as the reward for an email address. It runs on the
// page now and costs nothing to give away: nine Text Search calls asking for place IDs and
// nothing else, which is the one Places field mask Google does not bill for.
//
// Findings are written by rules, not a model: instant, free, and it can never invent a number.
(() => {
  "use strict";

  const PLACES_URL = "https://places.googleapis.com/v1";
  // Place IDs and nothing else. This field mask is the whole reason the grid is free: ask
  // for a name or a rating here and all nine calls jump to a paid SKU. Names for the table
  // come from the competitor lookup the scan has already run and paid for.
  const GRID_FIELDS = "places.id";
  // 5 x 5 at two miles is what the grid-rank tools settled on for suburban service-area
  // businesses, and 3 x 3 is the minimum they offer rather than a sensible default. The old
  // grid was a 3.7 mile box centred on the business, which is home turf: everybody looked
  // good on it. This one covers roughly 8 miles across, which is a real service area.
  // Twenty-five points still cost nothing, because the grid mask is places.id only.
  const GRID_SIZE = 5; // 5 x 5 points
  const GRID_SPACING_M = 3200; // about 2 miles between points
  const SEARCH_RADIUS_M = 3000;
  const RESULTS_PER_POINT = 20;

  const apiKey = () => window.DIALBRIDGE_CONFIG?.GOOGLE_MAPS_API_KEY || "";
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(v)));

  // ============ RANKING GRID ============

  function gridPoints(center) {
    const half = (GRID_SIZE - 1) / 2;
    const latStep = GRID_SPACING_M / 111320;
    const lngStep = GRID_SPACING_M / (111320 * Math.cos((center.lat * Math.PI) / 180));
    const points = [];
    for (let row = -half; row <= half; row++) {
      for (let col = -half; col <= half; col++) {
        points.push({
          lat: Math.round((center.lat + row * latStep) * 1e6) / 1e6,
          lng: Math.round((center.lng + col * lngStep) * 1e6) / 1e6,
        });
      }
    }
    return points;
  }

  async function searchPoint(query, point) {
    const res = await fetch(`${PLACES_URL}/places:searchText`, {
      method: "POST",
      headers: {
        "X-Goog-Api-Key": apiKey(),
        "Content-Type": "application/json",
        "X-Goog-FieldMask": GRID_FIELDS,
      },
      body: JSON.stringify({
        textQuery: query,
        locationBias: { circle: { center: { latitude: point.lat, longitude: point.lng }, radius: SEARCH_RADIUS_M } },
        includePureServiceAreaBusinesses: true,
        pageSize: RESULTS_PER_POINT,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error?.message || `Google returned ${res.status}`);
    return data.places || [];
  }

  // MEASURED, 2026-09-17: a pure service-area business never appears in Places searchText
  // results for a trade, under any query shape. Location bias, location restriction, a town
  // query, with and without includePureServiceAreaBusinesses: absent from all twenty results
  // every time, across three different businesses. That flag only makes them findable when
  // you search their NAME, which is what the search box does.
  //
  // So the grid cannot rank them, and giving them a centre anyway would produce nine red X
  // pins telling a working contractor they are invisible. That is not a measurement, it is a
  // false claim about somebody's business. They get an explanation instead, and a SERP
  // scraper is the real fix if we ever want to measure them properly.
  //
  // The centroid stays for the narrow case it is honest for: a business that is not flagged
  // service-area but is still missing coordinates, which does happen and which Google will
  // return in a trade search.
  function centroidOf(competitors) {
    const pins = (competitors || [])
      .map((c) => c && c.location)
      .filter((l) => l && num(l.lat) !== null && num(l.lng) !== null);
    if (pins.length < 2) return null;

    const mid = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const i = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
    };
    const lat = mid(pins.map((p) => p.lat));
    const lng = mid(pins.map((p) => p.lng));

    // If the rivals are scattered across half a state the middle of them is not a
    // neighbourhood, and a grid built on it would measure nothing meaningful.
    const spread = Math.max(
      Math.max(...pins.map((p) => Math.abs(p.lat - lat))) * 111,
      Math.max(...pins.map((p) => Math.abs(p.lng - lng))) * 85
    );
    if (spread > 40) return null; // kilometres

    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }

  // Returns the shape the report renders: a rank per point, the pins, and who beats them.
  // `known` is the competitor list from the scan, which is where the names come from and,
  // for a business with no pin of its own, where the centre comes from too.
  async function fetchRanking(profile, query, known = []) {
    const ownPin = profile.location && num(profile.location.lat) !== null ? profile.location : null;
    // No centre is guessed for a business Google will not return in a trade search anyway.
    const center = ownPin || (profile.serviceAreaOnly ? null : centroidOf(known));
    const centerSource = ownPin ? "pin" : "competitors";
    if (!center || !query || !apiKey()) return null;

    const byId = new Map((known || []).filter((c) => c && c.id).map((c) => [c.id, c]));
    const points = gridPoints(center);
    const hits = new Map(); // placeId -> { appearances, bestRank }

    const results = await Promise.all(
      points.map(async (point) => {
        try {
          const places = await searchPoint(query, point);
          places.forEach((place, index) => {
            if (!place.id || place.id === profile.id) return;
            const row = hits.get(place.id) || { appearances: 0, bestRank: 99 };
            row.appearances += 1;
            row.bestRank = Math.min(row.bestRank, index + 1);
            hits.set(place.id, row);
          });
          const index = places.findIndex((place) => place.id === profile.id);
          return { ...point, rank: index >= 0 ? index + 1 : null };
        } catch (err) {
          console.warn("Ranking point failed", err);
          return { ...point, rank: null, failed: true };
        }
      })
    );

    // Nine failed requests is a blocked key, not a business nobody can find. Telling an
    // owner they rank nowhere on the back of that is a claim we could not defend on a call,
    // so when the whole grid fails the report leaves the map out instead.
    if (results.every((r) => r.failed)) return null;

    const ranks = results.map((r) => r.rank);
    const ranked = ranks.filter((r) => r && r > 0);
    // Who turns up instead of them, named from the competitor lookup. A place we cannot put
    // a name to still counts towards their position, it just does not get listed.
    const topCompetitors = [...hits.entries()]
      .filter(([id]) => byId.has(id))
      .sort((a, b) => b[1].appearances - a[1].appearances || a[1].bestRank - b[1].bestRank)
      .slice(0, 5)
      .map(([id, row]) => {
        const c = byId.get(id);
        return {
          name: c.name || "",
          rating: num(c.rating),
          reviewCount: c.reviewCount || 0,
          appearances: row.appearances,
        };
      });

    return {
      keyword: query,
      status: "COMPLETED",
      // Whether the grid is centred on their own pin or on the middle of their competitors.
      // The report has to say which, because "your address is the middle one" is a lie for
      // a business that has no address on the map.
      centerSource,
      gridPoints: ranks.length,
      pointDistanceMiles: Math.round((GRID_SPACING_M / 1609) * 10) / 10,
      averageRank: ranked.length ? Math.round((ranked.reduce((a, b) => a + b, 0) / ranked.length) * 10) / 10 : null,
      pointsInTop3: ranks.filter((r) => r && r <= 3).length,
      pointsNotRanked: ranks.filter((r) => !r).length,
      ranks,
      points: results,
      center: { lat: center.lat, lng: center.lng },
      topCompetitors,
    };
  }

  // ============ THE HEAT MAP ============
  //
  // Google's Static Maps markers take a ONE CHARACTER label, so a rank of 14 cannot be
  // written on one. Every workaround inside Static Maps is a lie: labelling it "X" makes a
  // 14 look identical to a no-show, and dropping the label leaves a coloured pin with no
  // number on it. So we do not use Google's markers at all. We fetch a clean map and draw
  // our own numbered circles over it, positioned by projecting each grid point to a pixel
  // offset from the centre. That is also what a local-SEO heat map actually looks like, it
  // costs the same one Static Maps request, and it still prints.

  const EARTH_M_PER_PX_EQ = 156543.03392; // metres per pixel at zoom 0 on the equator

  const metresPerPixel = (lat, zoom) =>
    (EARTH_M_PER_PX_EQ * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

  // The tightest zoom that still fits the whole grid plus a margin inside the image, so the
  // circles never hang off the edge and the map is never needlessly zoomed out.
  function fitZoom(spanMetres, pixels, lat) {
    for (let zoom = 17; zoom >= 8; zoom--) {
      if (spanMetres / metresPerPixel(lat, zoom) <= pixels) return zoom;
    }
    return 10;
  }

  // Equirectangular around the centre. Over six kilometres the difference from true Web
  // Mercator is well under a pixel, and the alternative is a projection nobody can read.
  function pixelOffset(point, center, zoom) {
    const mpp = metresPerPixel(center.lat, zoom);
    const east = (point.lng - center.lng) * 111320 * Math.cos((center.lat * Math.PI) / 180);
    const north = (point.lat - center.lat) * 110540;
    return { x: east / mpp, y: -north / mpp };
  }

  // Everything the report needs to draw the heat map: a clean map image and, for each grid
  // point, its rank, its tone and where to put it in pixels.
  // Landscape, about 2:1, drawn at the full width of the card. The grid is square in metres
  // and the projection is uniform, so the frame's shape is what decides how spread out the
  // circles look: a wide frame puts margin either side of a square grid. That reads as
  // bunched at a small size and fine at card width, where the gaps are over 120px.
  function rankingMap(ranking, { width = 900, height = 560 } = {}) {
    const points = (ranking?.points || []).filter((p) => num(p.lat) !== null && num(p.lng) !== null);
    const center = ranking?.center;
    if (!points.length || !center || num(center.lat) === null || !apiKey()) return null;

    // The grid is GRID_SIZE points GRID_SPACING_M apart. The extra margin on top of that
    // is deliberate and generous: it buys a zoom level out, which puts the surrounding
    // towns and roads on the map. Framed tight to the grid the map reads as nine circles
    // on a green background, and the point of showing a real map is the recognition.
    const span = (GRID_SIZE - 1) * GRID_SPACING_M + GRID_SPACING_M * 1.0;
    const zoom = fitZoom(span, Math.min(width, height), center.lat);

    const params = [
      `center=${center.lat},${center.lng}`,
      `zoom=${zoom}`,
      `size=${width}x${height}`,
      "scale=2",
      "maptype=roadmap",
      "format=png",
      // Quieter base map: the numbers are the content, the shops and parks are not.
      "style=feature:poi|visibility:off",
      "style=feature:transit|visibility:off",
      `key=${encodeURIComponent(apiKey())}`,
    ];

    return {
      url: `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}`,
      width,
      height,
      zoom,
      keyword: ranking.keyword || "",
      pins: points.map((point) => {
        const rank = num(point.rank);
        const { x, y } = pixelOffset(point, center, zoom);
        return {
          // The middle pin is their own address. Saying so in the caption was not enough:
          // people read the map before they read the sentence under it, so it has to be
          // marked on the map itself.
          isCentre: Math.abs(x) < 3 && Math.abs(y) < 3,
          // A real number whenever there is one, whatever its length, because we are
          // drawing the circle ourselves now. X only ever means "does not come up here".
          label: rank ? String(rank) : "X",
          rank,
          tone: !rank ? "bad" : rank <= 3 ? "good" : "warn",
          x,
          y,
        };
      }),
    };
  }

  // ============ SCORES ============
  //
  // Every sub-score is 0 to 100 and every one of them is a weighted average that
  // RENORMALISES over the inputs we actually have. That matters more than it sounds: three
  // of the inputs the scoring spec asks for are not in the Places API, and scoring a
  // missing input as zero would hand a good business a bad score for a fact we never
  // measured. `weighted` below drops the unknowns and rescales the rest.
  //
  // What we cannot get, and what happens instead:
  //   owner_reply_rate      Places does not return owner replies at all. Its 0.15 of
  //                         Reviews & Reputation redistributes. Needs Apify or the GHL
  //                         audit to fill in.
  //   review_velocity_90d   Places returns at most FIVE reviews, so this saturates at 5.
  //                         A business with 40 reviews in 90 days scores the same as one
  //                         with 5. It is a floor, never an overstatement.
  //   business_age_years    Not in Places either. Estimated from the oldest of those five
  //                         reviews, which is a floor and is flagged as estimated.
  //   post recency          Not in Places, so gbp_completeness covers categories, hours,
  //                         photos and the contact basics only.

  // Weighted average over whatever is known. A part with a null value is not scored zero,
  // it is removed and its weight is given back to the others.
  function weighted(parts) {
    let total = 0;
    let used = 0;
    for (const part of parts) {
      if (part.v === null || part.v === undefined) continue;
      total += part.v * part.w;
      used += part.w;
    }
    return used ? clamp(total / used) : null;
  }

  // The quiz answers are a 0 to 3 severity. This is the curve onto 0 to 100: a good answer
  // is 95 rather than 100, because "we reply within the hour" is a claim, not a measurement.
  const QUIZ_CURVE = [95, 72, 45, 15];
  const quizScore = (leak) => (typeof leak === "number" && QUIZ_CURVE[leak] !== undefined ? QUIZ_CURVE[leak] : null);

  const DAY = 86400000;
  // Roughly one review per seven finished jobs is what a business asking every time lands
  // on. Anything near that reads as a habit; a tenth of it reads as nobody asking.
  const REVIEW_CAPTURE_TARGET = 0.15;
  const REVIEWS_PER_YEAR_BENCHMARK = 18; // healthy for a local service business; roofing and HVAC run higher

  function rankingScore(ranking) {
    if (!ranking || !ranking.gridPoints) return null;
    const { ranks, gridPoints: total } = ranking;
    // Each spot scores on where they land: top 3 is full marks, off the list is zero.
    const perPoint = ranks.map((rank) => {
      if (!rank) return 0;
      if (rank <= 3) return 100;
      if (rank <= 10) return 100 - (rank - 3) * 10;
      return 10;
    });
    return clamp(perPoint.reduce((a, b) => a + b, 0) / total);
  }

  // Saturates at 5, because that is how many reviews Places hands back. Treat it as "at
  // least this many in the last 90 days", never as the true count.
  // Age in days of the newest review Google returned. Places hands back five reviews chosen
  // by relevance, not date, so this is the newest of a sample and can only overstate the
  // gap. It is what the report can honestly say when that sample is all old.
  function newestReviewDays(profile) {
    const dates = (profile?.reviews || []).map((r) => Date.parse(r.publishedAt)).filter(Number.isFinite);
    if (!dates.length) return null;
    return Math.round((Date.now() - Math.max(...dates)) / DAY);
  }

  function reviewVelocity90d(profile) {
    const cutoff = Date.now() - 90 * DAY;
    return (profile?.reviews || []).filter((r) => {
      const at = Date.parse(r.publishedAt);
      return Number.isFinite(at) && at >= cutoff;
    }).length;
  }

  // Google does not tell us how long they have been trading, so the oldest review we can
  // see is the floor. With only five reviews available that floor can be badly short for an
  // old business, which is why everything built on it is flagged estimated and why the
  // stagnant-pace finding refuses to fire under three years.
  function businessAge(profile) {
    const dates = (profile?.reviews || [])
      .map((r) => Date.parse(r.publishedAt))
      .filter(Number.isFinite);
    if (!dates.length) return null;
    const years = (Date.now() - Math.min(...dates)) / (365.25 * DAY);
    if (years < 0.5) return null;
    return { years: Math.round(years * 10) / 10, estimated: true };
  }

  function rivalReviewTop(competitors) {
    const counts = (competitors || []).map((c) => c.reviewCount || 0).filter((n) => n > 0);
    return counts.length ? Math.max(...counts) : null;
  }

  // Everything that decides whether a homeowner picks them once they can see them.
  function reviewsReputation(profile, competitors) {
    const rating = num(profile.rating);
    const count = profile.reviewCount || 0;
    const topRival = rivalReviewTop(competitors);
    const age = businessAge(profile);
    const perYear = age ? count / age.years : null;

    return weighted([
      { w: 0.25, v: rating === null ? null : (rating / 5) * 100 },
      { w: 0.25, v: topRival ? Math.min(100, (count / topRival) * 100) : null },
      { w: 0.20, v: perYear === null ? null : Math.min(100, (perYear / REVIEWS_PER_YEAR_BENCHMARK) * 100) },
      { w: 0.15, v: Math.min(100, reviewVelocity90d(profile) * 20) },
      // owner_reply_rate: no source for it, so this weight redistributes above.
      { w: 0.15, v: null },
    ]);
  }

  function websiteScore(website) {
    if (!website || !website.hasWebsite) return 0;
    // An nginx 404 page loads in a blink and scored 100 here once. The site-check reads
    // the status before Lighthouse's number is allowed to mean anything.
    if (website.broken) return 0;
    if (!website.checked) return null;
    return weighted([
      // The number on the site matching the number on the listing. A tappable number that
      // is not the one Google shows is worse than no number at all.
      { w: 0.4, v: website.callNumberMatchesGoogle === null || website.callNumberMatchesGoogle === undefined
        ? null
        : (website.callNumberMatchesGoogle ? 100 : 0) },
      { w: 0.3, v: num(website.speedScore) },
      // "Above the fold" is not something a speed test can tell us, so this is whether the
      // number is tappable anywhere on the page.
      { w: 0.3, v: website.clickToCall === null || website.clickToCall === undefined
        ? null
        : (website.clickToCall ? 100 : 40) },
    ]);
  }

  // gbp_completeness, passed straight through as the Google Profile score. Post recency is
  // not available from Places, so this is categories, hours, photos and contact basics.
  function gbpCompleteness(profile) {
    let score = 0;
    if (profile.category) score += 20;
    if (profile.hasHours) score += 20;
    score += Math.min(25, (profile.photos?.length || 0) * 2.5);
    if (profile.phone) score += 15;
    if (profile.website) score += 10;
    if (profile.summary) score += 10;
    return clamp(score);
  }

  // Catching the lead is the two behaviour questions, evenly. How they collect reviews is a
  // different problem and belongs to getting chosen, so it is not in here.
  function catchingScore(answers) {
    const speed = quizScore(answers?.leadResponseLeak);
    const follow = quizScore(answers?.quoteFollowUpLeak);
    if (speed === null && follow === null) return null;
    if (speed === null) return follow;
    if (follow === null) return speed;
    return Math.round(0.5 * speed + 0.5 * follow);
  }

  // A rating on its own says nothing. Five stars from thirteen reviews is thirteen happy
  // customers, not a reputation, and a report that puts a green tick next to it loses the
  // one reader who knows the business better than we do. Kept alongside the scores because
  // the journey strip and the tiles both need one shared verdict to agree on.
  const REVIEW_FLOOR = 25;
  const REVIEW_CEILING = 80;
  const GOOD_RATING = 4.2;

  function rivalReviewMedian(competitors) {
    const counts = (competitors || [])
      .map((c) => c.reviewCount || 0)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    if (!counts.length) return null;
    // Lower of the two middles on an even list. Math.floor(length / 2) takes the upper one,
    // which on a two-rival list is just the biggest of them.
    return counts[Math.ceil(counts.length / 2) - 1];
  }

  function reviewStanding(rating, count, competitors) {
    const median = rivalReviewMedian(competitors);
    const bar = median
      ? Math.min(REVIEW_CEILING, Math.max(REVIEW_FLOOR, Math.round(median * 0.6)))
      : REVIEW_FLOOR;
    const have = count || 0;
    const enough = have >= bar;
    const rated = num(rating) !== null && rating >= GOOD_RATING;
    return { ok: enough && rated, enough, rated, count: have, bar, median, floor: REVIEW_FLOOR };
  }

  // ============ THE MONEY ============
  //
  // Midpoint of the band they chose, not the bottom. The bottom was too timid: somebody who
  // said "$5,000 to $15,000" does not recognise their business in $5,000.
  const JOB_VALUE_MID = {
    under_1000: 750,
    "1000_5000": 3000,
    "5000_15000": 10000,
    over_15000: 20000,
  };

  // A conservative month for the size of job they do, used when their reviews cannot tell us
  // a pace. Roughly $10k to $40k a month of work, which is a small contractor.
  const TYPICAL_JOBS = {
    under_1000: 20,
    "1000_5000": 10,
    "5000_15000": 4,
    over_15000: 2,
  };


  // The share of enquiries that walks, per answer. Deliberately modest and hard-capped:
  // these are the numbers behind a figure we put in front of an owner who knows their own
  // book, so they are chosen to be defensible at the low end rather than impressive.
  const LEAK_RATES = {
    leadResponse: { same_day: 0.03, when_slammed: 0.08, fall_through: 0.14 },
    quoteFollowUp: { once_or_twice: 0.02, when_remember: 0.05, nothing: 0.08 },
  };
  const MAX_LEAK_RATE = 0.2;

  // How many of the people who ask for a price actually become a job. This exists because
  // the old sum multiplied jobs they WON by the share of leads they LOSE, which is a
  // category error: the lost ones sit on top of the won ones, not inside them. A plumber
  // doing 6 jobs a month was told he loses half a job, while ranking nowhere on 25 of 25
  // searches.
  //
  // 4 in 10 is the working figure, and the page prints it rather than hiding it here, so a
  // contractor who closes 2 in 10 or 8 in 10 can see immediately which way the number moves.
  const CLOSE_RATE = 0.4;

  // Two independent readings of how many jobs a month they run, and we take the lower.
  //   1. the span of the reviews we can see, at roughly one review per ten jobs
  //   2. the last 90 days of reviews, at roughly one review per eight jobs
  // Both are estimates off five reviews, so the conservative one is the one that goes on
  // the page. Returns null when neither is usable.
  function jobsPerMonth(profile) {
    const estimates = [];

    const dates = (profile?.reviews || [])
      .map((r) => Date.parse(r.publishedAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    if ((profile?.reviewCount || 0) >= 10 && dates.length >= 3) {
      const spanDays = (dates[0] - dates[dates.length - 1]) / DAY;
      if (spanDays >= 30) {
        const perMonth = ((dates.length - 1) / spanDays) * 30;
        const jobs = Math.round(perMonth * 10);
        if (Number.isFinite(jobs) && jobs >= 1) estimates.push(jobs);
      }
    }

    const velocity = reviewVelocity90d(profile);
    if (velocity >= 3) {
      const jobs = Math.round((velocity / 3) * 8);
      if (jobs >= 1) estimates.push(jobs);
    }

    if (!estimates.length) return null;
    return Math.min(400, Math.min(...estimates));
  }

  function leakMath(answers, profile) {
    const band = answers?.jobValue;
    // The midpoint if we recognise the band, otherwise whatever the question handed us.
    const jobValue = JOB_VALUE_MID[band] || Number(answers?.jobValueLow) || 0;
    if (!jobValue) return null;

    // The leak rate comes from the two behaviour answers and nothing else. The scoring spec
    // had it as (100 - worst sub-score) / 100, which reads a weak review count as a share of
    // lost leads: a business scoring 45 came out losing 55% of its work, which on their own
    // numbers is a dozen jobs a month and is not a claim we could defend on a phone call.
    const rate = Math.min(
      MAX_LEAK_RATE,
      (LEAK_RATES.leadResponse[answers?.leadResponse] || 0) + (LEAK_RATES.quoteFollowUp[answers?.quoteFollowUp] || 0)
    );
    if (!rate) return null;

    // Always a monthly figure. Their own review pace when it is readable, otherwise the
    // typical month for their job size, and the page labels which of the two it used so the
    // assumption is on the screen rather than buried in here.
    // What they told us, then what their review pace suggests, then the typical month for
    // their job size. Their own answer wins because it is the only one that is not a guess:
    // the review-pace estimate reads five reviews and routinely lands an order of magnitude
    // low for anyone who does not ask for reviews, which is most of them.
    const told = Number(answers?.jobsPerMonthLow) || null;
    const measured = told ? null : jobsPerMonth(profile);
    const jobs = told || measured || TYPICAL_JOBS[band] || null;
    if (!jobs) return { jobValue, rate, jobs: null, perMonth: null, basis: "none" };

    // Jobs won, back out to the calls it took to win them, then the share that slips.
    const calls = Math.round(jobs / CLOSE_RATE);
    const lostJobs = calls * rate;
    const perMonth = Math.round((lostJobs * jobValue) / 100) * 100;
    return {
      jobValue,
      rate,
      jobs,
      calls,
      closeRate: CLOSE_RATE,
      perMonth,
      basis: told ? "answered" : measured ? "reviews" : "typical",
      lostJobs: Math.round(lostJobs * 10) / 10,
    };
  }

  // The prize, and deliberately a target rather than a prediction. One more job a week is
  // a contractor's own unit, it scales sanely from a six-job operation to a sixty-job one,
  // and every figure in it is either theirs or arithmetic they can check on the page. The
  // old number was the opposite: a dollar loss built entirely out of rates we invented,
  // which is exactly what it read like.
  function growthMath(leak) {
    if (!leak || !leak.jobValue) return null;
    const extraJobs = 4; // one a week
    return {
      extraJobs,
      jobValue: leak.jobValue,
      perMonth: extraJobs * leak.jobValue,
      nowJobs: leak.jobs || null,
      nowPerMonth: leak.jobs ? leak.jobs * leak.jobValue : null,
    };
  }

  const dollars = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const reviewWord = (n) => `${n} review${Number(n) === 1 ? "" : "s"}`;
  const yearWord = (n) => `${n} year${Number(n) === 1 ? "" : "s"}`;


  // ============ LEAD SCORE (for Meta, not for the lead) ============
  //
  // Everything above scores the CONTRACTOR'S business. This scores the lead: is this person
  // worth what an ad click cost us. It never appears on the page.
  //
  // Three things make a good lead, and the first one is the counter-intuitive one:
  //
  //   capacity  Can they afford us and do they have volume to lose? A high review count is
  //             a GOOD signal here, not a bad one. It means real job volume, years of
  //             trading and money coming in. The business with two reviews and no website
  //             has the worst report on the page and no budget to fix any of it.
  //   pain      How much of their problem can we visibly fix? This is where the low report
  //             scores help: a strong business with nothing wrong has no reason to call.
  //   value     The monthly money we can point at. Log-scaled, because the difference
  //             between $500 and $3,000 a month matters and $30,000 to $60,000 does not.
  //
  // Commitment is NOT in the score. It is a gate: nothing gets sent to Meta unless the
  // phone was verified, so everything that reaches this function is already committed.

  const scale = (v, lo, hi) => (v === null || v === undefined ? null : clamp(((v - lo) / (hi - lo)) * 100));

  const JOB_VALUE_CAPACITY = { 750: 25, 3000: 60, 10000: 88, 20000: 100 };

  function leadScore(report) {
    const reviews = report?.reviews || {};
    const leak = report?.leak;
    const count = reviews.googleReviewCount || 0;

    // 0 at no reviews, 100 at 120. Past that it stops telling us anything new about size.
    // Monthly revenue is the honest size signal now that we ask for job volume, and it
    // fixes a real defect: review count used to drive half of capacity while also driving
    // most of foundScore, which feeds pain. The two largest terms of the lead score were
    // cancelling each other out, and every lead landed in the forties.
    //
    // $5,000 a month is a one-truck operation, $120,000 is a business with staff. Log,
    // because the gap between 5k and 20k matters far more than 100k to 120k.
    const monthly = leak?.jobs && leak?.jobValue ? leak.jobs * leak.jobValue : null;
    const sizeByRevenue =
      monthly === null
        ? null
        : clamp(((Math.log10(Math.max(5000, monthly)) - Math.log10(5000)) / (Math.log10(120000) - Math.log10(5000))) * 100);

    const capacity = weighted([
      { w: 0.55, v: sizeByRevenue },
      { w: 0.25, v: JOB_VALUE_CAPACITY[leak?.jobValue] ?? null },
      { w: 0.20, v: report?.website?.found ? 100 : 40 },
    ]);

    const pain = weighted([
      { w: 0.5, v: num(report?.foundScore) === null ? null : 100 - report.foundScore },
      { w: 0.5, v: num(report?.responseScore) === null ? null : 100 - report.responseScore },
    ]);

    // $500 a month is nothing to act on, $15,000 is plenty. Log so the middle has room.
    //
    // A missing value does NOT renormalise away here, and that distinction matters. If they
    // finished the quiz and we still cannot point at a monthly loss, that is a real answer:
    // there is no money on the table for this funnel to talk about. Renormalising it let a
    // 250-review shop with a perfect process score warmer than a mid-sized one bleeding
    // $1,600 a month, purely on the size of its review count.
    const finishedQuiz = Boolean(report?.answers?.jobValue);
    const value = leak?.perMonth
      ? clamp(((Math.log10(Math.max(500, leak.perMonth)) - Math.log10(500)) / (Math.log10(15000) - Math.log10(500))) * 100)
      : (finishedQuiz ? 0 : null);

    const score = weighted([
      { w: 0.45, v: capacity },
      { w: 0.35, v: pain },
      { w: 0.20, v: value },
    ]);
    if (score === null) return null;

    return {
      score,
      band: score >= 70 ? "hot" : score >= 50 ? "warm" : "cool",
      capacity,
      pain,
      value,
      // The facts behind it, so a decision made on this score can be argued with later.
      reasons: {
        track: report?.track || null,
        monthlyRevenue: monthly,
        reviewCount: count,
        jobValue: leak?.jobValue ?? null,
        monthlyLoss: leak?.perMonth ?? null,
        monthlyLossBasis: leak?.basis ?? null,
        hasWebsite: Boolean(report?.website?.found),
        foundScore: num(report?.foundScore),
        catchingScore: num(report?.responseScore),
      },
    };
  }

  // ============ FINDINGS ============
  //
  // Every finding is a candidate with its own sub-metric score, and the severity is simply
  // 100 minus that score. Sorting by severity means the list is genuinely worst-first
  // instead of ordered by however the if-statements happened to fall, and it means the red
  // and gold counts in the intro line are real counts rather than a number we typed in.
  //
  //   severity >= 70  red, critical
  //   severity 40-69  gold, slowing them down
  //   severity < 40   left off the list entirely
  //
  // dollarWeight only breaks ties: it is how directly that gap costs a job today. Losing an
  // enquiry you already earned is a 10; an incomplete profile is a 3.

  const RED_AT = 70;
  const GOLD_AT = 40;

  // Copy rules that apply to every string below: no "call"-specific language, because half
  // of these people are losing jobs to an unanswered web form. Lead, enquiry or job.
  const LEAD_RESPONSE_COPY = {
    within_hour: null,
    same_day: {
      title: "A same-day reply loses the urgent jobs",
      said: "You told us you usually get back to people the same day.",
      why: "That is fine for a kitchen somebody is planning. It is too slow for a leak, a breakdown or a blocked drain, and those jobs go to whoever answers first.",
    },
    when_slammed: {
      title: "The busier you get, the more work you lose",
      said: "You told us it depends how slammed you are.",
      why: "So enquiries slip on exactly the weeks you are earning most, and you never see the ones that went elsewhere. It is the leak that hides itself.",
    },
    fall_through: {
      title: "Some enquiries never get answered at all",
      said: "You told us some never hear back.",
      why: "Every one of those was somebody who chose you first and got nothing back.",
    },
  };

  const FOLLOW_UP_COPY = {
    automatic: null,
    once_or_twice: {
      title: "Quotes go quiet and stay quiet",
      said: "You told us you follow up once or twice yourself.",
      why: "Most quotes that close need more contact than that, and the ones you drop are the ones a competitor is still chasing.",
    },
    when_remember: {
      title: "Quotes go quiet and stay quiet",
      said: "You told us you follow up if you remember.",
      why: "Which means the busiest weeks, when you have quoted the most, are the weeks nothing gets chased.",
    },
    nothing: {
      title: "Quotes go quiet and stay quiet",
      said: "You told us nothing happens after a quote goes out.",
      why: "Most quotes are won by whoever follows up, not whoever quoted first or cheapest.",
    },
  };


  function findingsFor(data, answers, trade = "") {
    const { profile, ranking, website } = data;
    const reviews = data.reviews || {};
    const sub = data.subScores || {};
    const signals = data.signals || {};
    const count = reviews.googleReviewCount || 0;
    const rating = num(reviews.googleRating);
    const leak = data.leak;
    const perJob = leak ? ` At ${dollars(leak.jobValue)} a job, that is what each one is worth.` : "";
    const candidates = [];

    // score is the factor's own sub-metric, 0 to 100. severity is 100 minus it.
    const add = (key, score, dollarWeight, body) => {
      if (score === null || score === undefined) return;
      candidates.push({ key, score, dollarWeight, ...body });
    };

    // ---- the two behaviour answers. Most direct, so the highest dollar weight.
    const speedCopy = LEAD_RESPONSE_COPY[answers?.leadResponse];
    if (speedCopy) {
      add("speed_to_lead", quizScore(answers.leadResponseLeak), 10, {
        area: "lead_follow_up",
        title: speedCopy.title,
        detail: `${speedCopy.said} ${speedCopy.why}${perJob}`,
        fix: "Every enquiry gets a reply in seconds, day or night, and the conversation keeps going until it is booked.",
      });
    }

    const followCopy = FOLLOW_UP_COPY[answers?.quoteFollowUp];
    if (followCopy) {
      add("quote_followup", quizScore(answers.quoteFollowUpLeak), 10, {
        area: "lead_follow_up",
        title: followCopy.title,
        detail: `${followCopy.said} ${followCopy.why}${perJob}`,
        fix: "Every quote gets followed up by text and email until they answer one way or the other.",
      });
    }

    // ---- reviews against jobs. This only became possible once we started asking how many
    //      jobs they do, and it is the sharpest line in the report for a business that is
    //      already doing well: they cannot argue with it, because both numbers are theirs.
    const jobsYear = Number(answers?.jobsPerMonthLow) ? Number(answers.jobsPerMonthLow) * 12 : null;
    const perYearNow = signals.reviewsPerYear;
    if (jobsYear && perYearNow !== null && perYearNow >= 0) {
      const rate = perYearNow / jobsYear;
      const oneIn = perYearNow > 0 ? Math.round(jobsYear / perYearNow) : null;
      add("review_capture", Math.min(100, (rate / REVIEW_CAPTURE_TARGET) * 100), 7, {
        area: "reviews",
        title: oneIn
          ? `About one review for every ${oneIn} jobs`
          : "Hundreds of finished jobs, no reviews to show for them",
        detail: oneIn
          ? `You told us roughly ${answers.jobsPerMonthLow} jobs a month, so about ${jobsYear} a year, and your profile is collecting around ${reviewWord(Math.round(perYearNow))} a year. Every one of those jobs was a review you had already earned.`
          : `You told us roughly ${answers.jobsPerMonthLow} jobs a month. None of them turned into a review in the last year.`,
        fix: "Every finished job asks automatically, a couple of hours later, in your name.",
      });
    }

    // ---- three states here, not two. A listing with no website link is the common one and
    //      it usually does NOT mean the business has no website.
    if (website && website.found === false) {
      add("no_website", 0, 9, {
        area: "foundation",
        title: "There's no website on your listing, and we couldn't find one",
        detail: "Your Google listing has nowhere to send anyone, and a search for your business did not turn up a site either. Homeowners who cannot find a website almost always move to the next company on the list, and Google leans on a real site to decide who to show at all.",
        fix: "We build and host the site, and it is yours to keep.",
      });
    } else if (website && website.found && website.broken) {
      // The listing links to a site and the site is dead. Worse than no site: Google is
      // actively sending people to an error page. Nothing else about the site can be
      // scored, so nothing else about it is said.
      add("website_broken", 0, 9, {
        area: "foundation",
        title: website.reachable === false
          ? "The website on your Google listing does not load"
          : `The website on your Google listing returns an error (${website.httpStatus || "error"})`,
        detail: website.reachable === false
          ? "The connection fails before a page appears, usually an expired security certificate or a site that has been taken down. Everybody who taps through from Google sees a browser error and goes to the next company."
          : "Google is sending people to an address that answers with an error page instead of your business. That is the same as having no website, except you are paying for the traffic to hit a wall.",
        fix: "We get a working site back up on that address, fast on a phone, with a tap-to-call button on every screen.",
      });
    } else if (website && website.found) {
      // The site exists but the listing does not link it. Cheap to fix, and it costs them
      // twice while it is broken: the listing looks unfinished and the clicks go nowhere.
      if (website.notOnListing) {
        add("website_not_linked", 15, 8, {
          area: "google_profile",
          title: "Your website isn't on your Google listing",
          detail: `We found your site at ${String(website.url || "").replace(/^https?:\/\//, "")}, but your Google listing has no link to it. Everybody who finds you on the map has nowhere to go, and Google counts a linked site when it decides who to show. This is the cheapest thing on this list to fix.`,
          fix: "We add it to the listing, along with the services and areas that belong there.",
        });
      }
      // ---- the number on the site not matching the number on the listing
      if (website.callNumberMatchesGoogle === false) {
        add("nap_mismatch", 0, 8, {
          area: "website",
          title: "Your website and Google list different numbers",
          detail: "Two numbers for one business splits your enquiries and tells Google it cannot trust either listing. It is one of the cheapest things on this list to fix and one of the most damaging to leave.",
          fix: "We make the number on the site, the listing and every directory the same one.",
        });
      }
      if (website.clickToCall === false) {
        add("no_tap_to_call", 40, 8, {
          area: "website",
          title: "Your number is not tappable on a phone",
          detail: "Somebody standing in their driveway has to memorise your number and dial it by hand. Most of them give up and go to the next company instead.",
          fix: "We put a tap-to-call button and a quote form on every screen of the site.",
        });
      }
      if (num(website.mobileScore) !== null) {
        add("website_speed", website.mobileScore, 6, {
          area: "website",
          title: `Your website scores ${website.mobileScore} out of 100 on a phone`,
          detail: `It takes ${website.mobileLoadTime || "several seconds"} for the main content to appear. Most people leave before that, and they leave without telling you.`,
          fix: "We rebuild it to load fast on a phone, where nearly all your traffic comes from.",
        });
      }
      const usability = [];
      if (website.tinyTapTargets) usability.push("buttons and links too small to tap");
      if (website.tinyText) usability.push("text too small to read");
      if (website.poorContrast) usability.push("text that blends into the background");
      if (usability.length) {
        add("website_usability", 45, 5, {
          area: "website",
          title: "Your website is hard to use on a phone",
          detail: `We found ${usability.join(", ")}. A site can load fast and still be a struggle for somebody trying to reach you one-handed.`,
          fix: "We rebuild the site so it reads and taps cleanly on a phone.",
        });
      }
      if (num(website.yearsStale) !== null && website.yearsStale >= 2) {
        add("website_stale", 45, 4, {
          area: "website",
          title: `Your website still says ${website.copyrightYear}`,
          detail: `The footer has not been touched in ${yearWord(website.yearsStale)}. Homeowners read that as a business that might not be around any more, and so does Google.`,
          fix: "We keep the site current, with this year's work on it.",
        });
      }
    }

    // ---- where they sit on the map
    if (ranking && ranking.gridPoints && sub.mapRanking !== null && sub.mapRanking !== undefined) {
      const total = ranking.gridPoints;
      const missing = total - ranking.pointsInTop3;
      const absent = ranking.pointsNotRanked || 0;
      const below = missing - absent;
      const rest = !below
        ? `At the other ${absent}, you do not come up at all.`
        : !absent
          ? `At the other ${below}, you sit below it, where almost nobody scrolls.`
          : `At ${below} you sit below it, and at ${absent} you do not come up at all.`;
      add("map_ranking", sub.mapRanking, 8, {
        area: "map_ranking",
        title: ranking.pointsInTop3
          ? `You're missing from the top 3 in ${missing} of ${total} spots`
          : "You're not in the top 3 anywhere nearby",
        detail: ranking.pointsInTop3
          ? `You make the top 3 at ${ranking.pointsInTop3} of the ${total} spots we searched. ${rest} Those are jobs going to whoever does show up.`
          : `We searched from ${total} spots around you and you never made the top 3. Homeowners see other companies first, every time.`,
        fix: "We work your profile and reviews so the weak spots on that map turn green.",
      });
    }

    // ---- reviews: the gap to the strongest rival
    const topRival = signals.topRivalReviews;
    if (topRival && count < topRival) {
      const leader = (data.competitors || []).find((c) => (c.reviewCount || 0) === topRival);
      add("review_count_gap", Math.min(100, (count / topRival) * 100), 7, {
        area: "reviews",
        title: leader ? `${leader.name} has ${topRival - count} more reviews than you` : `The strongest company near you has ${topRival} reviews`,
        detail: `They sit on ${reviewWord(topRival)} to your ${count}. A homeowner sees both numbers on one screen and reads the bigger one as the safer bet.`,
        fix: "We ask every customer for a review automatically, by text, right after the job.",
      });
    }

    // ---- reviews: the rating itself
    if (rating !== null) {
      add("low_rating", (rating / 5) * 100, 6, {
        area: "reviews",
        title: `Your rating is sitting at ${rating}`,
        detail: "Homeowners filter by rating before they read a word of it. Anything under 4.5 gets skipped by people who never find out why.",
        fix: "We chase the happy customers for reviews and answer the unhappy ones in public, in your voice.",
      });
    }

    // ---- reviews: how fast new ones arrive.
    //
    // MEASURED, 2026-09-23: Places returns five reviews chosen by RELEVANCE, not date. A
    // 12-review plumber came back with reviews 122, 308, 2056, 364 and 1624 days old, in
    // that order, and a 1,073-review sewer company's newest of five was 65 days old, which
    // no shop earning reviews weekly could be. So "no new reviews in 90 days" is only a
    // fact when the business has five or fewer and we have seen all of them. Above that,
    // a zero says nothing about the rate and a two says nothing either. What the sample
    // does tell us, honestly, is the age of the reviews Google puts at the top of the
    // listing, which is what a homeowner reads, so that is what gets said instead.
    const seenCount = num(data.reviews?.googleReviewCount) ?? 0;
    const velocity = signals.reviewVelocity90d || 0;
    if (seenCount <= 5) {
      add("review_velocity_low", Math.min(100, velocity * 20), 6, {
        area: "reviews",
        title: velocity ? `Only ${reviewWord(velocity)} in the last 90 days` : "No new reviews in the last 90 days",
        detail: "Google weighs recent reviews far more heavily than old ones. A profile that stopped collecting them slides down the map even when the total looks healthy.",
        fix: "Every finished job asks for a review, so the count keeps moving instead of stalling.",
      });
    } else if (velocity === 0 && signals.newestReviewDays !== null && signals.newestReviewDays > 90) {
      const months = Math.max(1, Math.round(signals.newestReviewDays / 30));
      add("review_velocity_low", Math.max(0, 100 - months * 15), 6, {
        area: "reviews",
        title: `The reviews Google shows first are all ${months >= 2 ? `${months} months` : "months"} old`,
        detail: "Google puts five reviews at the top of your listing, and none of them is recent. That is what a homeowner reads before deciding, and Google weighs recent reviews far more heavily than old ones.",
        fix: "Every finished job asks for a review, so fresh ones keep landing at the top of the listing.",
      });
    }

    // ---- reviews: the tenure comparison. This is the one that lands, so it only fires
    //      when the business is old enough for the pace to mean anything.
    const age = signals.businessAge;
    const perYear = signals.reviewsPerYear;
    if (age && age.years >= 3 && perYear !== null) {
      const paceScore = Math.min(100, (perYear / REVIEWS_PER_YEAR_BENCHMARK) * 100);
      add("review_pace_stagnant", paceScore, 6, {
        area: "reviews",
        title: `${reviewWord(count)} in ${yearWord(age.years)} of trading`,
        detail: `${reviewWord(count)} is a good start, but you have been in business at least ${yearWord(age.years)}. That is about ${perYear} reviews a year, and most established ${trade || "contractors"} are closer to ${REVIEWS_PER_YEAR_BENCHMARK}.`,
        fix: "We ask every customer automatically, so the count builds at the pace your job volume deserves.",
      });
    }

    // ---- the listing itself
    const listingGaps = [
      profile.photoCount < 5 ? (profile.photoCount ? `only ${profile.photoCount} photos` : "no photos") : "",
      profile.hasHours ? "" : "no opening hours",
      profile.phone ? "" : "no phone number",
      data.website?.found ? "" : "no website link",
    ].filter(Boolean);
    const listSentence = listingGaps.length
      ? `We found ${listingGaps.length === 1 ? listingGaps[0] : listingGaps.slice(0, -1).join(", ") + " and " + listingGaps[listingGaps.length - 1]} on it. `
      : "There is still room on it that you are not using. ";
    add("gbp_incomplete", sub.googleProfile, 3, {
      area: "google_profile",
      title: "Your Google listing is not finished",
      detail: `${listSentence}The listing is the single biggest lever on where you appear on the map, and most of them get filled in once and never touched again.`,
      fix: "We finish the profile and keep it active: categories, services, hours, photos and posts.",
    });

    if (!profile.phone) {
      add("no_phone", 0, 9, {
        area: "google_profile",
        title: "There is no phone number on your Google listing",
        detail: "Somebody who wants to hire you today cannot. This is the shortest path between a homeowner and a booked job, and it is closed.",
        fix: "We put a tracked number on the listing so you can see exactly what it brings in.",
      });
    }

    // owner_reply_low is in the spec and deliberately absent here: the Places API does not
    // return owner replies, so we would be scoring a fact we never measured.

    const scored = candidates
      .map((c) => ({ ...c, severity: Math.round(100 - c.score), tone: null }))
      .filter((c) => c.severity >= GOLD_AT)
      .sort((a, b) => b.severity - a.severity || b.dollarWeight - a.dollarWeight);

    // Two from any one area is plenty. Three findings that all say "your website is slow"
    // read as one finding padded out to look like work.
    const perArea = {};
    const varied = [];
    for (const finding of scored) {
      const area = finding.area || "other";
      perArea[area] = (perArea[area] || 0) + 1;
      if (perArea[area] > 2) continue;
      finding.tone = finding.severity >= RED_AT ? "red" : "gold";
      finding.severity_label = finding.tone === "red" ? "critical" : "moderate";
      varied.push(finding);
    }

    // The top four go in the list. The counts in the intro line are taken from the whole
    // qualifying set, not the four, so "and 3 more slowing you down" is honest.
    const top = varied.slice(0, 4);
    return {
      findings: top,
      // The report lists the worst four. The plan has to cover every area that actually
      // qualified, or a business whose top four happen to be three listing problems and a
      // review problem gets a plan with nothing in it about the enquiries they are losing.
      allFindings: varied,
      redCount: varied.filter((f) => f.tone === "red").length,
      goldCount: varied.filter((f) => f.tone === "gold").length,
    };
  }

  function strengthsFor(data) {
    const { profile, ranking, website } = data;
    const out = [];
    const reviews = data.reviews || {};
    // Stars and a count that actually stands up. A 5.0 from a dozen reviews is not a
    // competitive advantage and saying so would cost us the reader.
    if (reviews.standing?.ok && reviews.googleRating >= 4.5) {
      out.push(`A ${reviews.googleRating} star rating from ${reviewWord(reviews.googleReviewCount)}, which holds up against the companies near you.`);
    }
    if (ranking && ranking.pointsInTop3 >= ranking.gridPoints / 2) {
      out.push(`You already show in the top 3 at ${ranking.pointsInTop3} of ${ranking.gridPoints} spots on the map.`);
    }
    if (num(website.mobileScore) !== null && website.mobileScore >= 80) {
      out.push(`Your website scores ${website.mobileScore} out of 100 for speed on a phone.`);
    }
    if (profile.photoCount >= 10) out.push("Your profile has a full set of photos.");
    if (profile.hasHours && profile.phone && website.found) out.push("Your hours, phone number and website are all on your Google listing.");
    return out.slice(0, 3);
  }

  function headlineFor(findings, profile, scores = {}) {
    const first = findings[0];
    if (!first) return `${profile.name} is in good shape online`;
    // A business already sitting in the top three across eight miles does not have a
    // visibility problem, and opening on one is how you lose somebody who spent years
    // earning that position. Lead on what they built; the gap comes straight after.
    if (scores.track === "capacity") return "You've won the hard part. Now you're the bottleneck.";
    if (scores.track === "none") return "There is not much wrong here, and that is worth knowing";
    const byArea = {
      foundation: "You're missing the pieces that bring the jobs in",
      map_ranking: "Homeowners nearby are seeing your competitors first",
      reviews: "Your competitors' review counts are winning the click",
      website: "Your website is costing you the jobs you already earned",
      google_profile: "Your Google listing is turning people away",
      lead_follow_up: "The leads you already get are slipping through",
    };
    return byArea[first.area] || first.title;
  }


  // ============ BUILD ============

  // Strong at being found and weaker at catching means the work is arriving and leaking on
  // the way in: the capacity story. Weak at being found means the work never arrives at all:
  // the presence story. Strong at both is a business neither offer suits, and saying so is
  // worth more than pretending otherwise.
  const FOUND_STRONG = 70;
  const CATCHING_STRONG = 75;

  function trackFor(foundScore, responseScore) {
    if (num(foundScore) === null) return "presence";
    if (foundScore < FOUND_STRONG) return "presence";
    if (num(responseScore) !== null && responseScore >= CATCHING_STRONG) return "none";
    return "capacity";
  }

  function buildReport({ profile, competitors = [], website, answers = {}, ranking = null, trade = "", submissionId = null }) {
    const scores = {
      "Google Maps ranking": rankingScore(ranking),
      "Reviews and reputation": reviewsReputation(profile, competitors),
      "Website": websiteScore(website),
      "Google profile": gbpCompleteness(profile),
      "Catching the lead": catchingScore(answers),
    };

    const grades = [];
    for (const [name, score] of Object.entries(scores)) {
      if (score === null) continue;
      grades.push({ name, score, level: score >= 80 ? "success" : score >= 50 ? "warning" : "error" });
    }

    // Two separate numbers on purpose. A business can be excellent at getting found and
    // still lose the job, and one blended score hides exactly the gap we are selling.
    //
    // Getting found leaves the website out deliberately: the site is how they get chosen,
    // not how they get discovered. It DOES include the map, which the scoring spec listed
    // as an input and then never used in any sub-score. That reads as an oversight rather
    // than a decision, because where they sit on the map is the most direct measurement of
    // being found that we have. Drop the third line to go back to the spec exactly.
    const foundScore = weighted([
      { w: 0.40, v: scores["Reviews and reputation"] },
      { w: 0.30, v: scores["Google profile"] },
      { w: 0.30, v: scores["Google Maps ranking"] },
    ]);
    const responseScore = scores["Catching the lead"];
    const overallScore = foundScore;

    // Which of the two problems this business actually has. A contractor already sitting in
    // the top three across eight miles does not have a visibility problem, and telling them
    // they do is how you lose somebody who has spent years earning that position. What they
    // have is a capacity problem: every enquiry still runs through the owner.
    //
    // Rules, not a model, because this decides which report somebody sees. It has to be the
    // same every run and arguable afterwards.
    const track = trackFor(foundScore, responseScore);

    const data = {
      submissionId,
      source: "dialbridge",
      generatedAt: new Date().toISOString(),
      overallScore,
      foundScore,
      responseScore,
      track,
      leak: leakMath(answers, profile),
      growth: growthMath(leakMath(answers, profile)),
      grades,
      subScores: {
        reviewsReputation: scores["Reviews and reputation"],
        website: scores["Website"],
        googleProfile: scores["Google profile"],
        mapRanking: scores["Google Maps ranking"],
        catchingLead: scores["Catching the lead"],
      },
      // What the scores were built from, so nothing downstream has to recompute it and the
      // copy can quote the same numbers the maths used.
      signals: {
        reviewVelocity90d: reviewVelocity90d(profile),
        newestReviewDays: newestReviewDays(profile),
        velocitySaturated: reviewVelocity90d(profile) >= 5, // Places only returns five reviews
        businessAge: businessAge(profile),
        reviewsPerYear: (() => {
          const age = businessAge(profile);
          if (!age) return null;
          return Math.round(((profile.reviewCount || 0) / age.years) * 10) / 10;
        })(),
        reviewsPerYearBenchmark: REVIEWS_PER_YEAR_BENCHMARK,
        topRivalReviews: rivalReviewTop(competitors),
        ownerReplyRate: null, // not available from the Places API
      },
      profile: {
        name: profile.name,
        category: profile.category || "",
        address: profile.address || "",
        phone: profile.phone || "",
        photoCount: profile.photos?.length || 0,
        // The first photo reference, so the report can rebuild their own listing panel
        // rather than showing somebody else's as an example.
        photo: (profile.photos || [])[0] || "",
        hasHours: Boolean(profile.hasHours),
        // Set when Google has no pin for them at all. The map section reads it to explain
        // itself instead of silently disappearing.
        serviceAreaOnly: Boolean(profile.serviceAreaOnly),
        claimed: null,
      },
      competitors,
      ranking,
      reviews: {
        status: "COMPLETED",
        googleRating: num(profile.rating),
        googleReviewCount: profile.reviewCount || 0,
        standing: reviewStanding(profile.rating, profile.reviewCount, competitors),
        recent: (profile.reviews || []).slice(0, 3),
      },
      website: {
        url: website.url || "",
        found: Boolean(website.hasWebsite),
        mobileScore: num(website.speedScore),
        mobileLoadTime: website.loadTime || "",
        desktopScore: num(website.desktopScore),
        desktopLoadTime: website.desktopLoadTime || "",
        // True when we had to go and find the site because the listing did not carry it.
        // A different, better finding than "you have no website".
        notOnListing: Boolean(website.notOnListing),
        foundConfidence: website.foundConfidence || null,
        seoScore: num(website.seoScore),
        https: website.https ?? null,
        mobileFriendly: website.mobileFriendly ?? null,
        screenshot: website.screenshot || "",
        // The site-check's verdict on whether the address works at all. A speed score
        // for a dead site is meaningless and everything downstream reads these first.
        httpStatus: num(website.httpStatus),
        reachable: website.reachable ?? null,
        broken: website.broken === true,
        // The filmstrip Lighthouse already took, plus the two paint times as real numbers.
        // The report plays the strip back at those timings rather than printing a score.
        filmstrip: Array.isArray(website.filmstrip) ? website.filmstrip : [],
        firstPaintMs: num(website.firstPaintMs),
        loadMs: num(website.loadMs),
        accessibilityScore: num(website.accessibilityScore),
        bestPracticesScore: num(website.bestPracticesScore),
        tinyTapTargets: website.tinyTapTargets ?? null,
        copyrightYear: num(website.copyrightYear),
        yearsStale: num(website.yearsStale),
        clickToCall: website.clickToCall ?? null,
        callNumberMatchesGoogle: website.callNumberMatchesGoogle ?? null,
        hasForm: website.hasForm ?? null,
        hasEmailLink: website.hasEmailLink ?? null,
        adsRunning: website.adsRunning ?? null,
        tinyText: website.tinyText ?? null,
        poorContrast: website.poorContrast ?? null,
      },
      answers,
    };

    const { findings, allFindings, redCount, goldCount } = findingsFor(data, answers, trade);
    const summary = {
      headline: headlineFor(findings, profile, { found: foundScore, response: responseScore, track }),
      summary: summaryLine(data, findings, redCount, goldCount),
      findings,
      allFindings,
      redCount,
      goldCount,
      strengths: strengthsFor(data),
      answersInsight: "",
      nextStep: "We fix all of this for you and you keep everything we build.",
    };

    return { report: data, summary };
  }

  // The counts here are the real ones, straight off the severity sort. They used to be a
  // hardcoded phrase, which meant the intro could claim five problems above a list of two.
  function summaryLine(data, findings, redCount, goldCount) {
    const parts = [];
    const foundation = findings.find((f) => f.area === "foundation");
    if (foundation) {
      parts.push(
        data.website?.found === false
          ? "Before anything else: there is no website for your Google listing to send people to. Everything else we could fix matters less than that."
          : "The groundwork is not in place yet, so the rest of this list cannot do much until it is."
      );
    } else if (data.responseScore !== null && data.responseScore <= 50 && data.foundScore !== null && data.foundScore >= 70) {
      parts.push("The hard part is already done: customers can find you. What you told us about answering enquiries and following up is where the jobs are going.");
    }
    if (data.reviews.standing?.ok) {
      parts.push(`Your ${data.reviews.googleRating} star rating from ${reviewWord(data.reviews.googleReviewCount)} is doing its job.`);
    }

    const thing = (n) => `${n} thing${n === 1 ? "" : "s"}`;
    if (redCount && goldCount) {
      parts.push(`We found ${thing(redCount)} costing you jobs right now, and ${goldCount} more slowing you down.`);
    } else if (redCount) {
      parts.push(`We found ${thing(redCount)} costing you jobs right now.`);
    } else if (goldCount) {
      parts.push(`Nothing here is on fire, but we found ${thing(goldCount)} slowing you down.`);
    }
    return parts.join(" ");
  }

  window.DialBridgeEngine = {
    fetchRanking, buildReport, gridPoints, reviewStanding, rankingMap, leadScore, REVIEW_FLOOR,
  };
})();
