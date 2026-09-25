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
  // The status bar, drawn rather than typed. Unicode glyphs for signal and battery render
  // differently on every machine and half of them come out as boxes, which is exactly the
  // detail that makes a mockup look fake.
  function statusBarSvg() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 44 12");
    svg.setAttribute("class", "dp-icons");
    svg.setAttribute("aria-hidden", "true");
    const add = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
      return el;
    };
    // signal: four bars climbing
    [0, 1, 2, 3].forEach((i) => add("rect", {
      x: i * 4, y: 8 - i * 2, width: 2.6, height: 4 + i * 2, rx: 0.8, fill: "currentColor",
    }));
    // wifi: three arcs and a dot
    add("path", { d: "M18.2 5.1a6.6 6.6 0 0 1 7.6 0", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linecap": "round" });
    add("path", { d: "M19.9 7.3a4 4 0 0 1 4.2 0", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linecap": "round" });
    add("circle", { cx: 22, cy: 9.6, r: 1, fill: "currentColor" });
    // battery
    add("rect", { x: 30, y: 3.4, width: 11.5, height: 6.2, rx: 1.9, fill: "none", stroke: "currentColor", "stroke-width": 1 , opacity: 0.55 });
    add("rect", { x: 31.2, y: 4.6, width: 7.4, height: 3.8, rx: 1.1, fill: "currentColor" });
    add("path", { d: "M42.6 5.4v2.8", stroke: "currentColor", "stroke-width": 1.2, "stroke-linecap": "round", opacity: 0.55 });
    return svg;
  }

  // A phone that looks like a phone. The old one was a dark rounded rectangle with the
  // screenshot dropped in, which reads as a placeholder. What sells it is restraint and
  // correct proportion: concentric corner radii, a thin even bezel, side buttons that sit
  // proud of the edge by a pixel, a muted status bar and the home indicator.
  function deviceFrame(inner, { label = "" } = {}) {
    return h("div", { class: "device-phone" }, [
      h("div", { class: "dp-body" }, [
        h("span", { class: "dp-btn dp-mute", "aria-hidden": "true" }),
        h("span", { class: "dp-btn dp-vol-up", "aria-hidden": "true" }),
        h("span", { class: "dp-btn dp-vol-dn", "aria-hidden": "true" }),
        h("span", { class: "dp-btn dp-power", "aria-hidden": "true" }),
        h("div", { class: "dp-screen" }, [
          h("div", { class: "dp-status" }, [
            h("span", { class: "dp-time", text: "9:41" }),
            h("span", { class: "dp-island", "aria-hidden": "true" }),
            statusBarSvg(),
          ]),
          h("div", { class: "dp-view" }, inner),
          h("span", { class: "dp-home", "aria-hidden": "true" }),
        ]),
      ]),
      label ? h("p", { class: "dp-label", text: label }) : null,
    ].filter(Boolean));
  }

  // Their own site painting, at the speed it actually painted. A contractor who watches
  // four seconds of white screen with a clock running understands the problem in a way no
  // score out of a hundred has ever managed.
  function livePaint(w) {
    const frames = (w.filmstrip || []).filter((f) => f && f.src);
    const finalSrc = w.screenshot || (frames.length ? frames[frames.length - 1].src : "");
    if (!finalSrc) return null;

    const shot = img(finalSrc, { class: "dp-shot", alt: "Your website as it appears on a phone" });
    if (!shot) return null;

    const clock = h("span", { class: "lp-clock", text: "0.0s" });
    const bar = h("span", { class: "lp-bar-fill" });
    const replay = h("button", { class: "lp-replay", type: "button" }, [
      h("span", { "aria-hidden": "true", text: "\u21bb" }),
      " Watch it load again",
    ]);

    // Nothing to play back: one frame, or a reader who has asked for less motion.
    if (frames.length < 2 || REDUCED_MOTION) {
      return { node: deviceFrame(shot), shot, play: null, controls: null };
    }

    const last = frames[frames.length - 1].t || 1;
    // Real time, because real time is the argument. A site that genuinely takes eight
    // seconds gets eight seconds of the reader's attention, which is the point, but the
    // playback stops short of being rude about it.
    const span = Math.min(last, 8000);
    let timers = [];
    let raf = null;

    function stop() {
      timers.forEach(clearTimeout);
      timers = [];
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }

    function play() {
      stop();
      shot.src = frames[0].src;
      const started = performance.now();
      frames.forEach((f) => {
        const at = Math.min(f.t, span);
        timers.push(setTimeout(() => { shot.src = f.src; }, at));
      });
      timers.push(setTimeout(() => { shot.src = finalSrc; }, span + 120));
      const tick = () => {
        const done = Math.min(performance.now() - started, span);
        clock.textContent = `${(done / 1000).toFixed(1)}s`;
        bar.style.width = `${(done / span) * 100}%`;
        if (done < span) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    replay.addEventListener("click", play);

    const controls = h("div", { class: "lp-controls" }, [
      h("div", { class: "lp-bar" }, [bar]),
      h("div", { class: "lp-row" }, [clock, replay]),
    ]);

    return { node: deviceFrame(shot), shot, play, controls };
  }

  // The speed, as time rather than as a mark out of a hundred. "Scores 44 out of 100" is a
  // grade nobody asked for; "nothing on screen for 4.2 seconds" is a thing they have felt.
  //
  // Two bars rather than markers floating on one track. Markers meant the labels sat
  // wherever the numbers put them, and two slow times put two labels on top of each other
  // and on top of the scale underneath. Bars cannot collide.
  function loadTimeline(w) {
    const first = num(w.firstPaintMs);
    const load = num(w.loadMs);
    if (first === null && load === null) return null;

    // 2.5 seconds is Google's own line for a good largest paint, so it is the only thing
    // on here that is not our opinion.
    const GOOD = 2500;
    const worst = Math.max(first || 0, load || 0, GOOD);
    const span = Math.ceil((worst * 1.1) / 500) * 500;
    const pct = (ms) => `${Math.min(100, (ms / span) * 100)}%`;
    const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

    const row = (ms, label) => {
      if (ms === null) return null;
      const tone = ms <= GOOD ? "good" : ms <= GOOD * 2 ? "warn" : "bad";
      return h("div", { class: "ll-row" }, [
        h("span", { class: "ll-lab", text: label }),
        h("div", { class: "ll-track" }, [
          h("span", { class: `ll-fill tone-${tone}`, style: `width: ${pct(ms)}` }),
          h("span", { class: "ll-line", style: `left: ${pct(GOOD)}`, "aria-hidden": "true" }),
        ]),
        h("span", { class: `ll-val tone-${tone}`, text: secs(ms) }),
      ]);
    };

    return h("div", { class: "loadline" }, [
      row(first, "Something appears"),
      row(load, "The page is usable"),
      h("p", { class: "ll-key", text: "The dotted line is 2.5 seconds. That is where Google stops calling a page fast." }),
    ].filter(Boolean));
  }

  function renderPhoneShot(report) {
    const w = report?.website;
    if (!w || (!w.screenshot && !(w.filmstrip || []).length)) return null;
    const live = livePaint(w);
    if (!live) return null;

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

    // A dead site scored 100 for speed once, because an nginx error page loads in a
    // blink. When the site-check says broken, the speed is meaningless and the honest
    // sentence is the one about the error, with the phone showing exactly what a
    // homeowner sees.
    const timeline = w.broken ? null : loadTimeline(w);
    const brokenLead = w.reachable === false
      ? "The address on your Google listing does not load at all. The connection fails before a page appears, which is usually an expired security certificate or a site that has been taken down. A homeowner who taps it sees a browser error and moves on."
      : `The address on your Google listing returns an error${w.httpStatus ? ` (${w.httpStatus})` : ""} instead of a page. This is what a homeowner sees when they tap through. It is the same as having no website, except that Google is sending people to it.`;
    const lead = w.broken ? brokenLead : num(w.loadMs) !== null
      ? `This is your site loading on a phone, at the speed it actually loaded when we tested it. A homeowner is looking at it for ${(w.loadMs / 1000).toFixed(1)} seconds before it is any use to them.`
      : "This is the first thing a homeowner sees after they find you. Speed is only half of it. If it is hard to read or hard to tap, they leave and call the next company.";

    const section = h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: w.broken ? "Your website is not loading" : "Your website, on a phone, loading" }),
        h("span", { class: "card-hint", text: "Recorded just now" }),
      ]),
      h("div", { class: "shot-row" }, [
        h("div", { class: "shot-device" }, [live.node, w.broken ? null : live.controls].filter(Boolean)),
        h("div", { class: "shot-copy" }, [
          h("p", { class: "muted", text: lead }),
          timeline,
          w.broken
            ? h("ul", { class: "checks" }, [h("li", { class: "bad", text: w.reachable === false ? "The site does not respond" : `Returns ${w.httpStatus || "an error"} instead of a page` })])
            : checks.length ? h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))) : null,
        ].filter(Boolean)),
      ]),
    ]);

    // Play it when they actually reach it, once. Playing on render means the whole thing
    // has happened before they scroll down to it.
    if (live.play && "IntersectionObserver" in window) {
      let played = false;
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !played) {
            played = true;
            live.play();
            io.disconnect();
          }
        }
      }, { threshold: 0.4 });
      requestAnimationFrame(() => io.observe(section));
    }

    return section;
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
      // A dead site's Lighthouse score is for the error page, so it does not get a tile.
      // "100 of 100" beside "the site does not respond" was read, correctly, as nonsense.
      w.broken
        ? { value: "Down", unit: "", label: "website does not load", tone: "bad" }
        : num(w.mobileScore) !== null
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
  const tradeWord = (report) =>
    String(report?.profile?.category || "your trade").toLowerCase();
  const cityWord = (report) => {
    const parts = String(report?.profile?.address || "").split(",").map((x) => x.trim()).filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}, ${parts[1]}` : parts[0] || "";
  };

  function renderNoMap(report) {
    const sab = report?.profile?.serviceAreaOnly;
    const kw = report?.ranking?.keyword || tradeWord(report);
    const town = cityWord(report);
    const rivals = rivalsFor(report, 5);

    // This used to say "we cannot measure you" and stop, which lands on a working
    // contractor as a shrug and wastes the section. We still cannot put a grid in front of
    // them, and pretending otherwise would mean nine red pins that are not a measurement.
    // But the market around them is measurable, and showing who does come up is the same
    // argument without the false precision.
    const market = rivals.length
      ? h("div", { class: "nomap-market" }, [
          h("p", { class: "sr-head" }, [
            "Who comes up ",
            town ? `for ${kw} around ${town}` : `for ${kw} near you`,
            " right now:",
          ]),
          h("ol", { class: "sr-list" }, rivals.map((c, i) =>
            h("li", { class: "sr-row" }, [
              h("span", { class: "sr-pos", text: String(i + 1) }),
              h("span", { class: "sr-name", text: c.name }),
              h("span", { class: "sr-stars", text: c.rating ? `★ ${Number(c.rating).toFixed(1)}` : "" }),
              h("span", { class: "sr-reviews", text: c.reviewCount ? `${c.reviewCount} reviews` : "" }),
            ])
          )),
        ])
      : null;

    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: sab ? "Your listing has no address on it" : "Where you show up on Google Maps" }),
      ]),
      h("p", { class: "muted", text: sab
        ? "Yours is set up as a service-area business, which means Google shows no pin for you. We check map position by searching from 25 points and reading back who comes up, and listings without an address do not come back in those searches. So there is no grid we can honestly put in front of you. That is a limit on what we can measure, not a verdict on how you rank."
        : "We could not measure your position on the map for this business. Everything else in this report is unaffected." }),
      market,
      sab
        ? h("p", { class: "muted", text: "Those are the companies your customers are choosing between. Every one of them is winning on the same two things you can move without an address: how strong the profile is, and how many recent reviews sit behind it. That is what the rest of this report is about." })
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
    const rivals = rivalsFor(report, 3);
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
  // An empty array is truthy, so `topCompetitors || competitors` never fell through, and
  // both replicas vanished on any scan where the grid named nobody even with a full
  // competitor list sitting right there.
  function rivalsFor(report, n) {
    const grid = report?.ranking?.topCompetitors;
    const list = (Array.isArray(grid) && grid.length ? grid : report?.competitors) || [];
    return list
      .filter((c) => c && c.name)
      .slice()
      .sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0))
      .slice(0, n);
  }

  // ---- their own Google listing, rebuilt from the Places data we already hold, with the
  //      gaps marked on it.
  //
  //      The obvious version of this is to screenshot maps.google.com. That means driving a
  //      headless browser at Google, which hits consent walls and CAPTCHAs, breaks whenever
  //      they change a class name, and is against their terms. Rebuilding the panel from the
  //      API is legitimate, never breaks, uses their real photo and rating, and lets us put a
  //      marker exactly where a field is missing, which a screenshot could never do.
  function visualMyListing(report) {
    const p = report?.profile || {};
    const rv = report?.reviews || {};
    const web = report?.website || {};
    if (!p.name) return null;

    const photo = p.photo ? window.DialBridgeScan?.photoUrl?.(p.photo, 640) : "";
    const stars = (n) => {
      const r = Math.round(Number(n) || 0);
      return "\u2605".repeat(Math.max(0, Math.min(5, r))) + "\u2606".repeat(Math.max(0, 5 - r));
    };

    const row = (icon, text, ok, note) =>
      h("li", { class: `gl-row ${ok ? "is-ok" : "is-gap"}` }, [
        h("span", { class: "gl-ico", "aria-hidden": "true", text: icon }),
        h("span", { class: "gl-txt", text }),
        h("span", { class: `gl-tag ${ok ? "is-ok" : "is-gap"}`, text: ok ? "\u2713" : note || "missing" }),
      ]);

    const rating = num(rv.googleRating);
    const count = num(rv.googleReviewCount) ?? 0;
    const thinCount = count < 25;

    return h("div", { class: "play-visual mylisting" }, [
      h("div", { class: "gl-card" }, [
        photo
          ? h("div", { class: "gl-photo" }, [img(photo, { alt: `A photo from ${p.name}'s Google listing`, loading: "lazy" })])
          : h("div", { class: "gl-photo is-empty" }, [
              h("span", { class: "gl-empty-t", text: "No photos on your listing" }),
              h("span", { class: "gl-tag is-gap", text: "missing" }),
            ]),
        h("div", { class: "gl-head" }, [
          h("p", { class: "gl-name", text: p.name }),
          h("p", { class: "gl-rate" }, [
            rating !== null ? h("b", { text: rating.toFixed(1) }) : null,
            h("span", { class: "gl-stars", text: stars(rating) }),
            h("span", { class: "gl-count", text: `(${count})` }),
            thinCount ? h("span", { class: "gl-tag is-gap", text: "thin" }) : null,
          ].filter(Boolean)),
          h("p", { class: "gl-cat", text: p.category || "No category set" }),
        ]),
        h("ul", { class: "gl-rows" }, [
          row("\u25c9", p.address || "No address on the listing", Boolean(p.address), "service area"),
          row("\u25f4", p.hasHours ? "Hours are set" : "No opening hours", Boolean(p.hasHours)),
          row("\u2706", p.phone || "No phone number", Boolean(p.phone)),
          row("\u2601", web.found ? (web.url || "Website linked") : "No website on the listing", Boolean(web.found)),
          row("\u25a3", (p.photoCount || 0) >= 5 ? `${p.photoCount} photos` : `${p.photoCount || 0} photos`, (p.photoCount || 0) >= 5, "add more"),
        ]),
      ]),
      h("p", { class: "sr-cap", text: "Your listing as Google holds it today. Anything marked is a field we would fill." }),
    ]);
  }

  // ---- the answer an AI assistant gives. Every name, star rating and review count in here
  //      is real and came from Places; what is illustrated is the wrapper, and the caption
  //      says so rather than pretending we ran the prompt.
  function visualAiAnswer(report) {
    const rivals = rivalsFor(report, 3);
    if (!rivals.length) return null;
    const kw = report?.ranking?.keyword || "contractor";
    const town = String(report?.profile?.address || "").split(",").slice(0, 2).join(",").trim();
    const me = report?.profile?.name || "You";

    return h("div", { class: "play-visual airep" }, [
      h("div", { class: "ai-win" }, [
        h("div", { class: "ai-bar" }, [
          h("span", { class: "ai-dot", "aria-hidden": "true" }),
          h("span", { class: "ai-bar-t", text: "Asking an AI assistant" }),
        ]),
        h("p", { class: "ai-ask", text: town ? `Who's a good ${kw} in ${town}?` : `Who's a good ${kw} near me?` }),
        h("div", { class: "ai-say" }, [
          h("p", { class: "ai-intro", text: "Going on ratings and how often they come up locally, these are the ones worth calling:" }),
          h("ol", { class: "ai-list" }, rivals.map((c) => h("li", {}, [
            h("b", { text: c.name || "A competitor" }),
            h("span", { text: `${c.rating ? Number(c.rating).toFixed(1) + " stars" : ""}${c.reviewCount ? `, ${c.reviewCount} reviews` : ""}` }),
          ]))),
        ]),
      ]),
      h("p", { class: "ai-miss" }, [h("b", { text: me }), " is not in the answer."]),
      h("p", { class: "sr-cap", text: "Real names, ratings and counts from Google. The answer around them is an illustration of what these tools return." }),
    ]);
  }

  // ---- their review panel against the one beating them. Two numbers, the size of the gap
  //      drawn rather than described.
  function visualReviewGap(report) {
    const mine = num(report?.reviews?.googleReviewCount) ?? 0;
    const myRating = num(report?.reviews?.googleRating);
    const top = rivalsFor(report, 1)[0];
    if (!top || (top.reviewCount || 0) <= mine) return null;
    const max = top.reviewCount || 1;
    const bar = (name, count, rating, mineFlag) =>
      h("div", { class: `rg-row${mineFlag ? " is-me" : ""}` }, [
        h("span", { class: "rg-name", text: name }),
        h("div", { class: "rg-track" }, [
          h("span", { class: "rg-fill", style: `width: ${Math.max(2, (count / max) * 100)}%` }),
        ]),
        h("span", { class: "rg-n" }, [
          h("b", { text: String(count) }),
          rating ? h("span", { class: "rg-stars", text: ` \u2605 ${Number(rating).toFixed(1)}` }) : null,
        ].filter(Boolean)),
      ]);

    return h("div", { class: "play-visual reviewgap" }, [
      bar(top.name || "The shop above you", top.reviewCount || 0, top.rating, false),
      bar(report?.profile?.name || "You", mine, myRating, true),
      h("p", { class: "sr-cap", text: `Every one of those ${top.reviewCount} started as a finished job, same as yours.` }),
    ]);
  }

  // ---- the same thing twice: how it goes now, and how it goes with something watching.
  //      Drawn rather than photographed, because there is no screenshot of an event that
  //      does not happen.
  function twoTrack(nowLabel, nowSteps, nowEnd, fixLabel, fixSteps, fixEnd, cap) {
    const track = (label, tone, steps, end) =>
      h("div", { class: `qt-row tone-${tone}` }, [
        h("span", { class: "qt-label", text: label }),
        h("ol", { class: "qt-steps" }, [
          ...steps.map((t) => h("li", { class: "qt-step", text: t })),
          h("li", { class: "qt-end", text: end }),
        ]),
      ]);
    return h("div", { class: "play-visual quotetrack" }, [
      track(nowLabel, "bad", nowSteps, nowEnd),
      track(fixLabel, "good", fixSteps, fixEnd),
      cap ? h("p", { class: "qt-cap", text: cap }) : null,
    ].filter(Boolean));
  }

  function visualQuoteTrack() {
    return twoTrack(
      "How it goes now",
      ["Quote sent", "Day 3, nothing", "Day 7, you are on a job", "Day 14, forgotten"],
      "Gone quiet",
      "How it goes with it tracked",
      ["Quote sent", "Day 2, text checks in", "Day 6, text checks in", "Day 12, last check"],
      "Yes or no",
      "Same estimate, same customer. The only difference is whether anything was watching it."
    );
  }

  // ============ THE PLAN, AS A CHECKLIST ============
  //
  // Three rebuilds of this were diagnoses in different clothes. What converts is not a
  // description of what is wrong, it is a picture of what a business fully on the system
  // has, as one fixed list in the order the pieces depend on each other, with their own
  // tick or cross on every row. The list is the same for everybody; the state is theirs.
  // It reads as a to-do list, the gap is a count, and every cross is a thing we set up.
  //
  // The replicas that earned their place (their listing, the search list, the review bars,
  // the AI answer) sit under the rows they belong to, opened when the row is a cross.

  const CAPTURE_RATE = 0.25;
  const money = (x) => "$" + Number(x).toLocaleString("en-US");

  function answersNow() {
    if (window.leadAnswers && typeof window.leadAnswers === "object") return window.leadAnswers;
    try { return JSON.parse(sessionStorage.getItem("dialbridge_answers") || "{}") || {}; } catch (e) { return {}; }
  }

  // Each row: what a set-up business has, and whether this one has it. "unknown" is for
  // the rows we could not measure, and it is shown as a question mark rather than hidden,
  // because a list that only shows what we could check is a list that flatters us.
  function checklistFor(report) {
    const p = report?.profile || {};
    const w = report?.website || {};
    const rv = report?.reviews || {};
    const r = report?.ranking || {};
    const sg = report?.signals || {};
    const a = answersNow();
    const rating = num(rv.googleRating);
    const count = num(rv.googleReviewCount) ?? 0;

    const gbpDone = (p.photoCount || 0) >= 5 && Boolean(p.hasHours) && Boolean(p.phone) && Boolean(w.found);
    const siteState = !w.found ? "todo" : w.broken ? "todo" : num(w.mobileScore) === null ? "unknown" : w.mobileScore >= 50 ? "done" : "todo";
    const napState = w.callNumberMatchesGoogle === null || w.callNumberMatchesGoogle === undefined ? "unknown" : w.callNumberMatchesGoogle ? "done" : "todo";
    const gridKnown = Array.isArray(r.ranks) && r.ranks.length > 0;
    const mapsState = !gridKnown ? "unknown" : r.pointsInTop3 >= Math.ceil(r.ranks.length / 2) ? "done" : "todo";
    // Five or fewer reviews means we saw all of them; above that the honest signal is the
    // age of the ones Google shows first. Same rule as the finding.
    const reviewsMoving = count <= 5
      ? (sg.reviewVelocity90d || 0) > 0
      : (sg.newestReviewDays !== null && sg.newestReviewDays !== undefined && sg.newestReviewDays <= 90);
    const aiState = rating === null ? "unknown" : rating >= 3.4 && count >= 10 ? "done" : "todo";
    // The capture and retention rows are things a system does. Nobody has them by
    // accident, so they are a cross unless they told us it already runs on its own.
    const quotesAuto = a.quoteFollowUp === "automatic";

    return [
      { stage: "Foundation", rows: [
        { key: "gbp", label: "Google Business Profile complete", state: gbpDone ? "done" : "todo", detail: () => visualMyListing(report) },
        { key: "site", label: "Website that loads on a phone", state: siteState },
        { key: "nap", label: "Same name, phone and address everywhere", state: napState },
        { key: "yelp", label: "Yelp profile claimed and rated", state: "unknown", note: "Checked once Yelp is connected." },
      ]},
      { stage: "Visibility", rows: [
        { key: "maps", label: r.keyword ? `Top 3 on Google Maps for "${r.keyword}"` : "Top 3 on Google Maps for your trade", state: mapsState, detail: () => visualSearchList(report) },
        { key: "reviews", label: "New reviews arriving every month", state: reviewsMoving ? "done" : "todo", detail: () => visualReviewGap(report) },
        { key: "ai", label: "Named when somebody asks the AI", state: aiState, detail: () => visualAiAnswer(report) },
      ]},
      { stage: "Lead capture", rows: [
        { key: "textback", label: "Missed calls get a text back in seconds", state: "todo" },
        { key: "booking", label: "Customers book themselves into your calendar", state: "todo" },
        { key: "quotes", label: "Quotes followed up until it is a yes or a no", state: quotesAuto ? "done" : "todo" },
      ]},
      { stage: "Retention", rows: [
        { key: "ask", label: "Review request after every job, on its own", state: quotesAuto && reviewsMoving ? "done" : "todo" },
        { key: "past", label: "Past customers hear from you before they go looking", state: "todo" },
      ]},
    ];
  }

  function renderPlanSteps(report, summary) {
    const groups = checklistFor(report);
    const all = groups.flatMap((g) => g.rows);
    const done = all.filter((x) => x.state === "done").length;
    const known = all.filter((x) => x.state !== "unknown").length;
    const todo = all.filter((x) => x.state === "todo").length;

    const icon = (state) => h("span", {
      class: `ck-ico is-${state}`, "aria-hidden": "true",
      text: state === "done" ? "\u2713" : state === "todo" ? "\u2715" : "?",
    });
    const body = (x) => h("div", { class: "ck-body" }, [
      h("span", { class: "ck-label", text: x.label }),
      x.note ? h("span", { class: "ck-note", text: x.note }) : null,
    ].filter(Boolean));

    const row = (x) => {
      const panel = typeof x.detail === "function" ? x.detail() : null;
      if (!panel) return h("li", { class: `ck-row is-${x.state}` }, [icon(x.state), body(x)]);
      // A cross with evidence opens by default: that is the moment the page is for.
      const det = h("details", { class: `ck-row has-detail is-${x.state}`, ...(x.state === "todo" ? { open: "" } : {}) }, [
        h("summary", { class: "ck-sum" }, [icon(x.state), body(x), h("span", { class: "ck-chev", "aria-hidden": "true", text: "\u203a" })]),
        h("div", { class: "ck-detail" }, [panel]),
      ]);
      return h("li", {}, [det]);
    };

    return [
      h("div", { class: "ck-head" }, [
        h("p", { class: "ck-count" }, [h("b", { text: String(done) }), ` of ${known} in place`]),
        h("span", { class: "ck-bar", "aria-hidden": "true" }, [
          h("span", { class: "ck-bar-fill", style: `width: ${known ? Math.round((done / known) * 100) : 0}%` }),
        ]),
      ]),
      ...groups.map((g) => h("section", { class: "ck-stage" }, [
        h("h4", { class: "ck-stage-t", text: g.stage }),
        h("ul", { class: "ck-list" }, g.rows.map(row)),
      ])),
      renderPlanClose(report, todo),
    ];
  }

  // The close is the count. Every cross above is a thing the system runs, so the ask
  // writes itself.
  function renderPlanClose(report, todo) {
    const g = report?.growth;
    return h("div", { class: "plan-close" }, [
      h("div", { class: "plan-ask" }, [
        h("h4", { text: todo ? `We set up the other ${todo}.` : "You have the full setup." }),
        h("p", { text: g
          ? `Every cross above is something the system runs for you. One more job a week at your ticket is ${money(g.perMonth)} a month. Reply to the text we sent you and we will book an operational review.`
          : "Reply to the text we sent you and we will book an operational review." }),
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
        note.remove();
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
      // Two big things in here now, so they come out in order of size: the filmstrip is
      // ten base64 frames, the final screenshot is one. Losing the playback on a refresh
      // is a far smaller loss than losing the report.
      try {
        const strip = (w) => (w ? { ...w, filmstrip: [] } : w);
        state.scan.website = strip(state.scan.website);
        state.report.website = strip(state.report.website);
        sessionStorage.setItem(SAVED_KEY, JSON.stringify(state));
      } catch (err2) {
        try {
          const bare = (w) => (w ? { ...w, filmstrip: [], screenshot: "" } : w);
          state.scan.website = bare(state.scan.website);
          state.report.website = bare(state.report.website);
          sessionStorage.setItem(SAVED_KEY, JSON.stringify(state));
        } catch (err3) {
          console.warn("Could not keep the report for a refresh", err3);
        }
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
