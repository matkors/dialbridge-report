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
  // "74-30 87th Ave, Woodhaven, NY 11421, USA" -> "Woodhaven, NY". The first version took
  // the first two parts, which is the street for any business with a full address, and
  // printed "Plumber in 74-30 87th Ave".
  const cityWord = (report) => {
    const parts = String(report?.profile?.address || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length && /^(USA|United States)$/i.test(parts[parts.length - 1])) parts.pop();
    const st = parts.length ? parts[parts.length - 1].match(/^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/) : null;
    if (st) {
      parts.pop();
      const city = parts.length ? parts[parts.length - 1] : "";
      return city ? `${city}, ${st[1]}` : st[1];
    }
    return parts.length >= 2 ? `${parts[parts.length - 2]}, ${parts[parts.length - 1]}` : parts[0] || "";
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
  function visualMyListing(report, { after = false } = {}) {
    const p = report?.profile || {};
    const rv = report?.reviews || {};
    const web = report?.website || {};
    if (!p.name) return null;
    // "after" draws the same card as we would hand it back: every field filled, the photo
    // slot holding their real jobs, and the thin-count tag gone. Their name, their number,
    // the finished version. Nothing invented about them, only about the state.
    const ok = (v) => after ? true : Boolean(v);

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

    return h("div", { class: `play-visual mylisting${after ? " is-after" : ""}` }, [
      h("div", { class: "gl-card" }, [
        photo
          ? h("div", { class: "gl-photo" }, [img(photo, { alt: `A photo from ${p.name}'s Google listing`, loading: "lazy" })])
          : after
            ? h("div", { class: "gl-photo is-after" }, [
                h("span", { class: "gl-after-t", text: "Your real job photos" }),
                h("span", { class: "gl-tag is-ok", text: "\u2713 added monthly" }),
              ])
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
            thinCount && !after ? h("span", { class: "gl-tag is-gap", text: "thin" }) : null,
          ].filter(Boolean)),
          h("p", { class: "gl-cat", text: p.category || "No category set" }),
        ]),
        h("ul", { class: "gl-rows" }, [
          row("\u25c9", p.address || (after ? "Service area set" : "No address on the listing"), ok(p.address), "service area"),
          row("\u25f4", ok(p.hasHours) ? "Hours are set" : "No opening hours", ok(p.hasHours)),
          row("\u2706", p.phone || "No phone number", ok(p.phone)),
          row("\u2601", ok(web.found) ? (web.url || "Website linked") : "No website on the listing", ok(web.found)),
          row("\u25a3", after ? "Photos from your jobs, kept current" : `${p.photoCount || 0} photos`, ok((p.photoCount || 0) >= 5), "add more"),
        ]),
      ]),
      after ? null : h("p", { class: "sr-cap", text: "Your listing as Google holds it today. Anything marked is a field we would fill." }),
    ].filter(Boolean));
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

  // The pre-scan answers, from memory or from the session if the page was refreshed.
  function answersNow() {
    if (window.leadAnswers && typeof window.leadAnswers === "object") return window.leadAnswers;
    try { return JSON.parse(sessionStorage.getItem("dialbridge_answers") || "{}") || {}; } catch (e) { return {}; }
  }

  // ============ THE PLAN, AS THE PRODUCT ============
  //
  // Four versions of this led with the lead: their gaps, their crosses, their state on a
  // list. Every one of them was the report again in different clothes, and the lead has
  // already read the report. This one leads with the product. Six pieces of the system,
  // each drawn as it looks running for THIS business: their name on the listing, their
  // number in the text, their trade on the site. Their own numbers appear once per piece,
  // small, at the bottom, as the reason. The picture is the product, not the problem.

  const money = (x) => "$" + Number(x).toLocaleString("en-US");
  const fmt = (x) => Number(x).toLocaleString("en-US");
  const initials = (name) => String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  // "A-General Sewer & Plumbing Services" was coming out as "A-General Sewer &". Words
  // are taken until the name is short enough, then any dangling joiner is trimmed off.
  const shortName = (name) => {
    const n = String(name || "").replace(/\b(LLC|Inc\.?|Corp\.?|Co\.?)\b\.?/gi, "").replace(/[,\s]+$/, "").trim();
    if (!n) return "your business";
    if (n.length <= 24) return n;
    const out = [];
    for (const w of n.split(/\s+/)) {
      if ((out.join(" ") + " " + w).trim().length > 22 && out.length >= 2) break;
      out.push(w);
    }
    while (out.length > 1 && /^(&|and|of|the|-)$/i.test(out[out.length - 1])) out.pop();
    return out.join(" ");
  };

  // ---- a text thread on the customer's phone. The business is the contact, so its name
  //      sits at the top and its messages come in grey on the left, the way they would.
  function smsThread(report, messages) {
    const name = shortName(report?.profile?.name);
    const inner = h("div", { class: "sms-wrap" }, [
      h("div", { class: "sms-head" }, [
        h("span", { class: "sms-avatar", text: initials(name) }),
        h("span", { class: "sms-name", text: name }),
      ]),
      h("div", { class: "sms-body" }, messages.map((m) =>
        h("div", { class: `sms sms-${m.from}` }, [
          m.stamp ? h("span", { class: "sms-stamp", text: m.stamp }) : null,
          h("p", { class: "sms-b", text: m.text }),
          m.note ? h("span", { class: "sms-note", text: m.note }) : null,
        ].filter(Boolean))
      )),
    ]);
    return deviceFrame(inner);
  }

  // ---- A. their listing now, and their listing done. Same card twice.
  function visualGbpBeforeAfter(report) {
    const before = visualMyListing(report);
    const after = visualMyListing(report, { after: true });
    if (!before || !after) return null;
    return h("div", { class: "play-visual gba" }, [
      h("div", { class: "gba-col" }, [h("span", { class: "gba-tag is-now", text: "Now" }), before]),
      h("div", { class: "gba-col" }, [h("span", { class: "gba-tag is-done", text: "Done" }), after]),
    ]);
  }

  // ---- B. the site we build, on a phone, with their name on it.
  function visualSiteMock(report) {
    const name = shortName(report?.profile?.name);
    const trade = report?.ranking?.keyword || tradeWord(report);
    const town = cityWord(report);
    const phone = report?.profile?.phone || "";
    const cap = (t) => t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    const inner = h("div", { class: "site-wrap" }, [
      h("div", { class: "site-bar" }, [h("span", { class: "site-logo", text: name }), h("span", { class: "site-call", text: "Call" })]),
      h("div", { class: "site-hero" }, [
        h("p", { class: "site-kicker", text: town ? `${cap(trade)} in ${town.split(",")[0]}` : cap(trade) }),
        h("p", { class: "site-h1", text: "Same-day service. Upfront pricing." }),
        h("div", { class: "site-ctas" }, [
          h("span", { class: "site-btn is-primary", text: phone ? `Call ${phone}` : "Call now" }),
          h("span", { class: "site-btn", text: "Book online" }),
        ]),
      ]),
      h("ul", { class: "site-list" }, ["Emergency repairs", "Installations", "Maintenance plans"].map((t) => h("li", { text: t }))),
      h("div", { class: "site-proof" }, [
        h("span", { class: "site-stars", text: "\u2605\u2605\u2605\u2605\u2605" }),
        h("span", { text: "Licensed and insured" }),
      ]),
    ]);
    return h("div", { class: "play-visual sitemock" }, [deviceFrame(inner)]);
  }

  // ---- C. the review system, drawn as the three things that happen.
  function visualReviewFlow(report) {
    const name = shortName(report?.profile?.name);
    const step = (n, title, node) => h("div", { class: "rf-step" }, [
      h("span", { class: "rf-n", text: String(n) }),
      h("p", { class: "rf-t", text: title }),
      node,
    ]);
    const done = h("div", { class: "rf-card rf-job" }, [
      h("span", { class: "rf-job-ico", text: "\u2713" }),
      h("span", { class: "rf-job-t", text: "Job closed out" }),
      h("span", { class: "rf-job-s", text: "Tuesday, 4:06 PM" }),
    ]);
    const text = h("div", { class: "rf-card rf-sms" }, [
      h("span", { class: "rf-from", text: name }),
      h("p", { class: "rf-b", text: "Thanks for having us out! Mind leaving us a quick review?" }),
      h("span", { class: "rf-link", text: "g.page/r/review" }),
      h("span", { class: "rf-when", text: "Two hours after the job" }),
    ]);
    const review = h("div", { class: "rf-card rf-rev" }, [
      h("div", { class: "rf-rev-head" }, [
        h("span", { class: "rf-rev-av", text: "S" }),
        h("span", { class: "rf-rev-who" }, [h("b", { text: "Sarah K." }), h("span", { text: "Local Guide" })]),
      ]),
      h("span", { class: "rf-rev-stars", text: "\u2605\u2605\u2605\u2605\u2605" }),
      h("p", { class: "rf-rev-b", text: "Showed up on time, fixed it fast. Would call again." }),
      h("span", { class: "rf-rev-on", text: `on ${name}'s Google listing` }),
    ]);
    return h("div", { class: "play-visual reviewflow" }, [
      step(1, "Job marked done", done),
      h("span", { class: "rf-arrow", "aria-hidden": "true", text: "\u2192" }),
      step(2, "The ask goes out", text),
      h("span", { class: "rf-arrow", "aria-hidden": "true", text: "\u2192" }),
      step(3, "The review lands", review),
    ]);
  }

  // ---- D. the missed call, from her side of it.
  function visualTextBack(report) {
    const name = shortName(report?.profile?.name);
    return h("div", { class: "play-visual textback" }, [smsThread(report, [
      { from: "sys", stamp: "Missed call \u00b7 2:14 PM", text: "" },
      { from: "biz", text: `Hi, it's ${name}. Sorry we missed you, we're on a job right now. What do you need a hand with?`, note: "8 seconds later" },
      { from: "me", text: "Kitchen sink is backing up and won't drain. Can someone come out today?" },
      { from: "biz", text: "Yes. I can fit you in this afternoon between 2 and 4. Tap to book: book.dialbridge.ai/slot" },
      { from: "me", text: "Booked. Thank you!" },
      { from: "biz", text: "You're set for 2 to 4, Mark. I'll text when I'm on the way." },
    ])]);
  }

  // ---- F. the answer we are working toward: the same question, their name in it. The
  //      rivals are the real ones from Places; the caption says plainly this is the goal,
  //      the same way the listing card above says "Done".
  function visualAiGoal(report) {
    const rivals = rivalsFor(report, 2);
    const me = report?.profile?.name;
    if (!me) return null;
    const kw = report?.ranking?.keyword || tradeWord(report);
    const town = cityWord(report);
    const entry = (name, sub, mine) => h("li", { class: mine ? "is-me" : "" }, [
      h("b", { text: name }),
      mine ? h("span", { class: "ai-you", text: "you" }) : null,
      h("span", { text: sub }),
    ].filter(Boolean));
    return h("div", { class: "play-visual airep is-goal" }, [
      h("div", { class: "ai-win" }, [
        h("div", { class: "ai-bar" }, [h("span", { class: "ai-dot", "aria-hidden": "true" }), h("span", { class: "ai-bar-t", text: "Asking an AI assistant" })]),
        h("p", { class: "ai-ask", text: town ? `Who's a good ${kw} in ${town.split(",")[0]}?` : `Who's a good ${kw} near me?` }),
        h("div", { class: "ai-say" }, [
          h("p", { class: "ai-intro", text: "These come up most, with strong recent reviews:" }),
          h("ol", { class: "ai-list" }, [
            entry(me, "Highly rated, answers fast, books online", true),
            ...rivals.map((c) => entry(c.name, `${c.rating ? Number(c.rating).toFixed(1) + " stars" : ""}${c.reviewCount ? `, ${c.reviewCount} reviews` : ""}`, false)),
          ]),
        ]),
      ]),
      h("p", { class: "sr-cap", text: "The goal. Today your name is not in this answer." }),
    ]);
  }

  // ---- F (retired). What the AI reads, as tiles. Not rendered.
  function visualAiIngredients(report) {
    const rating = num(report?.reviews?.googleRating);
    const count = num(report?.reviews?.googleReviewCount) ?? 0;
    const nap = report?.website?.callNumberMatchesGoogle;
    const tile = (label, value, target, state) => h("div", { class: `aii-tile is-${state}` }, [
      h("span", { class: "aii-l", text: label }),
      h("span", { class: "aii-v", text: value }),
      h("span", { class: "aii-t", text: target }),
    ]);
    return h("div", { class: "play-visual aiing" }, [
      tile("Your rating", rating !== null ? rating.toFixed(1) : "\u2014", "Recommended shops average 4.3", rating === null ? "unknown" : rating >= 4.3 ? "ok" : rating >= 3.4 ? "warn" : "gap"),
      tile("Your review count", fmt(count), "Enough recent ones to be trusted", count >= 25 ? "ok" : count >= 10 ? "warn" : "gap"),
      tile("Your details", nap === false ? "Don't match" : nap === true ? "Match" : "Unchecked", "Same on Google, Yelp, Facebook and your site", nap === false ? "gap" : nap === true ? "ok" : "unknown"),
    ]);
  }

  // ---- the six pieces. Always all six, in the order they depend on each other.
  function tourFor(report) {
    const p = report?.profile || {};
    const w = report?.website || {};
    const rv = report?.reviews || {};
    const sg = report?.signals || {};
    const leak = report?.leak || {};
    const a = answersNow();
    const rating = num(rv.googleRating);
    const count = num(rv.googleReviewCount) ?? 0;
    const rival = num(sg.topRivalReviews);
    const kw = report?.ranking?.keyword || tradeWord(report);

    const gaps = [];
    if ((p.photoCount || 0) < 5) gaps.push("photos");
    if (!p.hasHours) gaps.push("opening hours");
    if (!w.found) gaps.push("a website link");

    const siteNow = !w.found ? "Right now you don't have one on your listing."
      : w.broken ? "Right now yours doesn't load."
      : num(w.loadMs) !== null ? `Right now yours takes ${(w.loadMs / 1000).toFixed(1)} seconds to load on a phone.`
      : null;

    return [
      {
        name: "DialBridge Google Business Profile",
        tag: "Your listing, finished and kept that way.",
        includes: ["Real photos from your jobs, added monthly", "Category, hours and services set right", "Same name, phone and address on Google, Yelp and Facebook"],
        now: gaps.length ? `Right now yours is missing ${listWords(gaps)}.` : "Right now yours is complete. We keep it that way.",
        visual: visualGbpBeforeAfter(report),
      },
      {
        name: "DialBridge Website",
        tag: "A site that loads in a second and books the job.",
        includes: ["Built for a phone, where your customers are", "Tap to call and book online on every screen", "Your number, hours and reviews, always current"],
        now: siteNow,
        visual: visualSiteMock(report),
      },
      {
        name: "DialBridge Review Automation",
        tag: "Every finished job asks for a review. You do nothing.",
        includes: ["The text goes out two hours after the job closes", "In your name, with the link right there to tap", "Bad ones come to you first, not to Google"],
        now: rival && rival > count ? `Right now you have ${fmt(count)}. The shop above you has ${fmt(rival)}.` : `Right now you have ${fmt(count)}.`,
        visual: visualReviewFlow(report),
      },
      {
        name: "DialBridge Missed-Call Text Back",
        tag: "A missed call gets a text in seconds, and she books herself in.",
        includes: ["Answers while you're under a sink", "She picks a slot from your real calendar", "Lands in your CRM, no phone tag"],
        now: leak.jobValue ? `You told us calls wait when you're busy. Each one is about ${money(leak.jobValue)}.` : "You told us calls wait when you're busy.",
        visual: visualTextBack(report),
      },
      {
        name: "DialBridge Quote Follow-Up",
        tag: "Open estimates get chased until it's a yes or a no.",
        includes: ["Every quote tracked, no list to keep", "Texts check in on a schedule", "Past customers get the same, every season"],
        now: a.quoteFollowUp === "automatic" ? "You told us this already runs on its own." : "You told us quotes get chased when you remember.",
        visual: visualQuoteTrack(),
      },
      {
        name: "DialBridge AEO",
        tag: `Get named when somebody asks ChatGPT for a ${kw}.`,
        includes: ["Rating and review count over the line the AI uses", "Your details identical everywhere it looks", "Fresh content monthly, which is what gets cited"],
        now: rating !== null ? `Recommended shops average 4.3 stars. You're at ${rating.toFixed(1)}.` : "Recommended shops average 4.3 stars.",
        visual: visualAiGoal(report),
      },
    ];
  }

  // ============ THE PLAN, AS ONE PICTURE ============
  //
  // Five rebuilds of this tried to explain the system piece by piece, and every one was
  // too much to take in. This is the thing that was asked for at the very start: one
  // picture of the whole system as a flow, from somebody searching to the review landing,
  // with the DialBridge piece that runs each stage labelled on it, and the loop that
  // makes it compound. Then a plain list of what is included, and the ask.
  //
  // It is the same for everybody apart from their keyword and their name. The report
  // above already did the diagnosis; this part only has to show the machine.

  function pipeIcon(kind) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "pp-icon");
    svg.setAttribute("aria-hidden", "true");
    const add = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      el.setAttribute("fill", attrs.fill || "none");
      el.setAttribute("stroke", "currentColor");
      el.setAttribute("stroke-width", "1.8");
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
      svg.appendChild(el);
    };
    if (kind === "search") { add("circle", { cx: 11, cy: 11, r: 6.5 }); add("path", { d: "M16 16l4.5 4.5" }); }
    if (kind === "pin") { add("path", { d: "M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 1 1 13 0C18.5 15.4 12 21 12 21z" }); add("circle", { cx: 12, cy: 10.5, r: 2.3 }); }
    if (kind === "chat") { add("path", { d: "M4.5 5.5h15v10.5H10l-5.5 4v-4h0z" }); add("path", { d: "M8.5 10.5h7" }); }
    if (kind === "calendar") { add("rect", { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }); add("path", { d: "M3.5 10h17M8 3v4M16 3v4M9 14.5l2 2 4-4" }); }
    if (kind === "star") { add("path", { d: "M12 3.5l2.6 5.4 5.9.7-4.3 4.1 1.1 5.8L12 16.7l-5.3 2.8 1.1-5.8-4.3-4.1 5.9-.7z" }); }
    return svg;
  }

  // The icon-card version read as a template: the same rounded box, pastel icon square
  // and pill tags five times over is what every generated landing page looks like. What
  // actually lands is a real-looking piece of product, so both parts are drawn as the
  // screens themselves: their details on four listings, then five snippets of the system
  // running, one after another on a single track.

  const star5 = "\u2605\u2605\u2605\u2605\u2605";
  // Stars that match the number beside them. Five gold stars next to a 3.0 is a lie a
  // contractor spots instantly, because it is his own rating.
  const starsFor = (r) => {
    const n = r === null || r === undefined ? 5 : Math.max(0, Math.min(5, Math.round(Number(r))));
    return h("span", { class: "rs-stars" }, [
      "\u2605".repeat(n),
      n < 5 ? h("span", { class: "rs-stars-off", text: "\u2605".repeat(5 - n) }) : null,
    ].filter(Boolean));
  };

  // ---- part two: five snippets on a track
  // ============ THE GROWTH PLAN, IN TWO PARTS ============
  //
  // Part one: get the foundations in place (website, Google profile, Yelp and Facebook).
  // Part two: the system top contractors run on top of them, one step at a time. Every
  // section is a short explanation beside a large, real-looking picture of the thing
  // itself, with their name, number, trade and town in it. Their own measured state
  // appears once per section under "Right now", so the plan stays theirs without turning
  // back into the report.

  const TRADE_SERVICES = [
    ["junk", ["Furniture removal", "Full cleanouts", "Appliance haul-away"]],
    ["roof", ["Roof repair", "Roof replacement", "Gutters"]],
    ["plumb", ["Drain cleaning", "Water heaters", "Leak repair"]],
    ["sewer", ["Sewer lines", "Drain cleaning", "Camera inspection"]],
    ["hvac", ["AC repair", "Furnace repair", "New systems"]],
    ["heat", ["Heating repair", "AC repair", "New systems"]],
    ["electric", ["Panel upgrades", "Lighting", "Repairs"]],
    ["paint", ["Interior painting", "Exterior painting", "Cabinets"]],
    ["floor", ["Hardwood", "Tile", "Refinishing"]],
    ["landscap", ["Lawn care", "Hardscaping", "Cleanups"]],
    ["garage", ["Door repair", "New doors", "Openers"]],
  ];
  function servicesFor(kw) {
    const k = String(kw || "").toLowerCase();
    const hit = TRADE_SERVICES.find(([key]) => k.includes(key));
    return hit ? hit[1] : ["Repairs", "Installations", "Maintenance"];
  }
  const capFirst = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  const townOf = (report) => (cityWord(report) || "").split(",")[0].trim();

  // One section: explanation on one side, the picture on the other. They alternate.
  function planBlock({ kicker, title, body, bullets, numbered, now, art }) {
    return h("li", { class: "pb" }, [
      h("div", { class: "pb-copy" }, [
        h("p", { class: "pb-kick", text: kicker }),
        h("h4", { class: "pb-title", text: title }),
        h("p", { class: "pb-body", text: body }),
        h(numbered ? "ol" : "ul", { class: `pb-list${numbered ? " is-num" : ""}` }, bullets.map(([lead, rest]) =>
          h("li", {}, [h("b", { text: lead }), h("span", { text: rest })])
        )),
        now ? h("div", { class: "pb-now" }, [h("span", { class: "pb-now-t", text: "Right now" }), h("p", { text: now })]) : null,
      ].filter(Boolean)),
      h("div", { class: "pb-art" }, [art]),
    ]);
  }

  // ---------------------------------------------------------------- foundation art

  // Their site as we would build it, in a browser window: every page a contractor site
  // needs is in the nav, and the home page does its job in the first screen.
  function artWebsite(report) {
    const p = report?.profile || {};
    const short = shortName(p.name);
    const kw = report?.ranking?.keyword || tradeWord(report) || "contractor";
    const town = townOf(report);
    const phone = p.phone || "(555) 123-4567";
    const rating = num(report?.reviews?.googleRating);
    const svc = servicesFor(kw);
    const url = domainOf(report?.website?.url) || `${short.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com`;

    return h("div", { class: "bw" }, [
      h("div", { class: "bw-top" }, [
        h("span", { class: "bw-dots", "aria-hidden": "true" }, [h("i"), h("i"), h("i")]),
        h("span", { class: "bw-url", text: url }),
      ]),
      h("div", { class: "bw-page" }, [
        h("div", { class: "bw-nav" }, [
          h("span", { class: "bw-logo", text: short }),
          h("span", { class: "bw-links" }, ["Services", "Areas", "About", "Reviews"].map((t) => h("span", { text: t }))),
          h("span", { class: "bw-call", text: phone }),
          h("span", { class: "bw-tag t2", text: "Call button up top" }),
        ]),
        h("div", { class: "bw-hero" }, [
          h("p", { class: "bw-kick", text: town ? `${capFirst(kw)} in ${town}` : capFirst(kw) }),
          h("p", { class: "bw-h1", text: "Same-day service. Upfront pricing. Done right." }),
          h("div", { class: "bw-ctas" }, [h("span", { class: "is-primary", text: `Call ${phone}` }), h("span", { text: "Book online" })]),
          h("p", { class: "bw-trust" }, [
            h("span", { class: "rs-stars", text: "\u2605\u2605\u2605\u2605\u2605" }),
            h("span", { text: rating !== null ? ` ${rating.toFixed(1)} on Google` : " Rated on Google" }),
            h("span", { class: "bw-sep", text: "\u00b7" }),
            h("span", { text: "Licensed and insured" }),
          ]),
        ]),
        h("div", { class: "bw-svc" }, [
          h("span", { class: "bw-tag t1", text: "A page per service" }),
          ...svc.map((t, i) => h("div", { class: `bw-card c${i}` }, [
            h("span", { class: "bw-card-img", "aria-hidden": "true" }),
            h("span", { class: "bw-card-t", text: t }),
            h("span", { class: "bw-card-l", text: "Learn more \u2192" }),
          ])),
        ]),
        h("div", { class: "bw-area" }, [
          h("span", { text: "Serving " }),
          h("b", { text: town || "your area" }),
          h("span", { text: " and nearby towns" }),
        ]),
      ]),
    ]);
  }

  // Their Google profile as a finished one looks, numbered to match the list beside it.
  function artGbp(report) {
    const p = report?.profile || {};
    const rating = num(report?.reviews?.googleRating);
    const count = num(report?.reviews?.googleReviewCount) ?? 0;
    const kw = report?.ranking?.keyword || tradeWord(report) || "contractor";
    const svc = servicesFor(kw);
    const town = townOf(report);
    const photo = p.photo ? window.DialBridgeScan?.photoUrl?.(p.photo, 640) : "";
    const pin = (n) => h("span", { class: "kp-pin", text: String(n) });

    return h("div", { class: "kp" }, [
      h("div", { class: "kp-photos" }, [
        photo ? h("div", { class: "kp-ph big" }, [img(photo, { alt: `${p.name} on Google`, loading: "lazy" })]) : h("div", { class: "kp-ph big is-blank", text: "Job photo" }),
        h("div", { class: "kp-ph is-blank", text: "Team" }),
        h("div", { class: "kp-ph is-blank", text: "Before / after" }),
        pin(1),
      ]),
      h("div", { class: "kp-body" }, [
        h("p", { class: "kp-name", text: p.name || "Your business" }),
        h("p", { class: "kp-rate" }, [
          h("span", { text: rating !== null ? rating.toFixed(1) : "5.0" }),
          starsFor(rating),
          h("span", { class: "kp-link", text: `${count} Google reviews` }),
        ]),
        h("p", { class: "kp-cat", text: `${p.category || capFirst(kw)} in ${town || "your area"}` }),
        h("div", { class: "kp-acts" }, ["Website", "Directions", "Save", "Call"].map((t) => h("span", { text: t }))),
        h("div", { class: "kp-book-wrap" }, [h("span", { class: "kp-book", text: "Book online" }), pin(2)]),
        h("dl", { class: "kp-rows" }, [
          h("dt", { text: "Address:" }), h("dd", { text: p.address || `Serves ${town || "your area"}` }),
          h("dt", { text: "Hours:" }), h("dd", {}, [h("span", { class: "kp-open", text: "Open" }), " \u00b7 Closes 6 PM"]),
          h("dt", { text: "Phone:" }), h("dd", { class: "kp-blue", text: p.phone || "" }),
          h("dt", { text: "Services:" }), h("dd", { text: `${svc.join(", ")}, and more` }),
        ]),
        h("div", { class: "kp-upd" }, [
          h("p", { class: "kp-sec", text: "Updates from the business" }),
          h("div", { class: "kp-post" }, [
            h("span", { class: "kp-post-img", "aria-hidden": "true" }),
            h("div", {}, [h("p", { text: `Finished a ${svc[0].toLowerCase()} job${town ? ` in ${town}` : ""} today.` }), h("p", { class: "kp-muted", text: "2 days ago" })]),
          ]),
          pin(3),
        ]),
        h("div", { class: "kp-rev" }, [
          h("p", { class: "kp-sec", text: "Reviews" }),
          h("p", { class: "kp-rv" }, [h("b", { text: "Sarah K. " }), h("span", { class: "rs-stars", text: "\u2605\u2605\u2605\u2605\u2605" })]),
          h("p", { class: "kp-rv-t", text: "Showed up on time, fixed it fast." }),
          h("p", { class: "kp-reply" }, [h("b", { text: "Response from the owner: " }), "Thanks Sarah, glad we could help!"]),
          pin(4),
        ]),
      ]),
    ]);
  }

  // Yelp and Facebook, drawn as their pages, with the same details as Google.
  function artListings(report) {
    const p = report?.profile || {};
    const name = p.name || "Your business";
    const kw = report?.ranking?.keyword || tradeWord(report) || "contractor";
    const town = townOf(report);
    const addr = p.address || `Serves ${town || "your area"}`;
    const phone = p.phone || "";
    const yelpStars = h("span", { class: "yp-stars", "aria-hidden": "true" }, [1, 2, 3, 4, 5].map(() => h("i", { text: "\u2605" })));
    return h("div", { class: "ls" }, [
      h("div", { class: "yp" }, [
        h("div", { class: "yp-bar" }, [h("span", { class: "yp-logo", text: "yelp" }), h("span", { class: "yp-search", text: `${kw} near ${town || "me"}` })]),
        h("div", { class: "yp-body" }, [
          h("p", { class: "yp-name", text: name }),
          h("p", { class: "yp-rate" }, [yelpStars, h("span", { class: "yp-claimed", text: "\u2713 Claimed" })]),
          h("p", { class: "yp-cat", text: `${capFirst(kw)} \u00b7 Open until 6:00 PM` }),
          h("p", { class: "yp-line", text: addr }),
          h("p", { class: "yp-line", text: phone }),
        ]),
      ]),
      h("div", { class: "fbp" }, [
        h("div", { class: "fbp-cover", "aria-hidden": "true" }),
        h("div", { class: "fbp-body" }, [
          h("span", { class: "fbp-av", text: initials(shortName(name)) }),
          h("div", {}, [
            h("p", { class: "fbp-name", text: name }),
            h("p", { class: "fbp-cat", text: `${capFirst(kw)} \u00b7 ${town || "Local business"}` }),
          ]),
        ]),
        h("div", { class: "fbp-info" }, [h("p", { text: addr }), h("p", { class: "kp-blue", text: phone })]),
        h("div", { class: "fbp-btns" }, [h("span", { class: "is-primary", text: "Call now" }), h("span", { text: "Message" })]),
      ]),
      h("div", { class: "ls-match" }, [
        h("span", { class: "ls-match-t", text: "Same name, address and phone as Google and your website" }),
        h("span", { class: "ls-match-ok", text: "\u2713 Match" }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- system art

  function artMaps(report) {
    const name = report?.profile?.name || "Your business";
    const rating = num(report?.reviews?.googleRating);
    const count = num(report?.reviews?.googleReviewCount) ?? 0;
    const cat = report?.profile?.category || capFirst(report?.ranking?.keyword || "Contractor");
    const kw = report?.ranking?.keyword || tradeWord(report) || "contractor";
    const rivals = rivalsFor(report, 2);
    const row = (n, nm, r, c, mine) => h("div", { class: `mp-row${mine ? " is-me" : ""}` }, [
      h("span", { class: "mp-n", text: String(n) }),
      h("div", { class: "mp-info" }, [
        h("p", { class: "mp-name" }, [nm, mine ? h("span", { class: "mp-you", text: "You" }) : null].filter(Boolean)),
        h("p", { class: "mp-meta" }, [h("span", { text: r !== null && r !== undefined ? Number(r).toFixed(1) + " " : "" }), starsFor(r), h("span", { class: "rs-muted", text: ` (${c || 0}) \u00b7 ${cat}` })]),
      ]),
      h("span", { class: "mp-call", text: "Call" }),
    ]);
    return h("div", { class: "mp" }, [
      h("div", { class: "mp-q" }, [h("span", { class: "rs-q-ico", "aria-hidden": "true" }), h("span", { text: `${kw} near me` })]),
      h("div", { class: "mp-map", "aria-hidden": "true" }, [
        h("span", { class: "mp-pin p1" }), h("span", { class: "mp-pin p2" }), h("span", { class: "mp-pin p3" }),
      ]),
      h("div", { class: "mp-list" }, [
        row(1, name, rating, count, true),
        ...rivals.map((c, i) => row(i + 2, c.name, c.rating, c.reviewCount, false)),
      ]),
      h("div", { class: "mp-ai" }, [
        h("p", { class: "mp-ai-t", text: "ChatGPT" }),
        h("p", { text: `For a ${kw}${townOf(report) ? ` in ${townOf(report)}` : ""}, ${shortName(name)} is well reviewed and books online.` }),
      ]),
    ]);
  }

  function artCalendar(report) {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const jobs = {
      Mon: [["8 AM", "Leak repair"], ["1 PM", "Estimate"]],
      Tue: [["9 AM", "Drain clog"], ["2 PM", "Kitchen sink \u00b7 Mark", true]],
      Wed: [["10 AM", "Water heater"]],
      Thu: [["8 AM", "Estimate"], ["12 PM", "Toilet install"]],
      Fri: [["11 AM", "Inspection"]],
    };
    return h("div", { class: "cw" }, [
      h("div", { class: "cw-toast" }, [
        h("span", { class: "cw-toast-ico", text: "\u2713" }),
        h("div", {}, [h("p", { class: "cw-toast-t", text: "New booking" }), h("p", { text: "Tue, 2 to 4 PM \u00b7 Kitchen sink \u00b7 Mark" })]),
      ]),
      h("div", { class: "cw-grid" }, days.map((d, i) => h("div", { class: "cw-day" }, [
        h("p", { class: "cw-dh" }, [h("span", { text: d }), h("b", { text: String(13 + i) })]),
        ...(jobs[d] || []).map(([t, what, isNew]) => h("div", { class: `cw-ev${isNew ? " is-new" : ""}` }, [h("span", { class: "cw-ev-t", text: t }), h("span", { text: what })])),
      ]))),
      h("p", { class: "cw-foot", text: "Booked online \u00b7 added to your CRM" }),
    ]);
  }

  function artQuote(report) {
    const v = num(report?.leak?.jobValue);
    const amount = v ? money(v) : "$2,400";
    const bubble = (day, text) => h("div", { class: "qf-msg" }, [h("span", { class: "qf-day", text: day }), h("p", { text })]);
    return h("div", { class: "qf" }, [
      h("div", { class: "qf-card" }, [
        h("div", { class: "qf-head" }, [h("p", { class: "qf-no", text: "Estimate #1047" }), h("span", { class: "qf-sent", text: "Sent Monday" })]),
        h("p", { class: "qf-job", text: "Water heater replacement \u00b7 Mark T." }),
        h("p", { class: "qf-amt", text: amount }),
        pin(1, "at-right"),
      ]),
      h("p", { class: "qf-auto", text: "Sent automatically, in your name" }),
      h("div", { class: "qf-pinwrap" }, [bubble("Wednesday", "Hi Mark, just checking you got the estimate. Any questions I can answer?"), pin(2, "at-right")]),
      bubble("Saturday", "We have an opening Tuesday if you'd like to get it done before the weekend."),
      h("div", { class: "qf-won" }, [h("span", { text: "\u2713" }), h("p", { text: "Mark accepted \u00b7 booked for Tuesday" }), pin(3, "at-right")]),
    ]);
  }

  function artReview(report) {
    const short = shortName(report?.profile?.name);
    return h("div", { class: "rv" }, [
      h("div", { class: "rv-sms" }, [
        h("p", { class: "rv-from", text: short }),
        h("p", { class: "rv-b", text: "Thanks for having us out today, Sarah! If you have a minute, a quick review really helps a small crew like ours." }),
        h("p", { class: "rv-link", text: "g.page/r/review" }),
        h("p", { class: "rv-when", text: "Sent 2 hours after the job was marked done" }),
        pin(1, "at-right"),
      ]),
      h("span", { class: "rv-arrow", "aria-hidden": "true", text: "\u2193" }),
      h("div", { class: "rv-card" }, [
        h("div", { class: "rv-head" }, [h("span", { class: "rs-av", text: "S" }), h("div", {}, [h("b", { text: "Sarah K." }), h("p", { class: "rs-muted", text: "Local Guide \u00b7 14 reviews" })])]),
        h("p", {}, [h("span", { class: "rs-stars", text: "\u2605\u2605\u2605\u2605\u2605" }), h("span", { class: "rs-muted", text: " just now" })]),
        h("p", { class: "rv-t", text: "Showed up on time, explained everything, fixed it fast. Would call again." }),
        pin(2, "at-right"),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- the plan
  //
  // One pattern, the one that worked: a centered picture with numbered markers on it, and
  // a numbered line or two under it. Almost no prose. The sections follow the offer on the
  // SOPs board ("What we sell"): website, Google profile, consistent listings, then Local
  // Services Ads and Maps, Reserve with Google, missed-call text back and one inbox,
  // quote follow-up, review generation. AI phone answering is optional there and stays
  // out of here.

  const pin = (n, cls = "") => h("span", { class: `pin ${cls}`.trim(), text: String(n) });

  function planSection({ kicker, title, line, note, art, legend, auto, wide }) {
    return h("section", { class: `ps${wide ? " is-wide" : ""}` }, [
      h("p", { class: "ps-kick", text: kicker }),
      h("h4", { class: "ps-title", text: title }),
      line ? h("p", { class: "ps-line", text: line }) : null,
      h("div", { class: "ps-art" }, [
        auto ? h("span", { class: "ps-auto" }, [h("i", { "aria-hidden": "true" }), "Runs automatically"]) : null,
        art,
      ].filter(Boolean)),
      legend.length ? h("ol", { class: "ps-legend" }, legend.map((t, i) => h("li", {}, [h("span", { class: "ps-n", text: String(i + 1) }), h("span", { text: t })]))) : null,
      note ? h("p", { class: "ps-note", text: note }) : null,
    ].filter(Boolean));
  }

  // ---- four real pages from one well-built contractor site: home, about, services,
  //      locations. The point is the set of pages, which is what ranks, not one homepage.
  function artSiteExample() {
    const page = (src, label, n) => h("figure", { class: "sp" }, [
      h("div", { class: "sp-phone" }, [img(src, { alt: `${label} page of a top home service company's website`, loading: "lazy" }), pin(n, "at-top")]),
      h("figcaption", { class: "sp-label", text: label }),
    ]);
    return h("div", { class: "sps" }, [
      h("div", { class: "sp-row" }, [
        page("img/page-home.webp", "Home", 1),
        page("img/page-about.webp", "About", 2),
        page("img/page-services.webp", "Services", 3),
        page("img/page-locations.webp", "Locations", 4),
      ]),
      h("p", { class: "sp-cap", text: "Example: pages from a top home service company's website" }),
    ]);
  }

  // ---- the same name, address and phone on Google, Yelp and Facebook, each drawn the
  //      way that site actually lays out a business, with the three fields highlighted.
  function napIco(kind) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "ni"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", {
      pin: "M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z",
      phone: "M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z",
      clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 3.2 1.9-.8 1.3L11 13V7h2z",
      globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.3a16.5 16.5 0 0 0 0 4zm.8 2h2.9c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16zM8 8H5.1a8 8 0 0 1 4.3-3.6C8.8 5.5 8.3 6.7 8 8zm4 12c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h2.9a8 8 0 0 1-4.3 3.6zm1.8-5.6a16.5 16.5 0 0 0 0-4h3.3a8.2 8.2 0 0 1 0 4z",
    }[kind] || "");
    svg.appendChild(path);
    return svg;
  }

  function artNap(report) {
    const p = report?.profile || {};
    const name = p.name || "Your business";
    const addr = p.address || `Serves ${townOf(report) || "your area"}`;
    const phone = p.phone || "(555) 123-4567";
    const rating = num(report?.reviews?.googleRating);
    const count = num(report?.reviews?.googleReviewCount) ?? 0;
    const kw = report?.ranking?.keyword || tradeWord(report) || "contractor";
    const cat = p.category || capFirst(kw);
    const town = townOf(report);
    const photo = p.photo ? window.DialBridgeScan?.photoUrl?.(p.photo, 640) : "";
    const hero = (cls) => photo
      ? h("div", { class: cls }, [img(photo, { alt: "", loading: "lazy" })])
      : h("div", { class: `${cls} is-blank` });
    const mark = (text, n, cls = "") => h("span", { class: `hl ${cls}`.trim() }, [text, n ? pin(n, "at-hl") : null].filter(Boolean));

    const google = h("div", { class: "lg lg-google" }, [
      hero("lg-photo"),
      h("div", { class: "lg-body" }, [
        h("p", { class: "lg-g-name" }, [mark(name), pin(1, "at-end")]),
        h("p", { class: "lg-g-rate" }, [h("span", { text: rating !== null ? rating.toFixed(1) : "" }), starsFor(rating), h("span", { class: "lg-g-muted", text: ` (${count})` })]),
        h("p", { class: "lg-g-muted", text: `${cat} in ${town || "your area"}` }),
        h("div", { class: "lg-g-chips" }, ["Call", "Directions", "Website", "Save"].map((t) => h("span", { text: t }))),
        h("div", { class: "lg-g-row" }, [napIco("pin"), mark(addr), pin(2, "at-end")]),
        h("div", { class: "lg-g-row" }, [napIco("clock"), h("span", {}, [h("b", { class: "lg-open", text: "Open" }), " \u00b7 Closes 6 PM"])]),
        h("div", { class: "lg-g-row" }, [napIco("phone"), mark(phone), pin(3, "at-end")]),
      ]),
    ]);

    const yelp = h("div", { class: "lg lg-yelp" }, [
      h("div", { class: "lg-y-bar" }, [h("span", { class: "lg-y-logo", text: "yelp" }), h("span", { class: "lg-y-search", text: `${kw} near ${town || "me"}` })]),
      h("div", { class: "lg-y-hero" }, [
        photo ? img(photo, { alt: "", loading: "lazy" }) : null,
        h("div", { class: "lg-y-over" }, [
          h("p", { class: "lg-y-name" }, [mark(name, null, "on-dark")]),
          h("p", { class: "lg-y-rate" }, [
            h("span", { class: "lg-y-stars", "aria-hidden": "true" }, [1, 2, 3, 4, 5].map((i) => h("i", { class: rating !== null && i > Math.round(rating) ? "off" : "", text: "\u2605" }))),
            h("span", { text: ` ${count} reviews` }),
          ]),
          h("p", { class: "lg-y-claim" }, [h("b", { text: "\u2713 Claimed" }), ` \u00b7 ${cat}`]),
        ]),
      ].filter(Boolean)),
      h("div", { class: "lg-y-body" }, [
        h("p", { class: "lg-y-h", text: "Location & Hours" }),
        h("div", { class: "lg-y-loc" }, [h("span", { class: "lg-y-map", "aria-hidden": "true" }, [h("i")]), mark(addr)]),
        h("div", { class: "lg-y-phone" }, [mark(phone), napIco("phone")]),
      ]),
    ]);

    const fb = h("div", { class: "lg lg-fb" }, [
      hero("lg-f-cover"),
      h("div", { class: "lg-f-head" }, [
        h("span", { class: "lg-f-av", text: initials(shortName(name)) }),
        h("p", { class: "lg-f-name" }, [mark(name)]),
        h("p", { class: "lg-f-cat", text: cat }),
        h("div", { class: "lg-f-btns" }, [h("span", { class: "is-primary", text: "Call now" }), h("span", { text: "Message" })]),
      ]),
      h("div", { class: "lg-f-intro" }, [
        h("p", { class: "lg-f-h", text: "Intro" }),
        h("div", { class: "lg-f-row" }, [napIco("pin"), mark(addr)]),
        h("div", { class: "lg-f-row" }, [napIco("phone"), mark(phone)]),
        h("div", { class: "lg-f-row" }, [napIco("clock"), h("span", { class: "lg-open", text: "Open now" })]),
      ]),
    ]);

    const eq = () => h("span", { class: "lg-eq", "aria-hidden": "true", text: "=" });
    return h("div", { class: "lgs" }, [
      h("div", { class: "lg-row" }, [
        h("div", { class: "lg-col" }, [google, h("p", { class: "lg-label", text: "Google" })]), eq(),
        h("div", { class: "lg-col" }, [yelp, h("p", { class: "lg-label", text: "Yelp" })]), eq(),
        h("div", { class: "lg-col" }, [fb, h("p", { class: "lg-label", text: "Facebook" })]),
      ]),
    ]);
  }

  // ---- the top of Google: the Local Services Ad, the map pack, and a ChatGPT answer.
  function artTopOfGoogle(report, { chat = true } = {}) {
    const name = report?.profile?.name || "Your business";
    const rating = num(report?.reviews?.googleRating);
    const count = num(report?.reviews?.googleReviewCount) ?? 0;
    const kw = report?.ranking?.keyword || tradeWord(report) || "contractor";
    const cat = report?.profile?.category || capFirst(kw);
    const town = townOf(report);
    const rivals = rivalsFor(report, 2);
    const mapRow = (n, nm, r, c, mine) => h("div", { class: `tg-row${mine ? " is-me" : ""}` }, [
      h("span", { class: "tg-dot", text: String(n) }),
      h("div", { class: "tg-info" }, [
        h("p", { class: "tg-name", text: nm }),
        h("p", { class: "tg-meta" }, [r !== null && r !== undefined ? `${Number(r).toFixed(1)} ` : "", starsFor(r), ` (${c || 0}) \u00b7 ${cat}`]),
        h("p", { class: "tg-open", text: "Open 24 hours" }),
      ]),
      h("div", { class: "tg-btns" }, [h("span", { text: "Call" }), h("span", { text: "Directions" })]),
      mine ? pin(2, "at-right") : null,
    ].filter(Boolean));
    return h("div", { class: "tg-wrap" }, [
      h("div", { class: "tg" }, [
        h("div", { class: "tg-q" }, [h("span", { class: "rs-q-ico", "aria-hidden": "true" }), `${kw} near me`]),
        h("div", { class: "tg-lsa" }, [
          h("p", { class: "tg-spons", text: "Sponsored \u00b7 Google Guaranteed" }),
          h("p", { class: "tg-lsa-name" }, [name, h("span", { class: "tg-gg", text: "\u2713" })]),
          h("p", { class: "tg-meta" }, [rating !== null ? `${rating.toFixed(1)} ` : "", starsFor(rating), ` (${count}) \u00b7 Open now`]),
          pin(1, "at-right"),
        ]),
        h("div", { class: "tg-map", "aria-hidden": "true" }, [
          h("span", { class: "tg-mpin m1" }, [h("b", { text: "1" })]),
          h("span", { class: "tg-mpin m2" }, [h("b", { text: "2" })]),
          h("span", { class: "tg-mpin m3" }, [h("b", { text: "3" })]),
        ]),
        h("div", { class: "tg-list" }, [
          mapRow(1, name, rating, count, true),
          ...rivals.map((c, i) => mapRow(i + 2, c.name, c.rating, c.reviewCount, false)),
        ]),
      ]),
      !chat ? null : h("div", { class: "tg-chat" }, [
        h("p", { class: "tg-chat-h", text: "ChatGPT" }),
        h("p", { class: "tg-ask", text: town ? `Who's a good ${kw} in ${town}?` : `Who's a good ${kw} near me?` }),
        h("p", { class: "tg-ans" }, [h("b", { text: shortName(name) }), ` is a well-reviewed ${kw}${town ? ` in ${town}` : ""}, answers fast and books online.`]),
        pin(3, "at-right"),
      ]),
    ].filter(Boolean));
  }

  // ============ REAL PHONE SCREENS ============
  // iOS Recents and Messages, drawn the way they actually look, inside the same phone frame
  // as the website section. The lead's side of the story, which is the side that decides.

  function iosRecents(rows) {
    return h("div", { class: "ios ios-rc" }, [
      h("div", { class: "rc-seg" }, [h("span", { class: "is-on", text: "All" }), h("span", { text: "Missed" })]),
      h("p", { class: "rc-title", text: "Recents" }),
      h("div", { class: "rc-list" }, rows.map((r) => h("div", { class: `rc-row${r.missed ? " is-missed" : ""}` }, [
        h("div", { class: "rc-main" }, [h("p", { class: "rc-name", text: r.name }), h("p", { class: "rc-sub", text: r.sub })]),
        h("p", { class: "rc-time", text: r.time }),
        h("span", { class: "rc-info", text: "i" }),
        r.pin ? pin(r.pin, "at-in") : null,
      ].filter(Boolean)))),
    ]);
  }

  function iosMessages(contact, items) {
    return h("div", { class: "ios ios-im" }, [
      h("div", { class: "im-head" }, [
        h("span", { class: "im-back", text: "\u2039" }),
        h("span", { class: "im-av", text: initials(contact) }),
        h("p", { class: "im-name", text: `${contact} \u203a` }),
      ]),
      h("div", { class: "im-body" }, items.map((it) => {
        if (it.stamp) return h("p", { class: "im-stamp" }, [h("b", { text: it.stamp.split(" ")[0] }), " " + it.stamp.split(" ").slice(1).join(" ")]);
        if (it.status) return h("p", { class: "im-status", text: it.status });
        if (it.link) return h("div", { class: "im-row is-them" }, [
          h("div", { class: "im-link" }, [
            h("div", { class: "im-link-img" }, [h("span", { class: "im-g", text: "G" })]),
            h("div", { class: "im-link-t" }, [h("b", { text: it.link }), h("span", { text: it.site || "g.page" })]),
          ]),
          it.pin ? pin(it.pin, "at-in") : null,
        ].filter(Boolean));
        return h("div", { class: `im-row is-${it.from}` }, [
          h("p", { class: "im-b", text: it.text }),
          it.pin ? pin(it.pin, "at-in") : null,
        ].filter(Boolean));
      })),
    ]);
  }

  // ---- Step 1: her phone, twice
  function artCallsPhones(report) {
    const me = shortName(report?.profile?.name);
    const rival = shortName((rivalsFor(report, 1)[0] || {}).name || "Another company");
    const col = (tone, label, screen, cap) => h("div", { class: `cp-col is-${tone}` }, [
      h("span", { class: "cp-tag", text: label }),
      deviceFrame(screen),
      h("p", { class: "cp-cap", text: cap }),
    ]);
    return h("div", { class: "cp" }, [
      col("bad", "Without DialBridge", iosRecents([
        { name: rival, sub: "Outgoing call \u00b7 11 min", time: "2:16 PM", pin: 2 },
        { name: me, sub: "No answer", time: "2:14 PM", missed: true, pin: 1 },
        { name: "Dentist Office", sub: "mobile", time: "Yesterday" },
        { name: "(732) 555-0147", sub: "Unknown", time: "Monday" },
      ]), `She called you, then called ${rival}.`),
      col("good", "With DialBridge", iosMessages(me, [
        { stamp: "Today 2:14 PM" },
        { from: "them", text: `Hi, this is ${me}. Sorry we missed your call, we're on a job. What can we help with?`, pin: 3 },
        { from: "me", text: "Kitchen sink is backing up. Can someone come today?" },
        { from: "them", text: "Yes! We have 2 to 4 PM open today. Want it?" },
        { from: "me", text: "Yes please, book it." },
        { from: "them", text: "You're booked for 2 to 4 PM. See you then!", pin: 4 },
        { status: "Delivered" },
      ]), "She gets a text in seconds, and books."),
    ]);
  }

  // ---- Step 3: the quote as a PDF in Gmail, the follow-ups, the yes
  function quoteLines(total) {
    const a = Math.round((total * 0.6) / 10) * 10;
    const b = Math.round((total * 0.32) / 10) * 10;
    return [["Equipment and parts", a], ["Labor and installation", b], ["Permit and haul-away", total - a - b]];
  }

  function pdfDoc(report, { total, accepted = false } = {}) {
    const name = report?.profile?.name || "Your business";
    return h("div", { class: `pdf${accepted ? " is-accepted" : ""}` }, [
      h("div", { class: "pdf-head" }, [h("b", { text: shortName(name) }), h("span", { text: "ESTIMATE #1047" })]),
      h("p", { class: "pdf-to", text: "Prepared for Mark T. \u00b7 Water heater replacement" }),
      h("div", { class: "pdf-lines" }, quoteLines(total).map(([t, v]) => h("p", {}, [h("span", { text: t }), h("span", { text: money(v) })]))),
      h("p", { class: "pdf-total" }, [h("span", { text: "Total" }), h("b", { text: money(total) })]),
      accepted
        ? h("div", { class: "pdf-sign" }, [h("span", { class: "pdf-sig", text: "Mark T." }), h("span", { class: "pdf-stamp", text: "ACCEPTED" })])
        : h("span", { class: "pdf-btn", text: "Accept estimate" }),
    ]);
  }

  function artQuoteFlow(report) {
    const v = num(report?.leak?.jobValue);
    const total = v && v >= 300 ? Math.round(v / 10) * 10 : 3000;
    const me = shortName(report?.profile?.name);
    const screen = (n, label, body) => h("div", { class: "bs-col" }, [
      h("div", { class: "bs qf2" }, [...body, pin(n, "at-top")]),
      h("p", { class: "bs-label", text: label }),
    ]);
    const arrow = () => h("span", { class: "bs-arrow", "aria-hidden": "true", text: "\u2192" });
    return h("div", { class: "bss" }, [
      screen(1, "The quote goes out as a PDF", [
        h("div", { class: "gm" }, [
          h("div", { class: "gm-from" }, [h("span", { class: "gm-av", text: initials(me) }), h("div", {}, [h("b", { text: me }), h("span", { text: "to Mark" })])]),
          h("p", { class: "gm-subj", text: "Your quote: water heater replacement" }),
          h("div", { class: "gm-att" }, [
            h("div", { class: "gm-thumb" }, [pdfDoc(report, { total })]),
            h("p", { class: "gm-chip" }, [h("span", { class: "gm-pdf", text: "PDF" }), "Estimate-1047.pdf"]),
          ]),
        ]),
      ]),
      arrow(),
      screen(2, "Follow-ups go out on their own", [
        h("div", { class: "fu" }, [
          h("div", { class: "fu-head" }, [h("span", { class: "fu-av", text: initials(me) }), h("b", { text: me })]),
          h("p", { class: "fu-stamp", text: "Wednesday \u00b7 automatic" }),
          h("p", { class: "fu-b", text: "Hi Mark, just checking you got the quote. Any questions?" }),
          h("p", { class: "fu-stamp", text: "Saturday \u00b7 automatic" }),
          h("p", { class: "fu-b", text: "We have an opening Tuesday if you'd like to get it done." }),
          h("p", { class: "fu-b is-me", text: "Tuesday works. Let's do it." }),
        ]),
      ]),
      arrow(),
      screen(3, "The quote gets accepted", [
        pdfDoc(report, { total, accepted: true }),
        h("p", { class: "qa-booked" }, [h("span", { text: "\u2713" }), "Booked for Tuesday, 9 AM"]),
      ]),
    ]);
  }

  // ---- Step 4: the review request as a real iMessage, and the review it turns into
  function artReviewPhone(report) {
    const me = shortName(report?.profile?.name);
    const rating = num(report?.reviews?.googleRating);
    const count = num(report?.reviews?.googleReviewCount) ?? 0;
    return h("div", { class: "rp" }, [
      deviceFrame(iosMessages(me, [
        { stamp: "Today 4:06 PM" },
        { from: "them", text: `Thanks for choosing ${me} today, Sarah! If you have a minute, a quick review would really help us.`, pin: 1 },
        { link: `Review ${me}`, site: "g.page" },
        { from: "me", text: "Just left you 5 stars. Great job!" },
        { status: "Delivered" },
      ])),
      h("span", { class: "rp-arrow", "aria-hidden": "true", text: "\u2192" }),
      h("div", { class: "rp-review" }, [
        h("div", { class: "rp-panel" }, [
          h("div", { class: "rp-top" }, [
            h("p", { class: "rp-biz", text: report?.profile?.name || "Your business" }),
            h("p", { class: "rp-sum" }, [
              h("b", { text: rating !== null ? rating.toFixed(1) : "5.0" }),
              starsFor(rating),
              h("span", { class: "rp-count" }, [h("s", { text: `${count}` }), ` ${count + 1} reviews`]),
            ]),
          ]),
          h("div", { class: "rv-card" }, [
            h("div", { class: "rv-head" }, [
              h("span", { class: "rs-av", text: "S" }),
              h("div", {}, [h("b", { text: "Sarah K." }), h("p", { class: "rs-muted", text: "Local Guide \u00b7 14 reviews" })]),
              h("span", { class: "rp-new", text: "New" }),
            ]),
            h("p", {}, [h("span", { class: "rs-stars", text: "\u2605\u2605\u2605\u2605\u2605" }), h("span", { class: "rs-muted", text: " just now" })]),
            h("p", { class: "rv-t", text: "Showed up on time, explained everything, fixed it fast. Would call again." }),
            pin(2, "at-right"),
          ]),
        ]),
      ]),
    ]);
  }

  // ---- Result 2: ChatGPT, drawn as ChatGPT
  function artChatGpt(report) {
    const me = report?.profile?.name || "Your business";
    const kw = report?.ranking?.keyword || tradeWord(report) || "contractor";
    const town = townOf(report);
    const rivals = rivalsFor(report, 2);
    const item = (n, name, sub, mine) => h("li", { class: mine ? "is-me" : "" }, [
      h("b", { text: name }), ` \u2014 `.replace("\u2014", "-"), h("span", { text: sub }), mine ? pin(1, "at-in") : null,
    ].filter(Boolean));
    return h("div", { class: "cg" }, [
      h("div", { class: "cg-top" }, [h("b", { text: "ChatGPT" }), h("span", { text: "\u2304" })]),
      h("div", { class: "cg-body" }, [
        h("p", { class: "cg-user", text: town ? `Who's a good ${kw} in ${town}?` : `Who's a good ${kw} near me?` }),
        h("div", { class: "cg-ans" }, [
          h("p", { text: `Here are a few well-reviewed options${town ? ` in ${town}` : ""}:` }),
          h("ol", {}, [
            item(1, me, "Highly rated, answers fast and books online.", true),
            ...rivals.map((c, i) => item(i + 2, c.name, `${c.rating ? Number(c.rating).toFixed(1) + " stars" : ""}${c.reviewCount ? `, ${fmt(c.reviewCount)} reviews` : ""}.`, false)),
          ]),
        ]),
      ]),
      h("div", { class: "cg-input" }, [h("span", { text: "Ask anything" }), h("span", { class: "cg-send", text: "\u2191" })]),
    ]);
  }

  // ---- Result 3: the pipeline, with the leads that used to slip away
  function artPipeline(report) {
    const me = shortName(report?.profile?.name);
    const card = (src, who, what, extra, opts = {}) => h("div", { class: `pl-card${opts.rec ? " is-rec" : ""}` }, [
      h("span", { class: `pl-src is-${src.toLowerCase().replace(/[^a-z]/g, "")}`, text: src }),
      h("p", { class: "pl-who", text: who }),
      h("p", { class: "pl-what", text: what }),
      extra ? h("p", { class: "pl-x", text: extra }) : null,
      opts.pin ? pin(opts.pin, "at-in") : null,
    ].filter(Boolean));
    const colm = (title, count, cards) => h("div", { class: "pl-col" }, [h("p", { class: "pl-h" }, [title, h("span", { text: String(count) })]), ...cards]);
    return h("div", { class: "pl" }, [
      h("div", { class: "pl-top" }, [h("b", { text: `${me} \u00b7 Pipeline` }), h("span", { text: "This week" })]),
      h("div", { class: "pl-cols" }, [
        colm("New", 2, [card("Facebook", "Chris P.", "Clogged drain"), card("Website", "Jen L.", "Bathroom remodel")]),
        colm("Replied", 1, [card("Missed call", "Dana R.", "Water heater leaking", "Texted back in 8 sec")]),
        colm("Quoted", 1, [card("Quote", "Ray S.", "Sewer line", "Follow-up 2 of 3", { pin: 2 })]),
        colm("Booked", 2, [
          card("Missed call", "Sam K.", "Kitchen sink", "Tue, 2 PM", { rec: true, pin: 1 }),
          card("Quote", "Mark T.", "Water heater", "Accepted", { rec: true }),
        ]),
      ]),
    ]);
  }

  // ---- a lead's journey, twice: without the system and with it. Each stop is a small
  //      piece of real-looking phone UI, so it reads as what actually happens rather than
  //      as a diagram of it.
  function journey(rows) {
    const lane = (tone, label, stops) => h("div", { class: `jr-lane is-${tone}` }, [
      h("p", { class: "jr-lab" }, [h("span", { class: "jr-dot" }), label]),
      h("ol", { class: "jr-stops" }, stops.map((node, i) => [
        h("li", { class: "jr-stop" }, [node]),
        i < stops.length - 1 ? h("li", { class: "jr-arrow", "aria-hidden": "true", text: "\u2192" }) : null,
      ]).flat().filter(Boolean)),
    ]);
    return h("div", { class: "jr" }, rows.map(([tone, label, stops]) => lane(tone, label, stops)));
  }

  const jCall = (who, sub) => h("div", { class: "jc jc-call" }, [
    h("p", { class: "jc-sub", text: sub || "Calling\u2026" }),
    h("p", { class: "jc-who", text: who }),
    h("div", { class: "jc-btns" }, [h("span", { class: "end" }), h("span", { class: "ok" })]),
  ]);
  const jNote = (title, text, tone) => h("div", { class: `jc jc-note is-${tone || "plain"}` }, [
    h("p", { class: "jc-nt", text: title }),
    text ? h("p", { class: "jc-nx", text }) : null,
  ].filter(Boolean));
  const jText = (from, text, when) => h("div", { class: "jc jc-text" }, [
    h("p", { class: "jc-from", text: from }),
    h("p", { class: "jc-bub", text }),
    when ? h("p", { class: "jc-when", text: when }) : null,
  ].filter(Boolean));
  const jResult = (ok, title, text) => h("div", { class: `jc jc-res ${ok ? "is-ok" : "is-bad"}` }, [
    h("span", { class: "jc-ico", text: ok ? "\u2713" : "\u2715" }),
    h("p", { class: "jc-nt", text: title }),
    text ? h("p", { class: "jc-nx", text }) : null,
  ].filter(Boolean));

  function artCallsJourney(report) {
    const me = shortName(report?.profile?.name);
    const rival = shortName((rivalsFor(report, 1)[0] || {}).name || "Another company");
    return journey([
      ["bad", "Without an automated system", [
        jCall(me),
        jNote("Missed call", "You're on a job", "bad"),
        jCall(rival, "She calls the next one\u2026"),
        jResult(false, "Job lost", `Booked with ${rival}`),
      ]],
      ["good", "With DialBridge", [
        jCall(me),
        jNote("Missed call", "You're on a job", "bad"),
        jText(me, "Sorry we missed you! What do you need help with?", "8 seconds later"),
        jResult(true, "Job booked", "Tuesday, 2 to 4 PM"),
      ]],
    ]);
  }

  function artQuotesJourney(report) {
    const v = num(report?.leak?.jobValue);
    const amt = v ? money(v) : "$3,000";
    const me = shortName(report?.profile?.name);
    return journey([
      ["bad", "Without an automated system", [
        jNote("Quote sent", amt, "plain"),
        jNote("Day 3", "No reply", "muted"),
        jNote("Day 10", "You forgot to follow up", "muted"),
        jResult(false, "Job lost", "Hired someone else"),
      ]],
      ["good", "With DialBridge", [
        jNote("Quote sent", amt, "plain"),
        jText(me, "Any questions about the quote?", "Day 2, automatic"),
        jText(me, "We have an opening Tuesday.", "Day 5, automatic"),
        jResult(true, "Quote accepted", "Booked for Tuesday"),
      ]],
    ]);
  }

  // ---- booking, as three screens side by side: listing, pick a time, confirmed.
  function artBookingScreens(report) {
    const name = report?.profile?.name || "Your business";
    const rating = num(report?.reviews?.googleRating);
    const count = num(report?.reviews?.googleReviewCount) ?? 0;
    const screen = (n, label, body) => h("div", { class: "bs-col" }, [
      h("div", { class: "bs" }, [...body, pin(n, "at-top")]),
      h("p", { class: "bs-label", text: label }),
    ]);
    const arrow = () => h("span", { class: "bs-arrow", "aria-hidden": "true", text: "\u2192" });
    return h("div", { class: "bss" }, [
      screen(1, "They find you on Google", [
        h("p", { class: "bs-name", text: name }),
        h("p", { class: "bs-meta" }, [rating !== null ? `${rating.toFixed(1)} ` : "", starsFor(rating), ` (${count})`]),
        h("span", { class: "bs-book", text: "Book online" }),
      ]),
      arrow(),
      screen(2, "They pick a time", [
        h("p", { class: "bs-h", text: "Tuesday" }),
        h("div", { class: "bs-slots" }, ["9:00 AM", "11:00 AM", "2:00 PM", "4:00 PM"].map((t) => h("span", { class: t === "2:00 PM" ? "is-on" : "", text: t }))),
      ]),
      arrow(),
      screen(3, "It's in your calendar", [
        h("div", { class: "bs-cal" }, [
          h("p", { class: "bs-day" }, [h("span", { text: "TUE" }), h("b", { text: "14" })]),
          h("div", { class: "bs-ev" }, [h("b", { text: "2:00 PM" }), h("span", { text: "Kitchen sink" }), h("span", { class: "bs-new", text: "New booking" })]),
        ]),
      ]),
    ]);
  }

  // ---- Reserve with Google: booking from the listing
  function artBookFromGoogle(report) {
    const name = report?.profile?.name || "Your business";
    const slots = ["9:00 AM", "11:00 AM", "2:00 PM", "4:00 PM"];
    return h("div", { class: "bk" }, [
      h("div", { class: "bk-listing" }, [
        h("p", { class: "bk-name", text: name }),
        h("span", { class: "bk-btn" }, ["Book online", pin(1, "at-right")]),
      ]),
      h("div", { class: "bk-sheet" }, [
        h("p", { class: "bk-h", text: "Choose a time \u00b7 Tuesday" }),
        h("div", { class: "bk-slots" }, slots.map((t) => h("span", { class: t === "2:00 PM" ? "is-on" : "", text: t }))),
        pin(2, "at-right"),
      ]),
      h("div", { class: "bk-done" }, [
        h("span", { class: "bk-tick", text: "\u2713" }),
        h("span", { text: "Booked for Tuesday, 2:00 PM. It's in your calendar." }),
        pin(3, "at-right"),
      ]),
    ]);
  }

  // ---- one inbox: missed calls, Facebook, Instagram and the website form
  function artInbox(report) {
    const short = shortName(report?.profile?.name);
    const row = (src, cls, who, text, when, n) => h("div", { class: `ib-row ${cls}` }, [
      h("span", { class: "ib-src", text: src }),
      h("div", { class: "ib-body" }, [h("p", { class: "ib-who" }, [who, h("span", { class: "ib-when", text: when })]), h("p", { class: "ib-text", text })]),
      n ? pin(n, "at-right") : null,
    ].filter(Boolean));
    return h("div", { class: "ib" }, [
      h("p", { class: "ib-h", text: `${short} \u00b7 Inbox` }),
      row("Missed call", "is-call", "Mark T.", `Auto-reply: "Sorry we missed you, we're on a job. What do you need?"`, "8 sec later", 1),
      row("Facebook", "is-fb", "Dana R.", "Do you do water heaters? Mine is leaking.", "2 min", 2),
      row("Instagram", "is-ig", "Chris P.", "How soon could you come out?", "10 min", null),
      row("Website", "is-web", "Quote request", "Kitchen remodel, need a price this week.", "1 hr", 3),
    ]);
  }

  function renderPlanSteps(report, summary) {
    const p = report?.profile || {};
    const w = report?.website || {};
    const r = report?.ranking || {};
    const rv = report?.reviews || {};
    const a = answersNow();
    const count = num(rv.googleReviewCount) ?? 0;
    const rival = num(report?.signals?.topRivalReviews);
    const jobs = num(report?.leak?.jobs);
    const q = jobs ? Math.round(jobs * 3 * 0.25) : null;

    const gaps = [];
    if ((p.photoCount || 0) < 5) gaps.push("photos");
    if (!p.hasHours) gaps.push("opening hours");
    if (!w.found) gaps.push("a website link");

    const siteNow = !w.found ? "no website on your Google listing."
      : w.broken ? "your website doesn't load."
      : num(w.loadMs) !== null ? `your site takes ${(w.loadMs / 1000).toFixed(1)} seconds to load on a phone.`
      : null;
    const socialNow = w.broken || !w.found ? null
      : w.facebookUrl && w.yelpUrl ? "your site links to both your Facebook and Yelp pages."
      : w.facebookUrl ? "your site links to Facebook, but not to Yelp."
      : w.yelpUrl ? "your site links to Yelp, but not to Facebook."
      : "your site doesn't link to a Facebook or Yelp page.";

    const part = (n, title) => h("div", { class: `gp-part${n > 1 ? " is-next" : ""}` }, [h("span", { class: "gp-part-n", text: String(n) }), h("h3", { class: "gp-part-t", text: title })]);

    return [
      part(1, "Get Your Business Foundations in Place"),
      planSection({
        kicker: "Foundation 1",
        title: "A Website That Gets Calls",
        line: "The right pages, with call and book buttons on every one.",
        art: artSiteExample(),
        legend: ["Home: what you do, in 5 seconds", "About: real photos of your team", "Services: a page for every service", "Locations: a page for every town"],
        wide: true,
      }),
      planSection({
        kicker: "Foundation 2",
        title: "A Complete Google Business Profile",
        art: artGbp(report),
        legend: ["Real job photos every month", "Booking button and all services", "A new update every week", "Every review answered"],
      }),
      planSection({
        kicker: "Foundation 3",
        title: "The Same Details Everywhere",
        line: "Google checks. If they don't match, you rank lower.",
        art: artNap(report),
        legend: ["Same business name", "Same address", "Same phone number"],
        wide: true,
      }),

      part(2, "The System Top Contractors Use"),
      planSection({
        kicker: "Step 1",
        title: "Every Call and Message Answered",
        art: artCallsPhones(report),
        legend: ["You miss the call", "She calls the next company", "With DialBridge, she gets a text in seconds", "The job gets booked"],
        auto: true,
        wide: true,
      }),
      planSection({
        kicker: "Step 2",
        title: "Customers Book Straight From Google",
        art: artBookingScreens(report),
        legend: [],
        wide: true,
      }),
      planSection({
        kicker: "Step 3",
        title: "Every Quote Followed Up",
        art: artQuoteFlow(report),
        legend: [],
        note: "Our system checks in on every quote by text until you get a yes or a no.",
        auto: true,
        wide: true,
      }),
      planSection({
        kicker: "Step 4",
        title: "A Review Request After Every Job",
        art: artReviewPhone(report),
        legend: ["The request goes out on its own", "A new 5-star review on Google"],
        note: "Our system texts every customer your review link two hours after the job.",
        auto: true,
        wide: true,
      }),
      h("div", { class: "gp-loop" }, [
        h("div", { class: "gp-loop-row" }, ["More reviews", "Higher on Google", "More calls", "More jobs"].flatMap((t, i, arr) =>
          [h("span", { class: "gp-loop-s", text: t }), i < arr.length - 1 ? h("span", { class: "gp-loop-a", "aria-hidden": "true", text: "\u2192" }) : null]
        ).filter(Boolean)),
      ]),

      part(3, "What You Get"),
      planSection({
        kicker: "Result 1",
        title: "You Show Up at the Top of Google",
        art: artTopOfGoogle(report, { chat: false }),
        legend: ["Local Services Ads, pay per lead", "Top 3 on Google Maps"],
      }),
      planSection({
        kicker: "Result 2",
        title: "ChatGPT Recommends You",
        art: artChatGpt(report),
        legend: ["Your business named in the answer"],
      }),
      planSection({
        kicker: "Result 3",
        title: "Leads You Used to Miss Become Jobs",
        art: artPipeline(report),
        legend: ["Missed calls that turned into jobs", "Quotes still being followed up"],
        wide: true,
      }),
      renderPlanClose(report),
    ];
  }

  function renderPlanClose(report) {
    const g = report?.growth;
    const who = shortName(report?.profile?.name);
    return h("div", { class: "plan-close" }, [
      h("div", { class: "plan-ask" }, [
        h("h4", { text: `Get this set up for ${who}` }),
        h("p", { text: g
          ? `We build and run all of it for you. One more job a week at your ticket is ${money(g.perMonth)} a month. Reply to the text we sent you and we'll book a call.`
          : "We build and run all of it for you. Reply to the text we sent you and we'll book a call." }),
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
          h("p", { class: "prize-n", text: "One More Job a Week" }),
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
