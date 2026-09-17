// Full report shown on the same page, right under the scan. After the page sends the
// business to n8n, we poll the status endpoint with our submission id. n8n runs the deeper
// audit and writes the plain-English summary, and this draws it as soon as it lands.
(() => {
  "use strict";

  // The page builds its own report now. The status endpoint stays in n8n, switched off,
  // for the day we want to merge the emailed audit's listings back into the page.
  const STATUS_URL = () => window.DIALBRIDGE_CONFIG?.N8N_REPORT_STATUS_URL || "";
  const EMAIL_URL = () => window.DIALBRIDGE_CONFIG?.N8N_REPORT_EMAIL_URL || "";
  const TERMS_URL = "https://dialbridge.ai/terms";
  const PRIVACY_URL = "https://dialbridge.ai/privacy";

  // Consent has to sit at the point of collection, next to the button that gives it, and we
  // store the exact wording somebody saw with their submission. A screenshot of today's
  // page is no use in six months when the copy has changed.
  const SMS_CONSENT =
    "By tapping Text me the code you agree that DialBridge LLC may text and call you at this number about your report and our services, including by automated means. Consent is not a condition of any purchase. Message frequency varies, and message and data rates may apply. Reply STOP to opt out or HELP for help.";
  const EMAIL_CONSENT =
    "By tapping Email me the map you agree that DialBridge LLC may email you this report and follow up about it. You can unsubscribe from any email.";

  function consentNodes(text) {
    return [
      text + " See our ",
      h("a", { href: TERMS_URL, target: "_blank", rel: "noopener", text: "Terms" }),
      " and ",
      h("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener", text: "Privacy Policy" }),
      ".",
    ];
  }

  const UNLOCK_SEND_URL = () => window.DIALBRIDGE_CONFIG?.N8N_UNLOCK_SEND_URL || "";
  const UNLOCK_VERIFY_URL = () => window.DIALBRIDGE_CONFIG?.N8N_UNLOCK_VERIFY_URL || "";
  const STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
  const POLL_MS = 4000;
  const MAX_MS = 12 * 60 * 1000; // audits with a slow review scan can take several minutes

  const $ = (id) => document.getElementById(id);
  const h = (...args) => window.DialBridgeScan.h(...args);
  const img = (...args) => window.DialBridgeScan.img(...args);
  const apiKey = () => window.DIALBRIDGE_CONFIG?.GOOGLE_MAPS_API_KEY || "";
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let polling = false;

  const AREA_LABELS = {
    google_profile: "Google profile",
    map_ranking: "Google Maps ranking",
    reviews: "Reviews",
    website: "Website",
    listings: "Business listings",
    business_details: "Business details",
    lead_follow_up: "Lead follow-up",
    foundation: "The basics",
  };

  const SEVERITY = {
    high: { tone: "bad", label: "Costing you jobs" },
    medium: { tone: "warn", label: "Slowing you down" },
    low: { tone: "good", label: "Worth a look" },
  };

  // The audit ships jargon category names; say them the way a contractor would.
  const GRADE_LABELS = {
    "Techno Stack": "Tracking and tools",
    "Business Details": "Business info accuracy",
    "SEO Analysis": "Search setup",
    "Listings": "Business listings",
    "Online Reputation": "Reviews and reputation",
    "Website Performance": "Website speed",
    "Google Business Profile": "Google profile",
  };

  // Pin colours match the legend: top 3, pushed down, nowhere to be found.
  const PIN_GOOD = "0x1f7a4d";
  const PIN_WARN = "0xe8702a";
  const PIN_BAD = "0xa33a22";

  function setStatus(text, tone = "") {
    const el = $("reportStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `report-status${tone ? ` is-${tone}` : ""}`;
    el.hidden = !text;
  }

  const dollars = (n) => "$" + Number(n).toLocaleString("en-US");

  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // Google often hands back a listing URL stuffed with tracking parameters. Show the domain.
  function domainOf(url) {
    const bare = String(url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return bare.split(/[?#]/)[0].split("/")[0];
  }

  function scoreTone(score) {
    if (score === null) return "warn";
    return score >= 80 ? "good" : score >= 50 ? "warn" : "bad";
  }

  function rankTone(rank) {
    if (!rank || rank > 10) return "bad";
    return rank <= 3 ? "good" : "warn";
  }

  function scoreRing(score, caption, size = "lg") {
    const value = num(score);
    return h("div", { class: `ring ring-${size} tone-${scoreTone(value)}`, style: `--pct:${value ?? 0}` },
      h("span", { class: "ring-inner" }, [
        h("strong", { text: value === null ? "?" : String(value) }),
        h("small", { text: caption }),
      ]));
  }

  // The browser already ran its own phone speed test during the scan. If GHL's website
  // section is switched off (it is slow and we duplicate it), fill the gaps from ours.
  function withLocalScan(report) {
    const local = window.scanResult?.website;
    if (!report || !local || !local.hasWebsite) return report;
    const w = report.website || (report.website = {});
    if (!w.url && local.url) w.url = local.url;
    if (w.found !== true) w.found = true;
    if (num(w.mobileScore) === null && num(local.speedScore) !== null) w.mobileScore = local.speedScore;
    if (!w.mobileLoadTime && local.loadTime) w.mobileLoadTime = local.loadTime;
    if (w.https === null || w.https === undefined) w.https = local.https;
    if (w.mobileFriendly === null || w.mobileFriendly === undefined) w.mobileFriendly = local.mobileFriendly;
    return report;
  }

  // ============ SECTIONS ============

  function statChips(report) {
    const rv = report?.reviews || {};
    const rk = report?.ranking || {};
    const ls = report?.listings || {};
    const web = report?.website || {};
    const chips = [
      num(rv.googleRating) !== null
        ? { tone: rv.googleRating >= 4.5 ? "good" : "warn", value: `${rv.googleRating}★`, label: `${rv.googleReviewCount ?? 0} Google reviews` }
        : null,
      Array.isArray(rk.ranks) && rk.ranks.length
        ? { tone: rk.pointsInTop3 >= rk.ranks.length / 2 ? "good" : "bad", value: `${rk.pointsInTop3}/${rk.ranks.length}`, label: "spots in the top 3" }
        : null,
      num(ls.checked)
        ? { tone: ls.missing > ls.found ? "bad" : "good", value: `${ls.found}/${ls.checked}`, label: "directories list you" }
        : null,
      num(web.mobileScore) !== null
        ? { tone: web.mobileScore >= 50 ? "good" : "bad", value: String(web.mobileScore), label: "phone speed score" }
        : null,
    ].filter(Boolean);
    if (!chips.length) return null;
    return h("ul", { class: "stat-row" }, chips.map((c) =>
      h("li", { class: `stat tone-${c.tone}` }, [
        h("strong", { text: c.value }),
        h("span", { text: c.label }),
      ])
    ));
  }

  function renderHero(summary, report) {
    const p = report?.profile || {};
    const response = num(report?.responseScore);
    return h("header", { class: "report-hero" }, [
      h("div", { class: "report-hero-top" }, [
        h("div", { class: "hero-rings" }, [
          h("div", { class: "hero-ring" }, [
            scoreRing(report?.foundScore ?? report?.overallScore, "out of 100"),
            h("p", { class: "hero-ring-label", text: "Getting found" }),
          ]),
          response !== null
            ? h("div", { class: "hero-ring" }, [
                scoreRing(response, "out of 100"),
                h("p", { class: "hero-ring-label", text: "Catching the lead" }),
              ])
            : null,
        ].filter(Boolean)),
        h("div", { class: "report-hero-text" }, [
          h("h2", { text: summary?.headline || "Here's where you're losing jobs online" }),
          summary?.summary ? h("p", { class: "lead", text: summary.summary }) : null,
        ]),
      ]),
      renderLeak(report?.leak),
    ].filter(Boolean));
  }



  // The money line shows its own arithmetic: their job pace, their job value, and the
  // share their own answers put at risk. Nothing here is a number we made up.
  function renderLeak(leak) {
    if (!leak) return null;
    const money = (n) => `$${Number(n).toLocaleString("en-US")}`;
    const percent = `${Math.round(leak.rate * 100)}%`;

    if (!leak.perMonth) {
      return h("div", { class: "hero-leak" }, [
        h("p", { class: "hero-leak-value", text: money(leak.jobValue) }),
        h("div", {}, [
          h("p", { class: "hero-leak-label", text: "gone with every lead you miss" }),
          h("p", { class: "hero-leak-note", text: "That is the job value you gave us. We could not work out your job pace from your reviews, so we are not going to guess at a monthly figure." }),
        ]),
      ]);
    }

    return h("div", { class: "hero-leak" }, [
      h("p", { class: "hero-leak-value", text: money(leak.perMonth) }),
      h("div", {}, [
        h("p", { class: "hero-leak-label", text: "a month, on your own numbers" }),
        h("ul", { class: "hero-leak-math" }, [
          h("li", { text: `About ${leak.jobs} jobs a month, going by how fast reviews land on your profile` }),
          h("li", { text: `${money(leak.jobValue)} a job, the figure you gave us` }),
          h("li", { text: leak.lostJobs >= 1
            ? `${percent} of them at risk from what you told us about calls and quotes, which is about ${leak.lostJobs} ${leak.lostJobs === 1 ? "job" : "jobs"} a month`
            : `${percent} of them at risk from what you told us about calls and quotes, which works out to roughly one job every ${Math.max(2, Math.round(1 / leak.lostJobs))} months` }),
        ]),
      ]),
    ]);
  }


  // Google hands back a real photo of the site on a phone as part of the speed test. A
  // contractor who sees their own site in a phone frame gets it faster than any score.
  function renderPhoneShot(report) {
    const w = report?.website;
    if (!w || !w.screenshot) return null;
    const checks = [
      w.tinyTapTargets
        ? { ok: false, text: typeof w.tinyTapTargets === "number" ? `${w.tinyTapTargets} buttons or links are too small to tap` : "Buttons and links are too small to tap" }
        : null,
      w.tinyText === true ? { ok: false, text: "Text is too small to read without zooming" } : null,
      w.poorContrast
        ? { ok: false, text: typeof w.poorContrast === "number" ? `${w.poorContrast} places where text blends into the background` : "Text blends into the background" }
        : null,
      num(w.accessibilityScore) !== null ? { ok: w.accessibilityScore >= 80, text: `Ease of use scores ${w.accessibilityScore} out of 100` } : null,
    ].filter(Boolean);

    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "This is your website on a phone" }),
        h("span", { class: "card-hint", text: "Taken just now" }),
      ]),
      h("div", { class: "shot-row" }, [
        h("div", { class: "phone-frame" }, img(w.screenshot, { class: "phone-shot", alt: "Your website as it appears on a phone" })),
        h("div", { class: "shot-copy" }, [
          h("p", { class: "muted", text: "This is the first thing a homeowner sees after they find you. Speed is only half of it. If it is hard to read or hard to tap, they leave and call the next company." }),
          checks.length ? h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))) : null,
        ].filter(Boolean)),
      ]),
    ]);
  }

  // Where we explain the offer by explaining their problem. No price, no pitch language,
  // just the shape of the fix, built from the findings they actually have.
  // Three things decide whether a job is theirs, and each one is a thing we do. This
  // section teaches rather than pitches: what each piece is, and what it changes. No
  // prices, no packages, no booking pressure. The pillar their own report is worst at is
  // marked "start here", so the education lands on the problem they just read about.
  const PILLARS = [
    {
      key: "found",
      eyebrow: "1. Get found",
      heading: "Being the one they call starts with being the one they see",
      areas: ["foundation", "website", "google_profile", "listings", "map_ranking"],
      items: [
        ["A website built to be found, and to ask for the job",
         "Loads fast on a phone, your number one tap away, and the pages Google wants before it will rank you locally. We build and host it, and it stays yours."],
        ["Your Google profile actually worked",
         "Categories, services, hours, photos and posts kept current. It is the biggest single lever on where you appear on the map, and most profiles are filled in once and never touched again."],
      ],
    },
    {
      key: "chosen",
      eyebrow: "2. Get chosen",
      heading: "Two companies, same price. The one with more recent reviews gets the call",
      areas: ["reviews"],
      items: [
        ["Every finished job asks for a review",
         "By text, while they are still pleased with the work. That is the only moment most people will actually write one."],
        ["Every review gets a reply",
         "In your voice, within the day. Homeowners read the replies to work out what you are like when something goes wrong, and Google counts them too."],
        ["A steady run, not one good week two years ago",
         "Reviews arriving every month is what moves you up the map. A burst and then silence reads as a business that stopped."],
      ],
    },
    {
      key: "capture",
      eyebrow: "3. Capture every lead",
      heading: "You cannot answer the phone from a roof, so something else has to",
      areas: ["lead_follow_up"],
      items: [
        ["A text back on every missed call",
         "Within seconds, so they are answering you instead of dialling the next company on the list. This one change catches more work than any amount of extra traffic."],
        ["Cover for after hours and the calls you cannot take",
         "An assistant that answers, takes the details and books the job. It says up front that it is an assistant, because pretending otherwise would cost you the trust you are trying to build."],
        ["Booking and follow-up that does not wait on you",
         "Jobs land straight in your calendar, and a quote that goes quiet gets chased instead of quietly dying."],
      ],
    },
  ];

  function renderPlan(report, summary) {
    const findings = summary?.findings || [];
    const worst = findings[0];
    const startKey = worst
      ? (PILLARS.find((pillar) => pillar.areas.includes(worst.area)) || {}).key
      : null;

    return h("section", { class: "card card-wide card-plan" }, [
      h("p", { class: "eyebrow", text: "What fixing this looks like" }),
      h("h3", { text: "Three things decide whether a job is yours" }),
      h("p", { class: "plan-lead", text: "Every business that beats you locally is doing these three well, whether they meant to or not. None of it is clever, and none of it needs another person on the payroll. It just has to happen every single day, which is the part that breaks." }),

      h("div", { class: "plan-pillars" }, PILLARS.map((pillar) =>
        h("section", { class: `plan-pillar${pillar.key === startKey ? " is-start" : ""}` }, [
          h("div", { class: "plan-pillar-head" }, [
            h("p", { class: "plan-eyebrow", text: pillar.eyebrow }),
            pillar.key === startKey ? h("span", { class: "plan-flag", text: "Start here" }) : null,
          ]),
          h("p", { class: "plan-heading", text: pillar.heading }),
          h("ul", { class: "plan-items" }, pillar.items.map(([title, body]) =>
            h("li", {}, [
              h("strong", { text: title }),
              h("p", { text: body }),
            ])
          )),
        ])
      )),

      h("p", { class: "plan-close", text: "You keep everything we build. The site, the profile, the number, the reviews. Yours whether we carry on working together or not." }),
    ]);
  }

  // The whole report in one glance: three stages of getting a job, and which one breaks.
  // A contractor reads this before any number and knows what we are about to tell them.
  function renderJourney(report) {
    const rk = report?.ranking || {};
    const rv = report?.reviews || {};
    const web = report?.website || {};
    const found = num(report?.foundScore);
    const response = num(report?.responseScore);

    const stages = [
      {
        label: "They find you",
        ok: found === null ? null : found >= 60,
        detail: num(rv.googleReviewCount)
          ? `${rv.googleRating ?? "?"} stars, ${rv.googleReviewCount} reviews on Google`
          : "Your Google listing",
      },
      {
        label: "They check you out",
        ok: web.found === false ? false : num(web.mobileScore) === null ? null : web.mobileScore >= 70,
        detail: web.found === false
          ? "No website to send them to"
          : num(web.mobileScore) !== null
            ? `Your site takes ${web.mobileLoadTime || "a few seconds"} to show up on a phone`
            : "Your website",
      },
      {
        label: "You catch the job",
        ok: response === null ? null : response >= 60,
        detail: response === null
          ? "How you handle calls and quotes"
          : response >= 60
            ? "Calls answered and quotes followed up"
            : "This is where the jobs are going",
      },
    ];

    return h("section", { class: "journey" }, stages.map((stage, i) =>
      h("div", { class: `journey-step is-${stage.ok === null ? "unknown" : stage.ok ? "ok" : "broken"}` }, [
        h("span", { class: "journey-mark", "aria-hidden": "true", text: stage.ok === null ? "?" : stage.ok ? "✓" : "✕" }),
        h("div", {}, [
          h("p", { class: "journey-label", text: stage.label }),
          h("p", { class: "journey-detail", text: stage.detail }),
        ]),
        i < stages.length - 1 ? h("span", { class: "journey-arrow", "aria-hidden": "true", text: "→" }) : null,
      ].filter(Boolean))
    ));
  }

  // The headline numbers as tiles. Big number, plain label, status colour plus a word,
  // never colour alone.
  function renderNumbers(report) {
    const rv = report?.reviews || {};
    const rk = report?.ranking || {};
    const ls = report?.listings || {};
    const w = report?.website || {};
    const tiles = [
      num(rv.googleRating) !== null
        ? { value: `${rv.googleRating}`, unit: "stars", label: `from ${rv.googleReviewCount || 0} Google reviews`, tone: rv.googleRating >= 4.5 ? "good" : "warn" }
        : null,
      Array.isArray(rk.ranks) && rk.ranks.length
        ? { value: `${rk.pointsInTop3}`, unit: `of ${rk.ranks.length}`, label: "spots where you make the top 3", tone: rk.pointsInTop3 >= rk.ranks.length / 2 ? "good" : "bad" }
        : null,
      num(w.mobileScore) !== null
        ? { value: `${w.mobileScore}`, unit: "of 100", label: "website speed on a phone", tone: w.mobileScore >= 80 ? "good" : w.mobileScore >= 50 ? "warn" : "bad" }
        : null,
      num(w.desktopScore) !== null
        ? { value: `${w.desktopScore}`, unit: "of 100", label: "website speed on a computer", tone: w.desktopScore >= 80 ? "good" : w.desktopScore >= 50 ? "warn" : "bad" }
        : null,
      num(ls.checked)
        ? { value: `${ls.found}`, unit: `of ${ls.checked}`, label: "directories that list you", tone: ls.missing > ls.found ? "bad" : "good" }
        : null,
    ].filter(Boolean);
    if (!tiles.length) return null;
    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "Your numbers" })]),
      h("ul", { class: "tiles" }, tiles.map((t) =>
        h("li", { class: `tile tone-${t.tone}` }, [
          h("p", { class: "tile-value" }, [h("strong", { text: t.value }), h("span", { text: t.unit })]),
          h("p", { class: "tile-label", text: t.label }),
        ])
      )),
    ]);
  }

  // A real Google map with a pin per grid point, the way the audit shows it.
  function mapImage(ranking) {
    const points = (ranking?.points || []).filter((p) => num(p.lat) !== null && num(p.lng) !== null);
    if (!points.length || !apiKey()) return null;

    const params = ["size=640x420", "scale=2", "maptype=roadmap", "format=png"];
    if (ranking.center && num(ranking.center.lat) !== null) {
      params.push(`markers=${encodeURIComponent(`color:0x0f1b2d|label:H|${ranking.center.lat},${ranking.center.lng}`)}`);
    }
    for (const point of points) {
      const rank = num(point.rank);
      const color = rankTone(rank) === "good" ? PIN_GOOD : rankTone(rank) === "warn" ? PIN_WARN : PIN_BAD;
      // Static map labels take a single character, so anything past 9 shows as X.
      const label = rank && rank <= 9 ? String(rank) : "X";
      params.push(`markers=${encodeURIComponent(`color:${color}|label:${label}|${point.lat},${point.lng}`)}`);
    }
    params.push(`key=${encodeURIComponent(apiKey())}`);
    return img(`${STATIC_MAP_URL}?${params.join("&")}`, {
      class: "report-map",
      alt: `Map of your Google ranking around ${ranking.keyword || "your area"}`,
      loading: "lazy",
    });
  }

  function renderRanking(report) {
    const r = report?.ranking;
    if (!r || !Array.isArray(r.ranks) || !r.ranks.length) return null;
    const map = mapImage(r);
    const competitors = r.topCompetitors || [];
    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: `Where you show up for "${r.keyword}"` }),
        num(r.averageRank) !== null ? h("span", { class: `pill tone-${rankTone(Math.round(r.averageRank))}`, text: `Average position ${r.averageRank}` }) : null,
      ]),
      map
        ? h("div", { class: "map-wrap" }, [
            map,
            h("ul", { class: "map-legend" }, [
              h("li", { class: "tone-good", text: "Top 3, customers see you" }),
              h("li", { class: "tone-warn", text: "4 to 10, below the fold" }),
              h("li", { class: "tone-bad", text: "Not showing up" }),
            ]),
          ])
        : h("div", { class: "rank-grid", "aria-hidden": "true" }, r.ranks.map((rank) =>
            h("span", { class: `rank-cell tone-${rankTone(rank)}`, text: rank ? String(rank) : "20+" })
          )),
      h("p", { class: "muted", text: `Each pin is a spot where a homeowner searches. The number is your position on Google Maps there. You are in the top 3 at ${r.pointsInTop3} of ${r.ranks.length} spots.` }),
      competitors.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "cmp" }, [
            h("thead", {}, h("tr", {}, [h("th", { text: "Beating you nearby" }), h("th", { text: "Rating" }), h("th", { text: "Reviews" })])),
            h("tbody", {}, competitors.map((c) =>
              h("tr", {}, [
                h("td", { text: c.name || "" }),
                h("td", { text: num(c.rating) !== null ? `${c.rating.toFixed(1)}★` : "None" }),
                h("td", { class: "mono", text: String(c.reviewCount ?? 0) }),
              ])
            )),
          ]))
        : null,
    ]);
  }

  function renderFindings(summary) {
    const findings = summary?.findings || [];
    if (!findings.length) return null;
    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "What's costing you jobs" }),
        h("span", { class: "card-hint", text: "Worst first" }),
      ]),
      // Number, headline, explanation. The severity used to repeat itself as a coloured
      // chip beside every title, and the area label printed three times over when three
      // findings shared one. Both said less than the titles already do, so the severity is
      // now just the colour of the rule and the area label is gone.
      h("ol", { class: "findings-list" }, findings.slice(0, 4).map((f, i) => {
        const severity = SEVERITY[f.severity] || SEVERITY.medium;
        return h("li", { class: `finding-card tone-${severity.tone}` }, [
          h("span", { class: "finding-num", "aria-hidden": "true", text: String(i + 1) }),
          h("div", { class: "finding-main" }, [
            h("strong", { class: "finding-title", text: f.title || "" }),
            f.detail ? h("p", { text: f.detail }) : null,
          ]),
        ]);
      })),
    ]);
  }

  function renderGrades(report) {
    const grades = (report?.grades || []).filter((g) => !/overall/i.test(g.name || "") && num(g.score) !== null);
    if (!grades.length) return null;
    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "Your scorecard" }),
        h("span", { class: "card-hint", text: "Higher is better" }),
      ]),
      h("ul", { class: "grade-list" }, grades.map((g) =>
        h("li", { class: `grade tone-${g.level === "success" ? "good" : g.level === "warning" ? "warn" : "bad"}` }, [
          h("span", { class: "grade-name", text: GRADE_LABELS[g.name] || g.name }),
          h("span", { class: "grade-bar" }, h("span", { class: "grade-fill", style: `width:${Math.max(2, Math.min(100, g.score))}%` })),
          h("span", { class: "grade-score mono", text: String(g.score) }),
        ])
      )),
    ]);
  }

  function renderReviews(report) {
    const rv = report?.reviews;
    if (!rv) return null;
    // The star rating and count are already tiles, and the competitor gap is already a
    // finding. This card only carries what neither of those says.
    const items = [
      num(rv.unansweredCount) !== null
        ? { ok: rv.unansweredCount === 0, text: rv.unansweredCount === 0 ? "Every review has a reply from you" : `${rv.unansweredCount} reviews with no reply from you` }
        : null,
      num(rv.replyRatePercent) !== null ? { ok: rv.replyRatePercent >= 80, text: `You reply to ${rv.replyRatePercent}% of reviews` } : null,
      rv.lastReviewAt ? { ok: true, text: `Your last review came in on ${rv.lastReviewAt}` } : null,
      num(rv.facebookReviewCount) !== null
        ? { ok: rv.facebookReviewCount > 0, text: rv.facebookReviewCount > 0 ? `${rv.facebookReviewCount} reviews on Facebook too` : "No reviews on Facebook" }
        : null,
    ].filter(Boolean);
    if (!items.length) return null;
    return h("section", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "Your reviews" })]),
      h("ul", { class: "checks" }, items.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
    ]);
  }

  function renderListings(report) {
    const l = report?.listings;
    if (!l || !num(l.checked)) return null;
    const pct = Math.round((l.found / l.checked) * 100);
    return h("section", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "Where your business is listed" }),
        h("span", { class: `pill tone-${l.missing > l.found ? "bad" : "good"}`, text: `${l.found} of ${l.checked}` }),
      ]),
      h("span", { class: "meter" }, h("span", { class: `meter-fill tone-${l.missing > l.found ? "bad" : "good"}`, style: `width:${Math.max(2, pct)}%` })),
      (l.missingOn || []).length
        ? h("div", { class: "tag-row" }, l.missingOn.slice(0, 10).map((name) => h("span", { class: "tag tone-bad", text: name.toLowerCase() })))
        : null,
      (l.partialOn || []).length
        ? h("p", { class: "muted", text: `Wrong or incomplete on: ${l.partialOn.join(", ").toLowerCase()}` })
        : null,
    ]);
  }

  function renderWebsite(report) {
    const w = report?.website;
    if (!w) return null;
    if (!w.found || !w.url) {
      return h("section", { class: "card" }, [
        h("div", { class: "card-head" }, [h("h3", { text: "Your website" }), h("span", { class: "pill tone-bad", text: "None found" })]),
        h("p", { class: "muted", text: "Homeowners who can't find a website usually call the next company on the list." }),
      ]);
    }
    // The speed numbers live in the tiles above. This card is only the yes-or-no checks.
    const checks = [
      w.https === null || w.https === undefined ? null : { ok: w.https, text: w.https ? "Secure, no browser warning" : "Not secure, browsers warn visitors" },
      w.mobileFriendly === null || w.mobileFriendly === undefined ? null : { ok: w.mobileFriendly, text: w.mobileFriendly ? "Fits a phone screen" : "Doesn't fit a phone screen" },
      w.googleAnalytics === null || w.googleAnalytics === undefined ? null : { ok: w.googleAnalytics, text: w.googleAnalytics ? "Visitor tracking is set up" : "No visitor tracking, so you can't tell where leads come from" },
      w.chatWidget === null || w.chatWidget === undefined ? null : { ok: w.chatWidget, text: w.chatWidget ? "Visitors can message you from the site" : "No way to message you from the site" },
    ].filter(Boolean);
    if (!checks.length) return null;
    return h("section", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "Your website" }),
        h("span", { class: "card-hint", text: domainOf(w.url) }),
      ]),
      h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
    ]);
  }

  function renderStrengths(summary) {
    const strengths = summary?.strengths || [];
    if (!strengths.length) return null;
    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "What's already working" })]),
      h("ul", { class: "checks" }, strengths.map((s) => h("li", { class: "ok", text: s }))),
    ]);
  }

  // Quiet on purpose. They have just been handed something useful for nothing, and the
  // fastest way to waste that is to follow it with a sales push. An offer they can ignore.
  function renderNextStep(report) {
    const name = report?.profile?.name;
    return h("section", { class: "card card-wide card-cta" }, [
      h("h3", { text: "If you want a hand with any of it" }),
      h("p", { text: name
        ? `Reply to the text I sent and ask me anything about this report. If it is useful I will tell you what I would fix first for ${name} and roughly what it takes. If it is not, no harm done.`
        : "Reply to the text I sent and ask me anything about this report. If it is useful I will tell you what I would fix first and roughly what it takes. If it is not, no harm done." }),
      h("p", { class: "cta-fine" }, [
        "Rather talk it through? ",
        h("a", { href: "https://www.dialbridge.ai", target: "_blank", rel: "noopener", text: "Pick a time here" }),
        ". Fifteen minutes, this report open in front of us, no deck.",
      ]),
    ]);
  }


  // The ranking map is the reason to hand over an email, so it is never built or shown here.
  // We describe it, take the email, and n8n emails the full report with the map in it.
  function renderMapGate() {
    const form = h("form", { class: "gate-form", novalidate: "" }, [
      h("label", { class: "visually-hidden", for: "gateEmail", text: "Email address" }),
      h("input", { id: "gateEmail", type: "email", name: "email", placeholder: "you@yourcompany.com", autocomplete: "email", required: "" }),
      h("button", { class: "cta", type: "submit", text: "Email me the map" }),
    ]);
    const note = h("p", { class: "gate-note", role: "status", "aria-live": "polite" });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector("#gateEmail");
      const email = input.value.trim();
      const button = form.querySelector("button");
      if (!/^[^@\s]+@[^@\s.]+\.[a-z]{2,}$/i.test(email)) {
        note.textContent = "That email doesn't look right.";
        note.className = "gate-note is-bad";
        input.focus();
        return;
      }
      if (!EMAIL_URL() || !window.reportSubmissionId) {
        note.textContent = "We can't send it right now. Try again in a minute.";
        note.className = "gate-note is-bad";
        return;
      }
      button.disabled = true;
      button.textContent = "Sending...";
      try {
        const res = await fetch(EMAIL_URL(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submissionId: window.reportSubmissionId,
            email,
            answers: window.leadAnswers || {},
            consent: EMAIL_CONSENT,
            // What the scan actually searched for. Google files plenty of real trades under
            // the category "service", and a ranking grid built on that word finds nothing
            // and tells the owner they rank nowhere.
            keyword: window.scanResult?.trade || "",
            // The scan already paid Google for these, with names and review counts. Sending
            // them along means the emailed map can name who is beating them without buying
            // the same information a second time.
            competitors: (window.scanResult?.competitors || []).slice(0, 5).map((c) => ({
              name: c.name || "",
              rating: typeof c.rating === "number" ? c.rating : null,
              reviewCount: c.reviewCount || 0,
            })),
            company_fax: document.getElementById("companyFax")?.value || "",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
        form.replaceChildren();
        note.textContent = `On its way to ${email}. Check your inbox in a few minutes for the map and the rest of your report.`;
        note.className = "gate-note is-good";
      } catch (err) {
        console.warn("Email request failed", err);
        note.textContent = "That didn't go through. Try again.";
        note.className = "gate-note is-bad";
        button.disabled = false;
        button.textContent = "Email me the map";
      }
    });

    return h("section", { class: "card card-wide card-gate" }, [
      h("div", { class: "gate-visual", "aria-hidden": "true" }, [
        h("div", { class: "gate-grid" }, Array.from({ length: 9 }, () => h("span", { class: "gate-cell" }))),
        h("span", { class: "gate-lock", text: "Locked" }),
      ]),
      h("div", { class: "gate-copy" }, [
        h("h3", { text: "Where you rank on Google Maps, block by block" }),
        h("p", { text: "We check your position from nine points around your service area and map it, so you can see the streets where customers never see you. It comes with your full report, including every directory that has your business listed wrong." }),
        form,
        note,
        h("p", { class: "gate-fine" }, consentNodes(EMAIL_CONSENT)),
      ]),
    ]);
  }


  function renderDownload(report) {
    const name = report?.profile?.name || "your business";
    const button = h("button", { class: "cta cta-ghost", type: "button", text: "Download this report as a PDF" });
    button.addEventListener("click", () => {
      const previous = document.title;
      // The print dialog uses the page title as the suggested filename.
      document.title = `Lost Job Report - ${name}`;
      window.addEventListener("afterprint", () => { document.title = previous; }, { once: true });
      window.print();
    });
    return h("section", { class: "report-download" }, [
      button,
      h("p", { class: "download-note", text: "Opens your print window. Choose Save as PDF as the destination." }),
    ]);
  }


  // Everything below the headline numbers is held back until they tell us who they are and
  // prove the phone is theirs. The code is generated and checked server side; the page only
  // ever sees whether it was right.
  // Two stages living in one card. The card's own words change with the stage, because a
  // heading still saying "tell me who you are" above a code box reads like a bug.
  function renderPhoneGate(onUnlock) {
    const STAGE = {
      ask: {
        eyebrow: "The rest of your report",
        heading: "Where the jobs are going, and what fixes it",
        lead: "The full report names every gap we found, what each one is costing you, and the order I would fix them in. Tell me who you are and I will text you a code to open it.",
        fine: () => consentNodes(SMS_CONSENT),
      },
      code: {
        eyebrow: "Step 2 of 2",
        heading: "Check your phone",
        lead: "",
        // Matches CODE_MINUTES in the Phone Unlock workflow. If one moves, both move.
        fine: () => ["The code lasts five minutes."],
      },
    };

    const eyebrow = h("p", { class: "eyebrow" });
    const heading = h("h3");
    const lead = h("p", { class: "unlock-lead" });
    const note = h("p", { class: "gate-note", role: "status", "aria-live": "polite" });
    const fine = h("p", { class: "gate-fine" });
    const slot = h("div", { class: "unlock-slot" });

    let lastName = "";
    let lastPhone = "";
    let countdown = null;

    function setStage(name, leadText) {
      const stage = STAGE[name];
      eyebrow.textContent = stage.eyebrow;
      heading.textContent = stage.heading;
      lead.textContent = leadText || stage.lead;
      lead.hidden = !lead.textContent;
      fine.replaceChildren(...stage.fine());
    }

    function say(text, tone) {
      note.textContent = text || "";
      note.className = tone ? "gate-note is-" + tone : "gate-note";
    }

    // (732) 533-8997 reads like a phone number. 7325338997 reads like a serial number.
    function prettyPhone(raw) {
      const digits = String(raw || "").replace(/\D/g, "").slice(-10);
      return digits.length === 10
        ? "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6)
        : String(raw || "").trim();
    }

    async function sendCode(name, phone) {
      const res = await fetch(UNLOCK_SEND_URL(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId: window.reportSubmissionId,
          name,
          phone,
          consent: SMS_CONSENT,
          company_fax: document.getElementById("companyFax")?.value || "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "send_failed");
      return data;
    }

    // ============ stage one: who are you ============
    function askStep() {
      if (countdown) {
        clearInterval(countdown);
        countdown = null;
      }

      const nameInput = h("input", { id: "unlockName", type: "text", placeholder: "Your name", autocomplete: "name", required: "" });
      const phoneInput = h("input", { id: "unlockPhone", type: "tel", placeholder: "Your mobile number", autocomplete: "tel", required: "" });
      nameInput.value = lastName;
      phoneInput.value = lastPhone;
      const button = h("button", { class: "cta", type: "submit", text: "Text me the code" });
      const form = h("form", { class: "unlock-form", novalidate: "" }, [nameInput, phoneInput, button]);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        const digits = phoneInput.value.replace(/\D/g, "");
        if (name.length < 2) {
          say("Your name, so I know who I'm talking to.", "bad");
          nameInput.focus();
          return;
        }
        if (digits.length < 10) {
          say("A mobile number we can text the code to.", "bad");
          phoneInput.focus();
          return;
        }
        if (!UNLOCK_SEND_URL() || !window.reportSubmissionId) {
          say("We can't send a code right now. Try again in a minute.", "bad");
          return;
        }

        lastName = name;
        lastPhone = phoneInput.value;
        button.disabled = true;
        button.textContent = "Sending...";
        try {
          await sendCode(name, phoneInput.value);
          say("");
          codeStep(phoneInput.value);
        } catch (err) {
          console.warn("Unlock send failed", err);
          say(
            err.message === "too_soon"
              ? "A code is already on its way. Give it a few seconds."
              : "We couldn't text that number. Check it and try again.",
            "bad"
          );
          button.disabled = false;
          button.textContent = "Text me the code";
        }
      });

      setStage("ask");
      slot.replaceChildren(form);
    }

    // ============ stage two: the code ============
    function codeStep(phone) {
      const codeInput = h("input", {
        id: "unlockCode",
        type: "text",
        inputmode: "numeric",
        maxlength: "6",
        placeholder: "000000",
        autocomplete: "one-time-code",
        "aria-label": "The six digit code we texted you",
        required: "",
      });
      const button = h("button", { class: "cta", type: "submit", text: "Unlock my report" });
      const row = h("div", { class: "unlock-code-row" }, [codeInput, button]);
      const back = h("button", { class: "unlock-link", type: "button", text: "Wrong number?" });
      const resend = h("button", { class: "unlock-link", type: "button", text: "Send it again" });
      const links = h("p", { class: "unlock-links" }, [
        back,
        h("span", { class: "unlock-dot", "aria-hidden": "true", text: "\u00b7" }),
        resend,
      ]);
      const form = h("form", { class: "unlock-form unlock-form-code", novalidate: "" }, [row, links]);
      let checking = false;

      // The server turns down a second code inside 45 seconds, so the link waits that long
      // rather than offering something that would be refused.
      function holdResend() {
        if (countdown) clearInterval(countdown);
        let left = 45;
        resend.disabled = true;
        resend.textContent = "Send it again in " + left + "s";
        countdown = setInterval(() => {
          left -= 1;
          if (left <= 0) {
            clearInterval(countdown);
            countdown = null;
            resend.disabled = false;
            resend.textContent = "Send it again";
          } else {
            resend.textContent = "Send it again in " + left + "s";
          }
        }, 1000);
      }

      // Digits only, and six of them is the whole form, so there is nothing left to press.
      codeInput.addEventListener("input", () => {
        const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
        if (codeInput.value !== digits) codeInput.value = digits;
        if (digits.length === 6 && !checking) form.requestSubmit();
      });

      back.addEventListener("click", () => {
        say("");
        askStep();
        document.getElementById("unlockPhone")?.focus();
      });

      resend.addEventListener("click", async () => {
        resend.disabled = true;
        resend.textContent = "Sending...";
        try {
          await sendCode(lastName, lastPhone);
          say("New code sent to " + prettyPhone(lastPhone) + ".", "good");
          codeInput.value = "";
          codeInput.focus();
        } catch (err) {
          say(
            err.message === "too_soon"
              ? "A code is already on its way. Give it a few seconds."
              : "We couldn't send another code. Try again in a minute.",
            "bad"
          );
        }
        holdResend();
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (checking) return;
        const code = codeInput.value.replace(/\D/g, "");
        if (code.length !== 6) {
          say("That code is six digits.", "bad");
          codeInput.focus();
          return;
        }
        checking = true;
        button.disabled = true;
        button.textContent = "Checking...";
        say("");
        try {
          const res = await fetch(UNLOCK_VERIFY_URL(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ submissionId: window.reportSubmissionId, code }),
          });
          const data = await res.json().catch(() => ({}));
          if (data.ok && data.unlocked) {
            if (countdown) {
              clearInterval(countdown);
              countdown = null;
            }
            try {
              sessionStorage.setItem("dialbridge_unlocked", window.reportSubmissionId);
            } catch (err) {
              /* private window */
            }
            onUnlock(data.firstName || "");
            return;
          }
          const messages = {
            wrong_code: "That code doesn't match. Check the text and try again.",
            expired: "That code has expired. Send yourself a new one.",
            too_many_attempts: "Too many tries. Reply to the text and I'll send your report over myself.",
            no_code: "We don't have a code for you yet.",
          };
          say(messages[data.error] || "That didn't work. Try again.", "bad");
          codeInput.select();
        } catch (err) {
          console.warn("Verify failed", err);
          say("That didn't work. Try again.", "bad");
        }
        checking = false;
        button.disabled = false;
        button.textContent = "Unlock my report";
      });

      setStage("code", "I texted a six digit code to " + prettyPhone(phone) + ".");
      slot.replaceChildren(form);
      holdResend();
      codeInput.focus();
    }

    askStep();

    return h("section", { class: "card card-wide card-unlock" }, [eyebrow, heading, lead, slot, note, fine]);
  }


  const SAVED_KEY = "dialbridge_report";

  // A refresh should not throw them back to the search box. The finished report is kept for
  // the tab's session and drawn straight away on load. Sessions only, so it never follows
  // them to another visit, and never onto another device.
  function saveState(payload) {
    if (!payload || !payload.report) return;
    const state = {
      submissionId: window.reportSubmissionId || null,
      report: payload.report,
      summary: payload.summary || null,
      answers: window.leadAnswers || null,
      scan: {
        website: window.scanResult?.website || null,
        profile: window.scanResult?.profile ? { reviews: window.scanResult.profile.reviews || [] } : null,
      },
      savedAt: Date.now(),
    };
    try {
      sessionStorage.setItem(SAVED_KEY, JSON.stringify(state));
    } catch (err) {
      // The phone screenshot is the only big thing in here; drop it and keep the report.
      try {
        if (state.scan.website) state.scan.website = { ...state.scan.website, screenshot: "" };
        if (state.report.website) state.report.website = { ...state.report.website, screenshot: "" };
        sessionStorage.setItem(SAVED_KEY, JSON.stringify(state));
      } catch (err2) {
        console.warn("Could not keep the report for a refresh", err2);
      }
    }
  }

  function clearState() {
    try {
      sessionStorage.removeItem(SAVED_KEY);
      sessionStorage.removeItem("dialbridge_unlocked");
      sessionStorage.removeItem("dialbridge_answers");
    } catch (err) {
      /* private window */
    }
  }

  function restoreState() {
    // ?fresh=1 is the way back to the search box, for us more than for them.
    if (/[?&]fresh=1/.test(window.location.search)) {
      clearState();
      return false;
    }
    let state = null;
    try {
      state = JSON.parse(sessionStorage.getItem(SAVED_KEY) || "null");
    } catch (err) {
      state = null;
    }
    if (!state || !state.report) return false;

    window.reportSubmissionId = state.submissionId || null;
    window.leadAnswers = state.answers || null;
    window.scanResult = {
      website: state.scan?.website || null,
      profile: state.scan?.profile || null,
    };

    const hero = document.querySelector("main.hero");
    if (hero) hero.hidden = true;
    const back = document.getElementById("homeBack");
    if (back) back.hidden = false;
    const scan = $("scan");
    if (scan) scan.hidden = false;
    document.querySelector(".scan-grid")?.setAttribute("hidden", "");
    const done = $("scanDone");
    if (done) done.hidden = true;

    render({ report: state.report, summary: state.summary });
    return true;
  }

  // ============ RENDER ============

  function render(payload) {
    const { summary } = payload;
    const report = withLocalScan(payload.report);
    const body = $("reportBody");
    if (!body) return;

    // The scan was the waiting room. Once the report is here, get it out of the way.
    document.querySelector(".scan-grid")?.setAttribute("hidden", "");
    const scanDone = $("scanDone");
    if (scanDone) scanDone.hidden = true;
    const title = $("scanTitle");
    if (title) title.textContent = report?.profile?.name ? `Lost Job Report for ${report.profile.name}` : "Your Lost Job Report";

    // What anyone gets: the two scores, the money line, and which stage breaks.
    const free = [
      renderHero(summary, report),
      renderJourney(report),
    ].filter(Boolean);

    // What costs a verified phone number: every finding, the detail, and the plan.
    const gated = [
      renderFindings(summary),
      renderNumbers(report),
      renderPhoneShot(report),
      report?.ranking ? renderRanking(report) : renderMapGate(),
      renderGrades(report),
      h("div", { class: "card-grid" }, [
        renderWebsite(report),
        renderReviews(report),
        renderListings(report),
      ].filter(Boolean)),
      renderStrengths(summary),
      renderPlan(report, summary),
      renderNextStep(report),
      renderDownload(report),
    ].filter(Boolean);

    const locked = h("div", { class: "locked-wrap" }, gated);
    let alreadyUnlocked = false;
    try {
      alreadyUnlocked = sessionStorage.getItem("dialbridge_unlocked") === window.reportSubmissionId;
    } catch (err) {
      alreadyUnlocked = false;
    }
    const gateReady = Boolean(UNLOCK_SEND_URL() && UNLOCK_VERIFY_URL() && window.reportSubmissionId);

    function unlock(firstName) {
      locked.classList.remove("is-locked");
      const card = body.querySelector(".card-unlock");
      if (card) {
        card.replaceChildren(
          h("p", { class: "eyebrow", text: firstName ? `Thanks ${firstName}` : "Thanks" }),
          h("h3", { text: "Your full report is open below." })
        );
        setTimeout(() => card.remove(), 2600);
      }
    }

    if (gateReady && !alreadyUnlocked) {
      locked.classList.add("is-locked");
      body.replaceChildren(...free, renderPhoneGate(unlock), locked);
    } else {
      body.replaceChildren(...free, locked);
    }
    body.hidden = false;
    setStatus("");
    $("report").hidden = false;
    saveState(payload);
    $("scan")?.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "start" });
  }

  // ============ POLLING ============

  async function checkOnce(submissionId) {
    const url = `${STATUS_URL()}?submissionId=${encodeURIComponent(submissionId)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    return res.json();
  }

  async function start(submissionId) {
    if (polling || !submissionId || !STATUS_URL()) return;
    polling = true;

    const section = $("report");
    if (section) section.hidden = false;
    setStatus("Putting your full report together. This takes a couple of minutes.", "working");

    const deadline = Date.now() + MAX_MS;
    while (Date.now() < deadline) {
      try {
        const data = await checkOnce(submissionId);
        if (data.ready && data.report) {
          render(data);
          polling = false;
          return;
        }
        if (data.failed) {
          setStatus("We couldn't finish the deeper report for this business. Everything above is still yours.", "bad");
          polling = false;
          return;
        }
      } catch (err) {
        console.warn("Report status check failed", err);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    setStatus("Your full report is taking longer than usual. We'll send it over as soon as it's done.", "bad");
    polling = false;
  }

  function reset() {
    polling = false;
    clearState();
    const section = $("report");
    if (section) section.hidden = true;
    const body = $("reportBody");
    if (body) {
      body.replaceChildren();
      body.hidden = true;
    }
    document.querySelector(".scan-grid")?.removeAttribute("hidden");
    setStatus("");
  }

  // Called by the scan as soon as our own public-API audit is done, about a second after
  // the speed test finishes. No waiting on GHL.
  function showLocal(built) {
    if (!built || !built.report) return;
    render(built);
  }

  document.addEventListener("DOMContentLoaded", restoreState);

  window.DialBridgeReport = { start, reset, render, showLocal, clearState };
})();
