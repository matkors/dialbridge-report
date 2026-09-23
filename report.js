// Full report shown on the same page, right under the scan. After the page sends the
// business to n8n, we poll the status endpoint with our submission id. n8n runs the deeper
// audit and writes the plain-English summary, and this draws it as soon as it lands.
(() => {
  "use strict";

  // The page builds its own report now. The status endpoint stays in n8n, switched off,
  // for the day we want to merge the emailed audit's listings back into the page.
  const STATUS_URL = () => window.DIALBRIDGE_CONFIG?.N8N_REPORT_STATUS_URL || "";
  // Where the Growth Blueprint request goes. Same n8n endpoint the old map email used; the
  // workflow behind it stores the address and will send the hosted PDF once it exists.
  const PLAN_URL = () => window.DIALBRIDGE_CONFIG?.N8N_REPORT_EMAIL_URL || "";
  const TERMS_URL = "https://dialbridge.ai/terms";
  const PRIVACY_URL = "https://dialbridge.ai/privacy";

  // Consent has to sit at the point of collection, next to the button that gives it, and we
  // store the exact wording somebody saw with their submission. A screenshot of today's
  // page is no use in six months when the copy has changed.
  const EMAIL_CONSENT =
    "By tapping Show me the plan you agree that DialBridge LLC may email you about your report and occasional advice for local contractors. Unsubscribe any time from the footer of any email.";

  const SMS_CONSENT =
    "By tapping Text me the code you agree that DialBridge LLC may text and call you at this number about your report and our services, including by automated means. Consent is not a condition of any purchase. Message frequency varies, and message and data rates may apply. Reply STOP to opt out or HELP for help.";

  function consentNodes(text) {
    return [
      text + " See our ",
      h("a", { href: TERMS_URL, target: "_blank", rel: "noopener", text: "Terms" }),
      " and ",
      h("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener", text: "Privacy Policy" }),
      ".",
    ];
  }

  // What goes to n8n when the code checks out. Kept in one place so there is a single
  // answer to "what do we actually know about this person".
  function leadPayload() {
    const report = lastPayload?.report;
    const summary = lastPayload?.summary;
    if (!report) return null;
    const scan = window.scanResult || {};
    return {
      // For the LLM gate: is this a contractor or home service business at all? Ad traffic
      // brings in plenty of people who are neither, and those must not go back to Meta.
      classify: {
        name: report.profile?.name || "",
        googleCategory: report.profile?.category || "",
        googlePrimaryType: scan.profile?.primaryType || "",
        detectedTrades: scan.trades || [],
        website: report.website?.url || "",
        description: scan.profile?.summary || "",
        address: report.profile?.address || "",
      },
      // The model's verdict on whether this is a contractor at all, decided during the
      // scan. n8n gates the Meta send on it.
      isHomeService: scan.isHomeService ?? null,
      keywordSource: scan.keywordSource || "",
      score: window.DialBridgeEngine?.leadScore(report) || null,
      report: {
        foundScore: report.foundScore,
        catchingScore: report.responseScore,
        subScores: report.subScores || null,
        signals: report.signals || null,
        reviewCount: report.reviews?.googleReviewCount ?? null,
        reviewRating: report.reviews?.googleRating ?? null,
        mapKeyword: report.ranking?.keyword || "",
        mapPointsInTop3: report.ranking?.pointsInTop3 ?? null,
        mapPoints: report.ranking?.ranks?.length ?? null,
        monthlyLoss: report.leak?.perMonth ?? null,
        redCount: summary?.redCount ?? null,
        goldCount: summary?.goldCount ?? null,
      },
      answers: window.leadAnswers || {},
    };
  }

  const UNLOCK_SEND_URL = () => window.DIALBRIDGE_CONFIG?.N8N_UNLOCK_SEND_URL || "";
  const UNLOCK_VERIFY_URL = () => window.DIALBRIDGE_CONFIG?.N8N_UNLOCK_VERIFY_URL || "";
  const POLL_MS = 4000;
  const MAX_MS = 12 * 60 * 1000; // audits with a slow review scan can take several minutes

  const $ = (id) => document.getElementById(id);
  const h = (...args) => window.DialBridgeScan.h(...args);
  const img = (...args) => window.DialBridgeScan.img(...args);
  const apiKey = () => window.DIALBRIDGE_CONFIG?.GOOGLE_MAPS_API_KEY || "";
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Set while the unlock dialog is up. Leaving the report has to be able to take it down,
  // otherwise "start over" lands them back on the landing page with a modal over it.
  let gateClose = null;

  // The payload the report was last drawn from. Re-measuring the map on another keyword
  // mutates it in place and has to be able to save the result for a refresh.
  let lastPayload = null;

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

  function setStatus(text, tone = "") {
    const el = $("reportStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `report-status${tone ? ` is-${tone}` : ""}`;
    el.hidden = !text;
  }

  const dollars = (n) => "$" + Number(n).toLocaleString("en-US");

  // "1 reviews" is the kind of thing that makes an owner stop trusting the rest of the page.
  const reviewWord = (n) => `${n} review${Number(n) === 1 ? "" : "s"}`;

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
    // Rendered empty with the real number parked in data-pct. animateReport fills it once
    // it is on screen; if that never runs, the failsafe there plants the final value, so
    // the page is never left showing a zero.
    return h("div", {
        class: `ring ring-${size} tone-${scoreTone(value)}`,
        style: "--pct:0",
        "data-pct": value === null ? "" : String(value),
      },
      h("span", { class: "ring-inner" }, [
        h("strong", { text: value === null ? "?" : "0" }),
        h("small", { text: caption }),
      ]));
  }

  // The Growth Blueprint is the tenth section down a long report, so most people never
  // learn it exists. This is the credited-step pattern from onboarding: the report they
  // already have arrives ticked, and the second row reads as a reward they have earned
  // rather than a step they still owe us. Deliberately quiet, and deliberately not a card:
  // it is a signpost, and a loud one here would pull people past the report into the form
  // before anything has convinced them.
  function renderNextUp() {
    return h("div", { class: "nextup", id: "nextUp" }, [
      h("div", { class: "nextup-row is-done" }, [
        h("span", { class: "nextup-mark is-tick", "aria-hidden": "true", text: "\u2713" }),
        h("span", { class: "nextup-name", text: "Lost Job Report" }),
        h("span", { class: "nextup-state", text: "Ready below" }),
      ]),
      h("a", { class: "nextup-row is-next", href: "#blueprintOffer" }, [
        h("span", { class: "nextup-mark", text: "2" }),
        h("span", { class: "nextup-name", text: "Growth Blueprint" }),
        h("span", { class: "nextup-state", text: "Yours free, at the end" }),
        h("span", { class: "nextup-go", "aria-hidden": "true", text: "\u2192" }),
      ]),
    ]);
  }

  // A second mention, placed where conviction peaks rather than only at the bottom, for
  // everyone who reads the findings and then stops scrolling.
  function renderBlueprintNudge() {
    return h("p", { class: "blueprint-nudge" }, [
      "When you have read this, ",
      h("a", { href: "#blueprintOffer", text: "your Growth Blueprint" }),
      " is waiting at the end. It is the plan for fixing what is above, in the order that pays.",
    ]);
  }

  // Motion earns its place here or it does not go in. The rings fill because the report
  // claims to have measured something. Sections lift because a long report reads better
  // arriving than dumped. Everything is off under prefers-reduced-motion, and every
  // starting state is recoverable if the JavaScript never runs.
  function animateReport(root) {
    const rings = Array.from(root.querySelectorAll(".ring[data-pct]"));
    const settle = () => {
      rings.forEach((ring) => {
        const to = Number(ring.getAttribute("data-pct"));
        if (!Number.isFinite(to)) return;
        ring.style.setProperty("--pct", String(to));
        const digits = ring.querySelector("strong");
        if (digits) digits.textContent = String(to);
      });
    };

    if (REDUCED_MOTION) {
      settle();
      return;
    }

    rings.forEach((ring) => {
      const to = Number(ring.getAttribute("data-pct"));
      if (!Number.isFinite(to)) return;
      const digits = ring.querySelector("strong");
      window.requestAnimationFrame(() => ring.style.setProperty("--pct", String(to)));
      const started = performance.now();
      const DURATION = 1100;
      const step = (now) => {
        const t = Math.min(1, (now - started) / DURATION);
        // The same ease as the CSS transition, so the arc and the digits land together.
        const eased = 1 - Math.pow(1 - t, 3);
        if (digits) digits.textContent = String(Math.round(to * eased));
        if (t < 1) window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    });

    const sections = Array.from(root.querySelectorAll(".locked-wrap > *, .report-hero, .nextup"));
    if (!("IntersectionObserver" in window)) return;
    sections.forEach((el) => el.classList.add("will-rise"));

    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          obs.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.04 }
    );
    sections.forEach((el) => observer.observe(el));

    // If anything about the observer goes wrong, nothing stays invisible.
    window.setTimeout(() => {
      sections.forEach((el) => el.classList.add("is-in"));
      settle();
    }, 2500);
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

  // Everything anybody gets for nothing: the two scores, and the one line that names which
  // of them is the problem. What those scores are made of, what it costs and what fixes it
  // all sits behind the phone check below.
  function renderHero(summary, report) {
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
          h("p", { class: "lead", text: "Two scores out of a hundred, both built from your own Google data and the four answers you gave us." }),
        ]),
      ]),
    ]);
  }

  // The money line. It used to lead with a red number over the caption "a month, on your
  // own numbers", which never actually said the number was theirs or that it was going out
  // the door, so an owner could read it and feel nothing. It says it plainly now, and the
  // arithmetic sits underneath as three labelled cells rather than a bullet list: the point
  // is the total, and the working is there to be argued with, not read first.
  function renderLeak(leak) {
    if (!leak) return null;
    const money = (n) => `$${Number(n).toLocaleString("en-US")}`;
    const percent = `${Math.round(leak.rate * 100)}%`;

    if (!leak.perMonth) return null;

    // It is a multiplication, so it reads as one. Three stacked blocks each carrying a
    // number, a label and a note of a different length came out ragged, and per the stat
    // tile contract they were three competing hero figures under the actual hero figure.
    // One line of terms, one muted line of provenance, nothing to stack.
    const term = (value, label) => h("span", { class: "leak-term" }, [
      h("b", { text: value }),
      h("span", { text: label }),
    ]);
    const times = () => h("i", { class: "leak-x", "aria-hidden": "true", text: "×" });

    return h("section", { class: "leak" }, [
      h("p", { class: "leak-lead", text: "You're losing about" }),
      h("p", { class: "leak-value" }, [
        h("strong", { text: money(leak.perMonth) }),
        h("span", { text: "a month" }),
      ]),
      h("p", { class: "leak-sub", text: "in work you already paid to get" }),
      h("div", { class: "leak-math" }, [
        h("p", { class: "leak-math-head", text: "How we got there" }),
        h("p", { class: "leak-eq" }, [
          term(String(leak.calls), "calls a month"),
          times(),
          term(money(leak.jobValue), "a job"),
          times(),
          term(percent, "slip away"),
        ]),
        // The assumption goes on the page rather than inside the code. A contractor who
        // closes two in ten, or eight in ten, can see straight away which way this moves,
        // and the whole number is checkable instead of asserted.
        leak.jobs && leak.closeRate
          ? h("p", { class: "leak-note", text: `You told us about ${leak.jobs} jobs a month. Most contractors win about ${Math.round(leak.closeRate * 10)} in 10 of the people who ask for a price, so it takes roughly ${leak.calls} calls to get there. If you close more than that, this number is smaller. If you close less, it's bigger.` })
          : null,
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

  // Reviews and the website judged as one verdict, because that is the pair a homeowner
  // compares on a single screen before they call anybody. Whichever is weaker is what we
  // name, and a good rating on a thin count is not a pass: five stars from thirteen
  // reviews is thirteen happy customers, not a reputation.
  function chosenStage(report) {
    const rv = report?.reviews || {};
    const web = report?.website || {};
    const standing = rv.standing;
    const count = num(rv.googleReviewCount) ?? 0;
    const rating = num(rv.googleRating);
    const stars = rating === null ? "No rating" : `${rating}★`;

    if (web.found === false) {
      return { ok: false, detail: "No website for your listing to send anyone to" };
    }
    if (web.notOnListing) {
      return { ok: false, detail: "You have a website, but your listing does not link to it" };
    }
    if (standing && !standing.enough) {
      return {
        ok: false,
        detail: standing.median
          ? `${reviewWord(count)}, against about ${standing.median} for the companies beside you`
          : `${reviewWord(count)} is light for what a homeowner wants to see`,
      };
    }
    if (standing && !standing.rated) {
      return { ok: false, detail: `${stars} from ${reviewWord(count)} is below what wins the call` };
    }
    if (num(web.mobileScore) !== null && web.mobileScore < 50) {
      return { ok: false, detail: `${reviewWord(count)}, but your site scores ${web.mobileScore} out of 100 on a phone` };
    }
    if (standing && standing.ok) {
      return {
        ok: true,
        detail: num(web.mobileScore) !== null
          ? `${stars} from ${reviewWord(count)}, and a site that holds up`
          : `${stars} from ${reviewWord(count)}`,
      };
    }
    return { ok: null, detail: "Your reviews and your website" };
  }

  // The whole report in one glance: the three things that decide whether a job is theirs,
  // in the order they happen, and which one is breaking. Named after the pillars in the
  // plan further down, so by the time they reach it they already know its shape.
  //
  // Getting found is measured on the map, not on the stars. A business with a 5.0 from
  // thirteen reviews used to get a green tick here for being easy to find, which is the
  // one claim its owner knows for a fact is not true.
  function renderJourney(report) {
    const rk = report?.ranking || {};
    const total = Array.isArray(rk.ranks) ? rk.ranks.length : 0;
    const response = num(report?.responseScore);

    // Lead with whichever half is true. "Top 3 at 2 of 9 spots" next to a red cross reads
    // like good news that has been marked wrong, so when it is a fail we count the misses.
    const inTop3 = rk.pointsInTop3 || 0;
    const found = total
      ? {
          ok: inTop3 >= Math.ceil(total / 2),
          detail: inTop3 >= Math.ceil(total / 2)
            ? `Top 3 at ${inTop3} of ${total} spots nearby`
            : inTop3
              ? `Top 3 at only ${inTop3} of ${total} spots nearby`
              : "Never in the top 3 anywhere nearby",
        }
      : { ok: null, detail: "We could not measure your position on the map" };

    const caught = response === null
      ? { ok: null, detail: "How you handle calls and quotes" }
      : response >= 60
        ? { ok: true, detail: "Enquiries answered fast and quotes chased" }
        : { ok: false, detail: "This is where the jobs are going" };

    const stages = [
      { label: "Get found", sub: "When they search, do you come up?", ...found },
      { label: "Get chosen", sub: "Once they see you, do they pick you?", ...chosenStage(report) },
      { label: "Catch the lead", sub: "When they reach out, do you land it?", ...caught },
    ];

    return h("section", { class: "journey" }, stages.map((stage, i) =>
      h("div", { class: `journey-step is-${stage.ok === null ? "unknown" : stage.ok ? "ok" : "broken"}` }, [
        h("span", { class: "journey-mark", "aria-hidden": "true", text: stage.ok === null ? "?" : stage.ok ? "✓" : "✕" }),
        h("div", { class: "journey-body" }, [
          h("p", { class: "journey-label", text: stage.label }),
          h("p", { class: "journey-sub", text: stage.sub }),
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
      // Stars are only good news when the count behind them stands up, so the tone comes
      // from the one verdict the whole report shares rather than the rating alone.
      num(rv.googleRating) !== null
        ? {
            value: `${rv.googleRating}`,
            unit: "stars",
            label: rv.standing && !rv.standing.enough
              ? `from only ${reviewWord(rv.googleReviewCount || 0)} on Google`
              : `from ${reviewWord(rv.googleReviewCount || 0)} on Google`,
            tone: rv.standing?.ok ? "good" : rv.standing?.rated ? "warn" : "bad",
          }
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
      h("div", { class: "card-head" }, [h("h3", { text: "The rest of your numbers" })]),
      h("ul", { class: "tiles" }, tiles.map((t) =>
        h("li", { class: `tile tone-${t.tone}` }, [
          h("p", { class: "tile-value" }, [h("strong", { text: t.value }), h("span", { text: t.unit })]),
          h("p", { class: "tile-label", text: t.label }),
        ])
      )),
    ]);
  }

  // A clean Google map with our own numbered circles over it. Google's own Static Maps
  // markers can only carry ONE character, so a rank of 14 had to come out as an unlabelled
  // pin or a fake X. Drawing the circles ourselves means every one says what it actually
  // is, and it costs the same single Static Maps request.
  function heatMap(ranking) {
    const map = window.DialBridgeEngine?.rankingMap(ranking);
    if (!map) return null;

    const base = img(map.url, {
      class: "heat-base",
      alt: `Google Maps around your address for "${map.keyword}"`,
      loading: "lazy",
    });
    if (!base) return null;

    const wrap = h("div", { class: "heat", style: `aspect-ratio: ${map.width} / ${map.height}` }, [
      base,
      // Percentages rather than pixels: the image scales with the card, so the circles have
      // to scale with it or they drift off their spots on a narrow screen.
      ...map.pins.map((pin) =>
        h("span", {
          class: `heat-pin tone-${pin.tone}${pin.isCentre ? " is-you" : ""}`,
          ...(pin.isCentre ? { "data-you": "YOUR BUSINESS" } : {}),
          style: `left: ${(50 + (pin.x / map.width) * 100).toFixed(3)}%; top: ${(50 + (pin.y / map.height) * 100).toFixed(3)}%`,
          text: pin.label,
        })
      ),
    ]);

    // If Google refuses the image there is nothing to pin anything to, so the whole block
    // goes rather than leaving circles floating on white.
    base.addEventListener("error", () => wrap.remove(), { once: true });
    return wrap;
  }

  // The one number that is true whatever the grid looks like: how many of the spots put
  // them in the three results a homeowner actually sees.
  function rankPill(r) {
    const total = (r.ranks || []).length;
    if (!total) return null;
    if (!r.pointsNotRanked && num(r.averageRank) !== null) {
      return h("span", { class: `pill tone-${rankTone(Math.round(r.averageRank))}`, text: `Average position ${r.averageRank}` });
    }
    const tone = r.pointsInTop3 >= Math.ceil(total / 2) ? "good" : r.pointsInTop3 ? "warn" : "bad";
    return h("span", { class: `pill tone-${tone}`, text: `Top 3 at ${r.pointsInTop3} of ${total}` });
  }

  // Plenty of contractors sell two or three trades, and one of them is the one they want to
  // be found for. We pick the best guess, say so out loud, and offer the others: the grid
  // is nine free searches, so measuring a second keyword costs nothing but a second.
  function keywordSwitch(report) {
    const trades = window.scanResult?.trades || [];
    const current = report?.ranking?.keyword || "";
    const others = trades.filter((t) => t && t !== current);
    if (!others.length) return null;

    const row = h("p", { class: "map-switch" }, [
      h("span", { text: `We measured "${current}". Do you do more than one trade?` }),
    ]);

    for (const trade of others) {
      const button = h("button", { class: "map-switch-btn", type: "button", text: `Check "${trade}"` });
      button.addEventListener("click", async () => {
        const profile = window.scanResult?.profile;
        if (!profile || !profile.location) return;
        const card = row.closest(".card");
        button.disabled = true;
        button.textContent = "Checking...";
        try {
          const ranking = await window.DialBridgeEngine.fetchRanking(
            profile,
            trade,
            window.scanResult?.competitors || []
          );
          if (!ranking) throw new Error("no_ranking");
          report.ranking = ranking;
          if (lastPayload?.report) lastPayload.report.ranking = ranking;
          card.replaceWith(renderRanking(report));
          if (lastPayload) saveState(lastPayload);
        } catch (err) {
          console.warn("Re-measuring the map failed", err);
          button.disabled = false;
          button.textContent = `Check "${trade}"`;
        }
      });
      row.append(button);
    }
    return row;
  }

  // When there is no map, say so and say why. It used to return null, so the section simply
  // was not there, and the only way to find out was somebody asking where the heatmap went.
  function renderNoMap(report) {
    const sab = report?.profile?.serviceAreaOnly;
    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "Where you show up on Google Maps" })]),
      h("p", { class: "muted", text: sab
        ? "Your Google listing is set up as a service-area business, so it has no pin on the map. Google will not return listings like yours in the searches we use to measure position, so there is no grid we can honestly put in front of you. That is a limit on what we can measure, not a verdict on how you rank."
        : "We could not measure your position on the map for this business. Everything else in this report is unaffected." }),
      sab
        ? h("p", { class: "muted", text: "It is worth knowing either way: a listing with no pin competes differently from one with an address, and it is one of the things worth talking through." })
        : null,
    ].filter(Boolean));
  }

  function renderRanking(report) {
    const r = report?.ranking;
    if (!r || !Array.isArray(r.ranks) || !r.ranks.length) return renderNoMap(report);
    const competitors = r.topCompetitors || [];

    // The real map or nothing. A grid of coloured boxes stands in for a map without being
    // one, and it reads like a placeholder that never got finished.
    const map = heatMap(r);
    const visual = map
      ? h("div", { class: "map-wrap" }, [
          map,
          h("ul", { class: "map-legend" }, [
            h("li", { class: "tone-good", text: "Top 3, they see you" }),
            h("li", { class: "tone-warn", text: "4 or lower, most people never scroll there" }),
            h("li", { class: "tone-bad", text: "X, you don't come up at all" }),
            h("li", { class: "is-you-key", text: "The ringed pin is your address" }),
          ]),
        ])
      : null;

    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: `When someone types "${r.keyword}", here's where you come up` }),
        // An average position that only averages the points they actually appeared at is a
        // flattering lie: two second places and seven no-shows came out as a green
        // "Average position 2" beside a finding saying they were missing at seven spots.
        // The average is only honest when they turned up everywhere.
        rankPill(r),
      ]),
      visual,
      h("p", { class: "muted", text: r.centerSource === "competitors"
        ? "We checked 25 spots around your service area. Each circle is one of them, and the number is where you came up when we searched from there. An X means you didn't come up at all."
        : "We stood in 25 spots around you and searched. Each circle is one of them, your own address is the middle one, and the number is where you came up from there. An X means you didn't come up at all." }),
      keywordSwitch(report),
      competitors.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "cmp" }, [
            h("thead", {}, h("tr", {}, [
              h("th", { text: "Beating you nearby" }),
              h("th", { text: "Rating" }),
              h("th", { text: "Reviews" }),
              num(competitors[0]?.appearances) !== null ? h("th", { text: "Spots" }) : null,
            ].filter(Boolean))),
            h("tbody", {}, competitors.map((c) =>
              h("tr", {}, [
                h("td", { text: c.name || "" }),
                h("td", { text: num(c.rating) !== null ? `${c.rating.toFixed(1)}★` : "None" }),
                h("td", { class: "mono", text: String(c.reviewCount ?? 0) }),
                // How many of the nine searches they turned up in. A rival at 9 of 9 owns
                // the whole area; one at 2 of 9 is only strong on one side of town.
                num(c.appearances) !== null
                  ? h("td", { class: "mono", text: `${c.appearances} of ${(report?.ranking?.ranks || []).length || 9}` })
                  : null,
              ].filter(Boolean))
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
      summary?.summary ? h("p", { class: "findings-intro", text: summary.summary }) : null,
      // Number, headline, explanation. The severity used to repeat itself as a coloured
      // chip beside every title, and the area label printed three times over when three
      // findings shared one. Both said less than the titles already do, so the severity is
      // now just the colour of the rule and the area label is gone.
      h("ol", { class: "findings-list" }, findings.slice(0, 4).map((f, i) => {
        // The engine now hands down a tone off the severity sort: red for critical, gold
        // for slowing them down. Nothing below 40 severity makes the list at all.
        const tone = f.tone === "red" ? "bad" : f.tone === "gold" ? "warn" : "warn";
        return h("li", { class: `finding-card tone-${tone}` }, [
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
        ? { ok: rv.unansweredCount === 0, text: rv.unansweredCount === 0 ? "Every review has a reply from you" : `${reviewWord(rv.unansweredCount)} with no reply from you` }
        : null,
      num(rv.replyRatePercent) !== null ? { ok: rv.replyRatePercent >= 80, text: `You reply to ${rv.replyRatePercent}% of reviews` } : null,
      rv.lastReviewAt ? { ok: true, text: `Your last review came in on ${rv.lastReviewAt}` } : null,
      num(rv.facebookReviewCount) !== null
        ? { ok: rv.facebookReviewCount > 0, text: rv.facebookReviewCount > 0 ? `${reviewWord(rv.facebookReviewCount)} on Facebook too` : "No reviews on Facebook" }
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

  // The bottom of the report, and the second thing we trade. They have just been shown
  // what is broken; the plan for fixing it goes out as a PDF to an email address. No
  // booking ask: they have already given a phone number and verified it, and a calendar
  // link on top of that is the point where a free report starts feeling like a funnel.
  // Naming the worst area in the sentence, not the worst finding's TITLE. The titles are
  // whole sentences ("You're not in the top 3 anywhere nearby"), so splicing one into a
  // clause produced "what to do about you're not in the top 3 anywhere nearby first".
  // For a capacity business this runs above everything else. It is the difference between
  // a report that reads as an audit and one that reads as an accusation.
  function renderWon(report, summary) {
    const won = (summary?.strengths || []).slice(0, 3);
    if (!won.length) return null;
    return h("section", { class: "card card-wide card-won" }, [
      h("p", { class: "eyebrow", text: "What you have already built" }),
      h("ul", { class: "won-list" }, won.map((line) => h("li", { text: line }))),
      h("p", { class: "won-note", text: "None of that is luck, and none of it is what is holding you back. The rest of this is about what happens after somebody finds you." }),
    ]);
  }

  const BLUEPRINT_FOCUS = {
    map_ranking: "where you show up on the map",
    reviews: "your review count",
    lead_follow_up: "the enquiries slipping through",
    website: "your website",
    google_profile: "your Google listing",
    foundation: "the groundwork",
  };

  // "a, b and c" rather than "a, b, c", because these land mid-sentence.
  function listWords(items) {
    if (items.length <= 1) return items[0] || "";
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }

  // ============ THE PLAN ============
  //
  // What used to sit here was findings.slice(0, 4) printed a second time: the same four
  // titles the report already shows under "What's costing you jobs", with the one-line fix
  // stapled on. Handing over an email bought a sentence each, and half the page was a
  // repeat of the other half.
  //
  // So the plan answers a different question than the report does. The report says what is
  // happening. The plan says what to do, and, more importantly, teaches the mechanism
  // underneath it: the thing a contractor has never been told, that makes the move obvious
  // once they know it. That is the part worth an email address, and it is the part that
  // sells, because a mechanism you understand is usually one you can also see you will
  // never run by hand for the rest of your life.
  //
  // Each play is: the move, their own number, a real picture of it, then the mechanism.
  // Which plays appear is driven by which areas their findings landed in, so two different
  // businesses get two different plans out of the same four templates.

  const ord = (n) => String(n).padStart(2, "0");

  function playHead(n, stage) {
    return h("div", { class: "play-head" }, [
      h("span", { class: "play-n", text: ord(n) }),
      h("span", { class: "play-stage", text: stage }),
    ]);
  }

  function playMech(text) {
    return h("div", { class: "play-mech" }, [
      h("span", { class: "play-mech-tag", text: "Why it works" }),
      h("p", { text }),
    ]);
  }

  // The third beat, and the one the old version was missing entirely. Problem, then the
  // mechanism, then the thing that runs it. Without this last line the plan reads as
  // homework somebody else has to do; with it, it reads as a product.
  function playUs(text) {
    return h("div", { class: "play-us" }, [
      h("span", { class: "play-us-tag", text: "What we do" }),
      h("p", { text }),
    ]);
  }

  function playProblem(text) {
    return h("p", { class: "play-you" }, [
      h("span", { class: "play-you-tag", text: "The problem" }),
      text,
    ]);
  }

  // ---- the two Google listings, side by side. Both are real listings, and the difference
  //      between them is not taste, it is which fields somebody filled in.
  function visualListings() {
    const panel = (src, tone, tag, alt, notes) =>
      h("figure", { class: "panel" }, [
        h("figcaption", { class: `panel-tag is-${tone}` }, [
          h("span", { "aria-hidden": "true", text: tone === "good" ? "\u2713" : "\u2715" }),
          tag,
        ]),
        img(src, { class: "panel-shot", alt, loading: "lazy", decoding: "async" }),
        h("ul", { class: "panel-notes" }, notes.map((t) => h("li", { class: tone, text: t }))),
      ]);

    return h("div", { class: "play-visual compare" }, [
      panel(
        "img/panel-thin.webp", "bad", "Never touched again",
        "A real Google Maps listing for a garage door company: five stars, an address, a phone number, a prompt from Google offering to add a missing website, and an empty photo strip.",
        ["No website. Google is offering to add one for them.",
         "No photos. Not one, ever.",
         "Filed as a supplier. It is a repair company.",
         "Three reviews, and closed right now."]
      ),
      panel(
        "img/panel-complete.webp", "good", "Worked on",
        "A real Google Maps listing for a plumbing company: a photo of a branded van and a uniformed technician, 4.8 stars, a Book online button, open 24 hours, and two website links.",
        ["Its own van, and a person in uniform.",
         "Open 24 hours, which is when emergencies happen.",
         "Book online, without leaving Google.",
         "4.8 stars, and the count keeps moving."]
      ),
    ]);
  }

  // ---- what the homeowner actually sees. Three abstract cards reading "#19 / X / X" meant
  //      nothing to a contractor: it is a scoreboard for a game nobody explained. The thing
  //      they understand on sight is the list itself, with the names of the companies taking
  //      their calls and their own line sitting under it.
  function visualSearchList(report) {
    const rivals = (report?.ranking?.topCompetitors || report?.competitors || []).slice(0, 3);
    if (!rivals.length) return null;
    const kw = report?.ranking?.keyword || "your trade";
    const ranks = (report?.ranking?.ranks || []).filter((r) => Number(r) > 0);
    const best = ranks.length ? Math.min(...ranks) : null;

    const row = (pos, name, rating, reviews, mine) =>
      h("li", { class: `sr-row${mine ? " is-me" : ""}` }, [
        h("span", { class: "sr-pos", text: pos }),
        h("span", { class: "sr-name", text: name }),
        h("span", { class: "sr-stars", text: rating ? `\u2605 ${Number(rating).toFixed(1)}` : "" }),
        h("span", { class: "sr-reviews", text: reviews === null || reviews === undefined ? "" : `${reviews} reviews` }),
        mine ? h("span", { class: "sr-you", text: "you" }) : null,
      ]);

    return h("div", { class: "play-visual searchlist" }, [
      h("p", { class: "sr-head" }, [
        "Someone near you types ",
        h("b", { text: kw }),
        ". This is the list Google gives them.",
      ]),
      h("ol", { class: "sr-list" }, [
        ...rivals.map((c, i) => row(String(i + 1), c.name || "A competitor", c.rating, c.reviewCount, false)),
        h("li", { class: "sr-gap", "aria-hidden": "true" }, "\u22ee"),
        row(
          best && best > 3 ? String(best) : "\u2715",
          report?.profile?.name || "You",
          report?.reviews?.googleRating,
          report?.reviews?.googleReviewCount,
          true
        ),
      ]),
      h("p", { class: "sr-cap", text: best && best > 3
        ? "Almost nobody scrolls that far. The top three take the calls."
        : "You aren't on the list at all where we checked. The top three take the calls." }),
    ]);
  }

  // ---- a real thread. The device frame is the PDF's, because the thing that makes these
  //      land is that they are screenshots of a conversation, not a diagram of one.
  function visualThread(src, alt, notes) {
    return h("div", { class: "play-visual showcase" }, [
      h("div", { class: "device" }, [img(src, { alt, loading: "lazy", decoding: "async" })]),
      h("ul", { class: "showcase-notes" }, notes.map(([lead, rest]) =>
        h("li", {}, [h("b", { text: lead }), " " + rest])
      )),
    ]);
  }

  // ---- the plays. Each returns null when it has nothing true to say.
  //
  // Shape is fixed: the problem in their own numbers, a picture of it, the mechanism
  // nobody has told them, then the thing that runs it. That last beat always names the
  // calendar and the CRM, because what separates this from an agency pitch is that it
  // plugs into the tools already running their day rather than adding another one.
  //
  // Register is operational, not promotional. The reader is somebody who was under a sink
  // an hour ago and can smell a marketing page from the first line.

  function playListing(report, n) {
    const p = report?.profile || {};
    const gaps = [];
    if (!report?.website?.found) gaps.push("no website link");
    if ((p.photoCount || 0) < 5) gaps.push(p.photoCount ? `only ${p.photoCount} photos` : "no photos");
    if (!p.hasHours) gaps.push("no opening hours");
    const yours = gaps.length
      ? `Your Google listing has ${listWords(gaps)}. Those are fields Google reads to decide who it shows.`
      : "Your listing is filled in. Now it has to stay that way, because one that stops moving slips down.";

    return h("li", { class: "play" }, [
      playHead(n, "Get found"),
      h("h4", { class: "play-move", text: "Finish the listing that feeds you work" }),
      playProblem(yours),
      visualListings(),
      playMech("Most owners treat a Google listing like a business card. Name, number, done. It is not a business card. It is the form Google reads to decide whether to show you at all, and the shop ranking above you filled theirs in. Photos, hours, the right category and a site that loads on a phone are not decoration. They are the answer sheet."),
      playUs("We rebuild the listing and keep it current: photos off your real jobs, the right category, your hours and services, and a site that loads. Then it stays maintained instead of going stale again in six months."),
    ]);
  }

  function playMap(report, n) {
    const r = report?.ranking || {};
    const total = (r.ranks || []).length;
    if (!total) return null;
    const holdsHome = Number(r.ranks?.[12]) >= 1 && Number(r.ranks?.[12]) <= 3;
    const yours = r.pointsInTop3
      ? `You come up in the top three at ${r.pointsInTop3} of the ${total} spots we checked. At the other ${total - r.pointsInTop3}, the call goes to somebody else.`
      : `We checked ${total} spots around you. You were not in the top three at a single one of them.`;

    return h("li", { class: "play" }, [
      playHead(n, "Get found"),
      h("h4", { class: "play-move", text: holdsHome
        ? "Stop relying on luck and referrals"
        : "Stop relying on luck and referrals" }),
      playProblem(yours),
      visualSearchList(report),
      playMech("Word of mouth is a good business. It is not a predictable one, because it arrives when it feels like it. Inbound is the part you can build, and there is no single place you rank: Google builds a different top three for every doorstep, and the biggest factor is how far you are from whoever is holding the phone. You cannot move your yard closer to them. You can move how strong the listing and the review count are, and that part travels where distance does not."),
      playUs("We work the listing and the reviews together, because that is the pair that actually moves map position, and you watch the grid go green from the middle out."),
    ]);
  }

  function playBooking(report, n) {
    const leak = report?.leak || {};
    const worth = leak.jobValue
      ? ` At your ticket, one of those is about $${Number(leak.jobValue).toLocaleString()} that went to whoever picked up.`
      : "";
    return h("li", { class: "play" }, [
      playHead(n, "Win the job"),
      h("h4", { class: "play-move", text: "Booking on autopilot, including the calls you miss" }),
      playProblem(`You told us calls wait when the day gets busy.${worth}`),
      visualThread("img/thread-missed-call.webp",
        "A phone screenshot of a text thread. Seconds after a missed call the company texts to say they just missed her and asks what she needs a hand with. She answers with the job, and the thread turns into a booking.",
        [["The dropped call texts back in seconds.", "Before she works down to the next number on her list."],
         ["She books herself in.", "A link to your real availability, no phone tag either way."],
         ["It lands in your calendar and CRM.", "While you are still under somebody's sink."]]),
      playMech("Nobody who calls you is sitting there waiting. They have three numbers and they are working down the list, and they stop at the first shop that answers. That is why a missed call is not something you ring back tonight. By tonight it is somebody else's job, and you never find out it happened, because the phone simply does not ring again. A shop that cannot answer while it is working has a ceiling, and the ceiling is you."),
      playUs("A dropped call gets a text back in seconds with a link to book straight into your calendar. The job writes itself into your CRM, so your schedule is current without you touching it."),
    ]);
  }

  // ---- what happens to one quote, twice. There is no screenshot for a thing that does
  //      not happen, so this is drawn: the same estimate, once the way it goes now and
  //      once the way it goes when something is tracking it.
  function visualQuoteTrack() {
    const track = (label, tone, steps, end) =>
      h("div", { class: `qt-row tone-${tone}` }, [
        h("span", { class: "qt-label", text: label }),
        h("ol", { class: "qt-steps" }, [
          ...steps.map((t) => h("li", { class: "qt-step", text: t })),
          h("li", { class: "qt-end", text: end }),
        ]),
      ]);

    return h("div", { class: "play-visual quotetrack" }, [
      track("How it goes now", "bad",
        ["Quote sent", "Day 3, nothing", "Day 7, you are on a job", "Day 14, forgotten"],
        "Gone quiet"),
      track("How it goes with it tracked", "good",
        ["Quote sent", "Day 2, text checks in", "Day 6, text checks in", "Day 12, last check"],
        "Yes or no"),
      h("p", { class: "qt-cap", text: "Same estimate, same customer. The only difference is whether anything was watching it." }),
    ]);
  }

  function playQuotes(report, n) {
    return h("li", { class: "play" }, [
      playHead(n, "Win the job"),
      h("h4", { class: "play-move", text: "Never let a quote go cold" }),
      playProblem("You told us quotes get chased when you remember. Every estimate sitting quiet is work you already paid to win."),
      visualQuoteTrack(),
      playMech("Most quotes that close need more than one touch, and the ones that get dropped are the ones a competitor is still working. Chasing them by hand takes time you do not have, so it is the first thing to go in a busy week. That is not a discipline problem, it is a capacity problem, and it gets worse exactly when the work is good."),
      playUs("The system tracks every open estimate and checks in by text until you get a yes or a no. Won jobs update in your CRM, and the dead ones stop living in your head. Old customers get the same treatment on a schedule, so the ones who used you two years ago hear from you before they search for somebody else."),
    ]);
  }

  function playReviews(report, n) {
    const mine = report?.reviews?.googleReviewCount || 0;
    const rival = report?.signals?.topRivalReviews;
    const yours = rival && rival > mine
      ? `You have ${mine}. The shop coming up above you has ${rival}. Every one of those started as a finished job, same as yours.`
      : "Your rating is fine. It is the count, and how fast it moves, that a homeowner reads before they call.";

    return h("li", { class: "play" }, [
      playHead(n, "Keep it running"),
      h("h4", { class: "play-move", text: "Hands-free reviews that drive rankings" }),
      playProblem(yours),
      visualThread("img/thread-review.webp",
        "A phone screenshot of a text thread. In the morning the company texts that Mike is twenty minutes out. That afternoon it says the job is all done and asks whether she would mind leaving Mike a quick review, with a review link underneath. She replies that she just left one.",
        [["It fires when the job closes out.", "About two hours later, in your name, from the same thread."],
         ["The link is right there to tap.", "She never has to go and find you on Google."],
         ["Every customer gets it.", "Not only the ones you remembered to ask."]]),
      playMech("It is almost never that you ask badly. It is when you ask. A link in somebody's hand while they are still happy with the work gets used. The same words on Monday get read and forgotten, because the feeling has gone. And it has to go to everybody, not the ones you remember on a good week, because volume is the only thing that moves a review count, and review count is one of the things moving you up the map."),
      playUs("The moment a job is closed out in your CRM, the system texts a review link in your name. Nothing to chase, and the count climbs in the background while you work."),
    ]);
  }

  // Which play a finding turns into. Lead follow-up splits in two, because a missed call
  // and a quote going quiet are different leaks with different fixes, and the co-founder's
  // read is right that folding them together buries both.
  const PLAY_FOR_KEY = {
    speed_to_lead: { build: playBooking, stage: 1 },
    quote_followup: { build: playQuotes, stage: 1 },
  };
  const PLAY_FOR_AREA = {
    google_profile: { build: playListing, stage: 0 },
    foundation: { build: playListing, stage: 0 },
    website: { build: playListing, stage: 0 },
    map_ranking: { build: playMap, stage: 0 },
    reviews: { build: playReviews, stage: 2 },
    lead_follow_up: { build: playBooking, stage: 1 },
  };

  function renderPlanSteps(report, summary) {
    // Every qualifying finding, not the four the report prints. Same worst-first order.
    const findings = summary?.allFindings || summary?.findings || [];
    const picked = new Map(); // build -> { build, stage, rank, findings }
    findings.forEach((f, i) => {
      const entry = PLAY_FOR_KEY[f.key] || PLAY_FOR_AREA[f.area];
      if (!entry) return;
      const got = picked.get(entry.build);
      if (got) { got.findings.push(f); return; }
      picked.set(entry.build, { ...entry, rank: i, findings: [f] });
    });

    let chosen = [...picked.values()];
    // A clean profile still gets a plan. Being fine today is not the same as staying fine.
    if (!chosen.length) {
      chosen = [
        { build: playBooking, stage: 1, rank: 0, findings: [] },
        { build: playReviews, stage: 2, rank: 1, findings: [] },
      ];
    }

    // Fixed arc, not severity order. Get found, then win the job, then keep it running.
    // Ordering stages by severity meant a business whose worst number was its review count
    // opened on reviews and closed on being invisible, which is a shuffled deck rather than
    // an argument. A product page earns its conversion from a narrative that runs the same
    // way every time. Severity still decides the order inside a stage.
    chosen.sort((a, b) => a.stage - b.stage || a.rank - b.rank);

    const plays = chosen
      .map((c, i) => c.build(report, i + 1, c.findings))
      .filter(Boolean);
    if (!plays.length) return [h("p", { class: "plan-lead", text: "Nothing on your profile is costing you work today. The plan is to keep it that way." })];

    return [
      h("ol", { class: "plays" }, plays),
      renderPlanClose(report, plays.length),
    ].filter(Boolean);
  }

  // The close. A plan nobody can picture starting is a plan nobody starts, so this is the
  // order and the rough shape of it, then the ask. The ask is deliberately a reply to a
  // text they already have rather than a calendar link: they verified that number ten
  // minutes ago, and asking them to book on top of it is where a free report starts
  // feeling like a funnel.
  function renderPlanClose(report, count) {
    const g = report?.growth;
    const money = g
      ? `Four of these a month is ${"$" + Number(g.perMonth).toLocaleString("en-US")}. That is the whole point of the order above, and none of it is a number we made up: it is your job value and your job count.`
      : "";

    const step = (when, what) =>
      h("li", { class: "seq-step" }, [
        h("span", { class: "seq-when", text: when }),
        h("span", { class: "seq-what", text: what }),
      ]);

    return h("div", { class: "plan-close" }, [
      h("p", { class: "eyebrow", text: "The order it gets built in" }),
      h("ol", { class: "seq" }, [
        step("Week one", "The listing gets finished and the leaks that cost nothing to plug get plugged. This is the part that moves first."),
        step("Weeks two to six", "Booking, quote chasing and review requests go on automatically and connect to your calendar and CRM. Nothing new to learn, and nothing that depends on you remembering."),
        step("Every week after", "The map climbs on the back of the reviews, and your old customers hear from you before they go looking. That is the part that makes next quarter predictable instead of hopeful."),
      ]),
      money ? h("p", { class: "plan-money", text: money }) : null,
      h("div", { class: "plan-ask" }, [
        h("h4", { text: "Ready to build a shop that runs without you in the middle of it?" }),
        h("p", { text: "Reply to the text we sent you and we will book an operational review. We go through what is leaking, what we would plug first, and what it takes. If it is not for you, no harm done, and this plan is yours either way." }),
      ]),
    ]);
  }

  function renderBlueprintOffer(report, summary) {
    const worst = (summary?.findings || [])[0];
    const focus = BLUEPRINT_FOCUS[worst?.area];
    const form = h("form", { class: "plan-form", novalidate: "" }, [
      h("label", { class: "plan-form-label", for: "planEmail", text: "Enter your email to unlock it" }),
      h("div", { class: "plan-form-row" }, [
        h("input", { id: "planEmail", type: "email", name: "email", placeholder: "you@yourcompany.com", autocomplete: "email", required: "" }),
        h("button", { class: "cta", type: "submit", text: "Show me the plan" }),
      ]),
    ]);
    const note = h("p", { class: "gate-note", role: "status", "aria-live": "polite" });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector("#planEmail");
      const email = input.value.trim();
      const button = form.querySelector("button");
      if (!/^[^@\s]+@[^@\s.]+\.[a-z]{2,}$/i.test(email)) {
        note.textContent = "That email doesn't look right.";
        note.className = "gate-note is-bad";
        input.focus();
        return;
      }
      if (!PLAN_URL() || !window.reportSubmissionId) {
        note.textContent = "We can't send it right now. Try again in a minute.";
        note.className = "gate-note is-bad";
        return;
      }
      button.disabled = true;
      button.textContent = "Unlocking...";
      try {
        const res = await fetch(PLAN_URL(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submissionId: window.reportSubmissionId,
            email,
            want: "growth_blueprint",
            consent: EMAIL_CONSENT,
            answers: window.leadAnswers || {},
            company_fax: document.getElementById("companyFax")?.value || "",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
        // It unlocks here rather than landing in an inbox. They are already reading, already
        // convinced enough to hand over an address, and every extra step after that is a
        // chance to lose them.
        planLock.classList.remove("is-locked");
        planLock.removeAttribute("aria-hidden");
        form.replaceChildren();
        note.textContent = "Unlocked. Your plan is below.";
        note.className = "gate-note is-good";
      } catch (err) {
        console.warn("Blueprint request failed", err);
        note.textContent = "That didn't go through. Try again.";
        note.className = "gate-note is-bad";
        button.disabled = false;
        button.textContent = "Show me the plan";
      }
    });

    const capacity = report?.track === "capacity";
    const planLock = h("div", { class: "plan-locked is-locked", "aria-hidden": "true" },
      renderPlanSteps(report, summary));

    // The number that buys the email address. Jobs, not dollars, because jobs is the unit a
    // contractor already thinks in and it is the one they cannot argue with. One a week is
    // a target rather than a forecast, and every figure under it is either theirs or
    // arithmetic they can do in their head, which is the opposite of the invented
    // percentages this page used to lead with.
    const g = report?.growth;
    const money = (n) => `$${Number(n).toLocaleString("en-US")}`;
    const headline = g
      ? h("div", { class: "prize" }, [
          h("p", { class: "prize-n", text: "One more job a week" }),
          h("p", { class: "prize-v", text: `is about ${money(g.perMonth)} a month at your ticket` }),
          g.nowJobs
            ? h("p", { class: "prize-now", text: `You do about ${g.nowJobs} a month now. Everything below is aimed at the same number.` })
            : null,
        ])
      : h("h3", { text: capacity ? "What to stop losing" : "What to fix, and in what order" });

    return h("section", { class: "card card-wide card-plan", id: "blueprintOffer" }, [
      h("p", { class: "eyebrow", text: "Your growth plan" }),
      headline,
      form,
      note,
      planLock,
      h("p", { class: "gate-fine" }, consentNodes(EMAIL_CONSENT)),
    ]);
  }

  // Everything below the headline numbers is held back until they tell us who they are and
  // prove the phone is theirs. The code is generated and checked server side; the page only
  // ever sees whether it was right.
  // Two stages living in one card. The card's own words change with the stage, because a
  // heading still saying "tell me who you are" above a code box reads like a bug.
  function renderPhoneGate(onUnlock, onLeave) {
    const STAGE = {
      // Deliberately bare. A wall of copy over a blurred report is one more thing to read
      // before the only two fields that matter, and it was pushing them off a short screen.
      ask: {
        eyebrow: "",
        heading: "Unlock Your Full Report",
        lead: "",
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
    const heading = h("h3", { id: "gateHeading" });
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
      eyebrow.hidden = !stage.eyebrow;
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
              ? "We just texted that number. Give it a few seconds."
              : err.message === "too_many"
                ? "That is as many codes as we can send for this report."
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
              ? "We just texted that number. Give it a few seconds."
              : err.message === "too_many"
                ? "That is as many codes as we can send for this report."
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
            body: JSON.stringify({
              submissionId: window.reportSubmissionId,
              code,
              // Everything n8n needs the moment this person becomes a committed lead:
              // the lead score for Meta, and the raw facts an LLM needs to decide whether
              // they are a contractor at all. Sent on verify rather than earlier because a
              // lead who never enters the code is not a lead.
              lead: leadPayload(),
            }),
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

    // There is no close button on this card. The one way out is the code, or leaving the
    // report altogether, which is what the link below does: it is not a way to read the
    // report without verifying, it drops them back to the search box with nothing.
    const leave = onLeave
      ? h("button", { class: "unlock-link unlock-leave", type: "button", text: "Not now, take me back" })
      : null;
    if (leave) leave.addEventListener("click", onLeave);

    return h("section", { class: "card card-wide card-unlock" },
      [eyebrow, heading, lead, slot, note, fine, leave].filter(Boolean));
  }

  // The gate used to be a card in the flow with a blurred stack under it, which meant a
  // long scroll of blurred cards and a form somewhere in the middle of it. It is a dialog
  // now: the report behind it is blurred, inert and hidden from screen readers, and focus
  // cannot leave the card, so the only thing on screen is the thing we are asking for.
  function openGate(onUnlock, onLeave) {
    const overlay = h("div", {
      class: "gate-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "gateHeading",
    }, renderPhoneGate(onUnlock, onLeave));

    // Tab must not walk into the blurred report behind, or a screen reader happily reads
    // out the whole thing the gate is there to hold back.
    function keepFocus(event) {
      if (!overlay.contains(event.target)) {
        const first = overlay.querySelector("input, button");
        if (first) first.focus();
      }
    }

    document.body.append(overlay);
    document.body.classList.add("is-locked");
    document.addEventListener("focusin", keepFocus);
    overlay.querySelector("input")?.focus();

    return function closeGate() {
      document.removeEventListener("focusin", keepFocus);
      document.body.classList.remove("is-locked");
      overlay.remove();
    };
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
        isHomeService: window.scanResult?.isHomeService ?? null,
        keywordSource: window.scanResult?.keywordSource || "",
        // Enough of the profile to re-run the ranking grid after a refresh: the place id it
        // looks for and the pin it searches around. The reviews ride along for the report.
        profile: window.scanResult?.profile
          ? {
              id: window.scanResult.profile.id || "",
              name: window.scanResult.profile.name || "",
              location: window.scanResult.profile.location || null,
              reviews: window.scanResult.profile.reviews || [],
            }
          : null,
        competitors: window.scanResult?.competitors || [],
        trades: window.scanResult?.trades || [],
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
      competitors: state.scan?.competitors || [],
      trades: state.scan?.trades || [],
      isHomeService: state.scan?.isHomeService ?? null,
      keywordSource: state.scan?.keywordSource || "",
    };

    const hero = document.querySelector("main.hero");
    if (hero) hero.hidden = true;
    const how = $("how");
    if (how) how.hidden = true;
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

    // Free, and all of it: the two scores and the line naming which one is the problem.
    const free = [renderHero(summary, report), renderNextUp()].filter(Boolean);

    // Everything that explains them. Blurred, inert and hidden from screen readers until
    // the phone is verified. The money line leads, because it is the answer to the
    // question the two scores just raised.
    // A capacity business reads about the leak and the response first, because that is
    // their story, and the map comes later as evidence they already won. A presence
    // business gets the map up front, because that is theirs.
    const capacityTrack = report?.track === "capacity";
    const gated = capacityTrack ? [
      renderWon(report, summary),
      renderLeak(report?.leak),
      renderJourney(report),
      renderFindings(summary),
      renderBlueprintNudge(),
      renderPhoneShot(report),
      renderRanking(report),
      renderNumbers(report),
      renderGrades(report),
      h("div", { class: "card-grid" }, [
        renderReviews(report),
        renderWebsite(report),
        renderListings(report),
      ].filter(Boolean)),
      renderBlueprintOffer(report, summary),
    ].filter(Boolean) : [
      renderLeak(report?.leak),
      renderJourney(report),
      renderFindings(summary),
      renderBlueprintNudge(),
      renderRanking(report),
      renderNumbers(report),
      renderPhoneShot(report),
      renderGrades(report),
      h("div", { class: "card-grid" }, [
        renderWebsite(report),
        renderReviews(report),
        renderListings(report),
      ].filter(Boolean)),
      renderStrengths(summary),
      renderBlueprintOffer(report, summary),
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
      if (gateClose) gateClose();
      gateClose = null;
      locked.classList.remove("is-locked");
      locked.removeAttribute("aria-hidden");
      // The strip lighting up is the acknowledgement. A congratulations line that fades out
      // five seconds later is noise on top of the thing they actually came for.
      const strip = document.getElementById("nextUp");
      strip?.classList.add("is-ready");
    }

    if (gateReady && !alreadyUnlocked) {
      locked.classList.add("is-locked");
      locked.setAttribute("aria-hidden", "true");
    }
    body.replaceChildren(...free, locked);
    body.hidden = false;
    animateReport(body);
    setStatus("");
    $("report").hidden = false;
    lastPayload = payload;
    saveState(payload);
    $("scan")?.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "start" });

    if (gateClose) {
      gateClose();
      gateClose = null;
    }
    if (gateReady && !alreadyUnlocked) {
      gateClose = openGate(unlock, () => window.DialBridgeScan?.reset());
    }
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
    if (gateClose) {
      gateClose();
      gateClose = null;
    }
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
