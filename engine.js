// Our own audit, run from the browser in about a second, from public Google APIs.
// This is the free taste shown on the page: profile, reviews, competitors and website.
//
// The Google Maps ranking map is deliberately NOT built here. It is the reward for giving
// us an email, so it is only ever produced server side and emailed with the full report.
// fetchRanking below is kept for that server-side use, and is not called by the page.
//
// Findings are written by rules, not a model: instant, free, and it can never invent a number.
(() => {
  "use strict";

  const PLACES_URL = "https://places.googleapis.com/v1";
  const GRID_FIELDS = "places.id,places.displayName,places.rating,places.userRatingCount,places.location";
  const GRID_SIZE = 3; // 3 x 3 points
  const GRID_SPACING_M = 3000; // 3km between points, about 2 miles
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

  // Returns the same shape the report already renders: ranks, pins, and who beats them.
  async function fetchRanking(profile, query) {
    const center = profile.location;
    if (!center || !query || !apiKey()) return null;

    const points = gridPoints(center);
    const seen = new Map(); // placeId -> { name, rating, reviewCount, appearances, bestRank }

    const results = await Promise.all(
      points.map(async (point) => {
        try {
          const places = await searchPoint(query, point);
          places.forEach((place, index) => {
            if (!place.id || place.id === profile.id) return;
            const row = seen.get(place.id) || {
              name: place.displayName?.text || "",
              rating: num(place.rating),
              reviewCount: place.userRatingCount || 0,
              appearances: 0,
              bestRank: 99,
            };
            row.appearances += 1;
            row.bestRank = Math.min(row.bestRank, index + 1);
            seen.set(place.id, row);
          });
          const index = places.findIndex((place) => place.id === profile.id);
          return { ...point, rank: index >= 0 ? index + 1 : null };
        } catch (err) {
          console.warn("Ranking point failed", err);
          return { ...point, rank: null };
        }
      })
    );

    const ranks = results.map((r) => r.rank);
    const ranked = ranks.filter((r) => r && r > 0);
    const topCompetitors = [...seen.values()]
      .sort((a, b) => b.appearances - a.appearances || a.bestRank - b.bestRank || b.reviewCount - a.reviewCount)
      .slice(0, 5)
      .map(({ name, rating, reviewCount }) => ({ name, rating, reviewCount }));

    return {
      keyword: query,
      status: "COMPLETED",
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

  // ============ SCORES ============

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

  function reviewScore(profile, competitors) {
    const rating = num(profile.rating);
    const count = profile.reviewCount || 0;
    if (rating === null && !count) return 0;
    const ratingPart = rating === null ? 0 : clamp(((rating - 3) / 2) * 100) * 0.5;
    const rivals = competitors.map((c) => c.reviewCount || 0).filter((n) => n > 0).sort((a, b) => a - b);
    const median = rivals.length ? rivals[Math.floor(rivals.length / 2)] : 0;
    const countPart = median ? clamp((count / median) * 100) * 0.5 : clamp((count / 50) * 100) * 0.5;
    return clamp(ratingPart + countPart);
  }

  function websiteScore(website) {
    if (!website || !website.hasWebsite) return 0;
    if (!website.checked) return null;
    let score = 0;
    if (num(website.speedScore) !== null) score += website.speedScore * 0.6;
    else score += 30;
    if (website.https) score += 20;
    if (website.mobileFriendly) score += 20;
    return clamp(score);
  }

  function profileScore(profile) {
    let score = 0;
    if (profile.phone) score += 20;
    if (profile.website) score += 20;
    if (profile.hasHours) score += 15;
    score += Math.min(25, (profile.photos?.length || 0) * 2.5);
    if (profile.summary) score += 10;
    if (num(profile.rating) !== null) score += 10;
    return clamp(score);
  }

  // ============ FINDINGS ============

  const money = (value) => {
    const n = Number(String(value || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  function findingsFor(data, answers) {
    const { profile, ranking, website } = data;
    const out = [];
    const leader = (data.competitors || [])[0];
    const jobValue = money(answers?.averageJobValue);

    if (ranking && ranking.gridPoints) {
      const missing = ranking.gridPoints - ranking.pointsInTop3;
      if (ranking.pointsInTop3 === 0) {
        out.push({
          area: "map_ranking",
          severity: "high",
          title: "You're not in the top 3 anywhere nearby",
          detail: `We searched "${ranking.keyword}" from ${ranking.gridPoints} spots around you. You came up ${ranking.averageRank ? `around position ${ranking.averageRank}` : "well down the list"} every time, so homeowners see other companies first.`,
          fix: "We rebuild your Google profile and keep it active so you climb into the top 3 where the calls happen.",
        });
      } else if (missing > 0) {
        out.push({
          area: "map_ranking",
          severity: missing > ranking.gridPoints / 2 ? "high" : "medium",
          title: `You're missing from the top 3 in ${missing} of ${ranking.gridPoints} spots`,
          detail: `You show in the top 3 at ${ranking.pointsInTop3} spots and slip below it at the other ${missing}. Those are jobs going to whoever shows up instead.`,
          fix: "We work your profile and reviews so the weak spots on that map turn green.",
        });
      }
    }

    if (leader && (profile.reviewCount || 0) < leader.reviewCount) {
      const gap = leader.reviewCount - (profile.reviewCount || 0);
      out.push({
        area: "reviews",
        severity: gap > 100 ? "high" : "medium",
        title: `${leader.name} has ${gap} more reviews than you`,
        detail: `They sit on ${leader.reviewCount} Google reviews to your ${profile.reviewCount || 0}. Homeowners compare those two numbers before they call anyone.`,
        fix: "We ask every customer for a review automatically, by text, right after the job.",
      });
    }

    if (!website.hasWebsite) {
      out.push({
        area: "website",
        severity: "high",
        title: "No website on your Google profile",
        detail: "Homeowners who can't find a website usually call the next company on the list, even when your reviews are better.",
        fix: "We build and host the site, and it is yours to keep.",
      });
    } else if (website.checked) {
      if (num(website.speedScore) !== null && website.speedScore < 50) {
        out.push({
          area: "website",
          severity: "high",
          title: `Your website scores ${website.speedScore} out of 100 on a phone`,
          detail: `It takes ${website.loadTime || "several seconds"} for the main content to show up. Most people leave before that.`,
          fix: "We rebuild it to load fast on a phone, where nearly all your traffic comes from.",
        });
      }
      if (website.https === false) {
        out.push({
          area: "website",
          severity: "medium",
          title: "Browsers call your website \"Not secure\"",
          detail: "Your site has no HTTPS, so Chrome warns visitors before they ever see your prices.",
          fix: "We move the site onto secure hosting so the warning is gone.",
        });
      }
      if (website.mobileFriendly === false) {
        out.push({
          area: "website",
          severity: "medium",
          title: "Your website doesn't fit a phone screen",
          detail: "Visitors have to pinch and scroll sideways to read it, and most give up instead.",
          fix: "We rebuild it to fit any screen.",
        });
      }
    }

    if (!profile.phone) {
      out.push({
        area: "google_profile",
        severity: "high",
        title: "No phone number on your Google profile",
        detail: "There is no call button on your listing, so anyone who finds you has to go looking for a way to reach you.",
        fix: "We fix the profile and add a tracked number so every call is answered and logged.",
      });
    }
    if ((profile.photos?.length || 0) < 5) {
      out.push({
        area: "google_profile",
        severity: "medium",
        title: profile.photos?.length ? `Only ${profile.photos.length} photos on your profile` : "No photos on your profile",
        detail: "Profiles with real job photos get picked over ones without them, and Google shows them more often.",
        fix: "We keep fresh job photos going up on your profile every month.",
      });
    }
    if (!profile.hasHours) {
      out.push({
        area: "google_profile",
        severity: "medium",
        title: "No business hours on Google",
        detail: "Google hides listings without hours from some searches, and homeowners assume you're closed.",
        fix: "We set your hours and keep them current, holidays included.",
      });
    }

    if (answers?.afterHoursHandling && /voicemail|nobody|no one|miss/i.test(answers.afterHoursHandling)) {
      out.push({
        area: "lead_follow_up",
        severity: "high",
        title: "After-hours calls go to voicemail",
        detail: jobValue
          ? `You told us calls after hours go to voicemail. At about $${jobValue.toLocaleString()} a job, a few missed calls a week is real money walking away.`
          : "You told us calls after hours go to voicemail. Most homeowners with an urgent job call the next company instead of leaving a message.",
        fix: "Every missed call gets an instant text back, and the conversation keeps going until it's booked.",
      });
    }
    if (answers?.quoteFollowUp && /nothing|never|rarely|manual|myself/i.test(answers.quoteFollowUp)) {
      out.push({
        area: "lead_follow_up",
        severity: "high",
        title: "Quotes go out and nothing follows them",
        detail: "Most quotes that never get a follow-up are lost to whoever called the homeowner back first.",
        fix: "We follow up every quote for you by text and email until they answer.",
      });
    }

    const order = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 5);
  }

  function strengthsFor(data) {
    const { profile, ranking, website } = data;
    const out = [];
    if (num(profile.rating) !== null && profile.rating >= 4.7 && (profile.reviewCount || 0) >= 10) {
      out.push(`A ${profile.rating} star rating from ${profile.reviewCount} reviews, which is better than most of your competition.`);
    }
    if (ranking && ranking.pointsInTop3 >= ranking.gridPoints / 2) {
      out.push(`You already show in the top 3 at ${ranking.pointsInTop3} of ${ranking.gridPoints} spots on the map.`);
    }
    if (website.checked && num(website.speedScore) !== null && website.speedScore >= 80) {
      out.push(`Your website scores ${website.speedScore} out of 100 for speed on a phone.`);
    }
    if ((profile.photos?.length || 0) >= 10) out.push("Your profile has a full set of photos.");
    if (profile.hasHours && profile.phone && profile.website) out.push("Your hours, phone number and website are all on your Google listing.");
    return out.slice(0, 3);
  }

  function headlineFor(findings, profile) {
    const first = findings[0];
    if (!first) return `${profile.name} is in good shape online`;
    const byArea = {
      map_ranking: "Homeowners nearby are seeing your competitors first",
      reviews: "Your competitors' review counts are winning the click",
      website: "Your website is costing you the calls you already earned",
      google_profile: "Your Google listing is turning people away",
      lead_follow_up: "The leads you already get are slipping through",
    };
    return byArea[first.area] || first.title;
  }

  // ============ BUILD ============

  function buildReport({ profile, competitors = [], website, answers = {}, submissionId = null }) {
    const ranking = null; // never on the page, see the note at the top
    const scores = {
      "Google Maps ranking": rankingScore(ranking),
      "Reviews and reputation": reviewScore(profile, competitors),
      "Website": websiteScore(website),
      "Google profile": profileScore(profile),
    };
    const weights = { "Google Maps ranking": 0.35, "Reviews and reputation": 0.35, Website: 0.3, "Google profile": 0.3 };
    let total = 0;
    let used = 0;
    const grades = [];
    for (const [name, score] of Object.entries(scores)) {
      if (score === null) continue;
      grades.push({ name, score, level: score >= 80 ? "success" : score >= 50 ? "warning" : "error" });
      total += score * weights[name];
      used += weights[name];
    }
    const overallScore = used ? clamp(total / used) : null;

    const data = {
      submissionId,
      source: "dialbridge",
      generatedAt: new Date().toISOString(),
      overallScore,
      grades,
      profile: {
        name: profile.name,
        category: profile.category || "",
        address: profile.address || "",
        phone: profile.phone || "",
        photoCount: profile.photos?.length || 0,
        hasHours: Boolean(profile.hasHours),
        claimed: null,
      },
      competitors,
      reviews: {
        status: "COMPLETED",
        googleRating: num(profile.rating),
        googleReviewCount: profile.reviewCount || 0,
        recent: (profile.reviews || []).slice(0, 3),
      },
      website: {
        url: website.url || "",
        found: Boolean(website.hasWebsite),
        mobileScore: num(website.speedScore),
        mobileLoadTime: website.loadTime || "",
        https: website.https ?? null,
        mobileFriendly: website.mobileFriendly ?? null,
      },
      answers,
    };

    const findings = findingsFor(data, answers);
    const summary = {
      headline: headlineFor(findings, profile),
      summary: summaryLine(data, findings),
      findings,
      strengths: strengthsFor(data),
      answersInsight: "",
      nextStep: "We fix all of this for you and you keep everything we build.",
    };

    return { report: data, summary };
  }

  function summaryLine(data, findings) {
    const parts = [];
    const r = data.ranking;
    if (r && r.gridPoints) {
      parts.push(
        r.pointsInTop3
          ? `You show up in the top 3 on Google Maps at ${r.pointsInTop3} of ${r.gridPoints} spots around you.`
          : `You don't crack the top 3 on Google Maps anywhere we checked around you.`
      );
    }
    if (num(data.reviews.googleRating) !== null) {
      parts.push(`Your ${data.reviews.googleRating} star rating from ${data.reviews.googleReviewCount} reviews is doing its job.`);
    }
    const high = findings.filter((f) => f.severity === "high").length;
    if (high) parts.push(`We found ${high === 1 ? "one thing" : `${high} things`} costing you jobs right now.`);
    return parts.join(" ");
  }

  window.DialBridgeEngine = { fetchRanking, buildReport, gridPoints };
})();
