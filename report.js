// Full report shown on the same page, right under the scan. After the page sends the
// business to n8n, we poll the status endpoint with our submission id. n8n runs the deeper
// audit and writes the plain-English summary, and this draws it as soon as it lands.
(() => {
  "use strict";

  // The page builds its own report now. The status endpoint stays in n8n, switched off,
  // for the day we want to merge the emailed audit's listings back into the page.
  const STATUS_URL = () => window.DIALBRIDGE_CONFIG?.N8N_REPORT_STATUS_URL || "";
  const EMAIL_URL = () => window.DIALBRIDGE_CONFIG?.N8N_REPORT_EMAIL_URL || "";
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
    return h("header", { class: "report-hero" }, [
      h("div", { class: "report-hero-top" }, [
        scoreRing(report?.overallScore, "out of 100"),
        h("div", { class: "report-hero-text" }, [
          h("p", { class: "eyebrow", text: [p.name, p.category].filter(Boolean).join(" · ") }),
          h("h2", { text: summary?.headline || "Here's where you're losing jobs online" }),
          summary?.summary ? h("p", { class: "lead", text: summary.summary }) : null,
        ]),
      ]),
      statChips(report),
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
      h("div", { class: "card-head" }, [h("h3", { text: "What's costing you jobs" })]),
      h("ol", { class: "findings-list" }, findings.map((f, i) => {
        const severity = SEVERITY[f.severity] || SEVERITY.medium;
        return h("li", { class: `finding-card tone-${severity.tone}` }, [
          h("span", { class: "finding-num", "aria-hidden": "true", text: String(i + 1) }),
          h("div", { class: "finding-main" }, [
            h("div", { class: "finding-head" }, [
              h("strong", { text: f.title || "" }),
              h("span", { class: `pill tone-${severity.tone}`, text: severity.label }),
            ]),
            f.area ? h("p", { class: "finding-area", text: AREA_LABELS[f.area] || String(f.area).replace(/_/g, " ") }) : null,
            f.detail ? h("p", { text: f.detail }) : null,
            f.fix ? h("p", { class: "finding-fix" }, [h("span", { text: "What fixes it: " }), f.fix]) : null,
          ]),
        ]);
      })),
    ]);
  }

  function renderGrades(report) {
    const grades = (report?.grades || []).filter((g) => !/overall/i.test(g.name || "") && num(g.score) !== null);
    if (!grades.length) return null;
    return h("section", { class: "card card-wide" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "Your scores" })]),
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
    if (!rv || num(rv.googleReviewCount) === null) return null;
    // Published before the review scan finished: show what Google gives us and say so,
    // rather than an empty card or a wrong "no reviews" claim.
    if (rv.pending) {
      const local = window.scanResult?.profile;
      const recent = (local?.reviews || []).slice(0, 2);
      return h("section", { class: "card" }, [
        h("div", { class: "card-head" }, [
          h("h3", { text: "Your reputation" }),
          h("span", { class: `pill tone-${rv.googleRating >= 4.5 ? "good" : "warn"}`, text: `${rv.googleRating ?? "?"}★ from ${rv.googleReviewCount} reviews` }),
        ]),
        ...recent.map((r) => h("p", { class: "muted", text: `"${r.text.slice(0, 140)}" ${r.author}, ${r.when}` })),
        h("p", { class: "muted", text: "We're still reading through every review. The full breakdown, including which ones you never replied to, comes with your report." }),
      ]);
    }
    const leader = (report.competitors || [])[0];
    const items = [
      num(rv.googleRating) !== null
        ? { ok: rv.googleRating >= 4.5, text: `${rv.googleRating} stars from ${rv.googleReviewCount} Google reviews` }
        : null,
      leader && num(leader.reviewCount) !== null
        ? { ok: (rv.googleReviewCount || 0) >= leader.reviewCount, text: `${leader.name} has ${leader.reviewCount} reviews` }
        : null,
      num(rv.unansweredCount) !== null
        ? { ok: rv.unansweredCount === 0, text: rv.unansweredCount === 0 ? "Every review has a reply" : `${rv.unansweredCount} reviews with no reply from you` }
        : null,
      num(rv.replyRatePercent) !== null ? { ok: rv.replyRatePercent >= 80, text: `You reply to ${rv.replyRatePercent}% of reviews` } : null,
      rv.lastReviewAt ? { ok: true, text: `Last review came in on ${rv.lastReviewAt}` } : null,
      num(rv.facebookReviewCount) !== null
        ? { ok: rv.facebookReviewCount > 0, text: rv.facebookReviewCount > 0 ? `${rv.facebookReviewCount} Facebook reviews` : "No reviews on Facebook" }
        : null,
    ].filter(Boolean);
    return h("section", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "Your reputation" }),
        h("span", { class: `pill tone-${rv.googleRating >= 4.5 ? "good" : "warn"}`, text: `${rv.googleRating ?? "?"}★ from ${rv.googleReviewCount} reviews` }),
      ]),
      h("ul", { class: "checks" }, items.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
      ...(rv.recent || []).slice(0, 2).map((r) =>
        h("p", { class: "muted", text: `"${String(r.text || "").slice(0, 130)}" ${r.author || ""}${r.when ? `, ${r.when}` : ""}` })
      ),
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
    const checks = [
      w.https === null || w.https === undefined ? null : { ok: w.https, text: w.https ? "Secure (HTTPS)" : "Not secure, browsers warn visitors" },
      w.mobileFriendly === null || w.mobileFriendly === undefined ? null : { ok: w.mobileFriendly, text: w.mobileFriendly ? "Fits a phone screen" : "Doesn't fit a phone screen" },
      w.googleAnalytics === null || w.googleAnalytics === undefined ? null : { ok: w.googleAnalytics, text: w.googleAnalytics ? "Visitor tracking is set up" : "No visitor tracking, you can't see where leads come from" },
      w.facebookPixel === null || w.facebookPixel === undefined ? null : { ok: w.facebookPixel, text: w.facebookPixel ? "Facebook ad tracking is set up" : "No Facebook ad tracking" },
      w.chatWidget === null || w.chatWidget === undefined ? null : { ok: w.chatWidget, text: w.chatWidget ? "Visitors can message you from the site" : "No way to message you from the site" },
    ].filter(Boolean);
    return h("section", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "Your website" }),
        w.mobileLoadTime ? h("span", { class: `pill tone-${num(w.mobileScore) >= 50 ? "good" : "bad"}`, text: `Loads in ${w.mobileLoadTime}` }) : null,
      ]),
      h("div", { class: "web-row" }, [
        h("div", { class: "web-rings" }, [
          scoreRing(w.mobileScore, "on a phone", "sm"),
          num(w.desktopScore) !== null ? scoreRing(w.desktopScore, "on a computer", "sm") : null,
        ].filter(Boolean)),
        h("div", { class: "web-copy" }, [
          h("p", { class: "live-domain", text: domainOf(w.url) }),
          w.mobileLoadTime || w.desktopLoadTime
            ? h("p", { class: "muted", text: [
                w.mobileLoadTime ? `Phone: main content in ${w.mobileLoadTime}` : "",
                w.desktopLoadTime ? `Computer: ${w.desktopLoadTime}` : "",
              ].filter(Boolean).join(" · ") })
            : null,
          h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
        ]),
      ]),
    ]);
  }

  function renderStrengths(summary) {
    const strengths = summary?.strengths || [];
    if (!strengths.length) return null;
    return h("section", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h3", { text: "What's already working" })]),
      h("ul", { class: "checks" }, strengths.map((s) => h("li", { class: "ok", text: s }))),
    ]);
  }

  function renderNextStep(summary) {
    if (!summary?.nextStep && !summary?.answersInsight) return null;
    return h("section", { class: "card card-wide card-cta" }, [
      h("h3", { text: "What to do next" }),
      summary.answersInsight ? h("p", { text: summary.answersInsight }) : null,
      summary.nextStep ? h("p", { class: "cta-line", text: summary.nextStep }) : null,
    ]);
  }


  // The ranking map is the reason to hand over an email, so it is never built or shown here.
  // We describe it, take the email, and GHL emails the full report with the map in it.
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
        h("p", { class: "gate-fine", text: "One email with your report. No spam." }),
      ]),
    ]);
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

    body.replaceChildren(
      ...[
        renderHero(summary, report),
        renderFindings(summary),
        report?.ranking ? renderRanking(report) : renderMapGate(),
        h("div", { class: "card-grid" }, [
          renderReviews(report),
          renderWebsite(report),
          renderListings(report),
          renderStrengths(summary),
        ].filter(Boolean)),
        renderGrades(report),
        renderNextStep(summary),
        h("p", { class: "report-restart" }, h("button", { class: "link", type: "button", id: "reportRestart", text: "Check a different business" })),
      ].filter(Boolean)
    );
    body.hidden = false;
    setStatus("");
    $("report").hidden = false;
    $("reportRestart")?.addEventListener("click", () => window.DialBridgeScan.reset());
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

  window.DialBridgeReport = { start, reset, render, showLocal };
})();
