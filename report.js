// Full report shown on the same page, right under the scan. After the page sends the
// business to n8n, we poll the status endpoint with our submission id. n8n runs the deeper
// audit and writes the plain-English summary, and this draws it as soon as it lands.
(() => {
  "use strict";

  const STATUS_URL = () => window.DIALBRIDGE_CONFIG?.N8N_REPORT_STATUS_URL || "";
  const POLL_MS = 4000;
  const MAX_MS = 12 * 60 * 1000; // audits with a slow review scan can take several minutes

  const $ = (id) => document.getElementById(id);
  const h = (...args) => window.DialBridgeScan.h(...args);

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

  const SEVERITY_TONE = { high: "bad", medium: "warn", low: "good" };

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

  function scoreTone(score) {
    if (typeof score !== "number") return "warn";
    return score >= 80 ? "good" : score >= 50 ? "warn" : "bad";
  }

  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  // ============ SECTIONS ============

  function renderHeadline(summary, report) {
    const score = num(report?.overallScore);
    return h("header", { class: "report-head" }, [
      h("div", { class: `score-ring tone-${scoreTone(score)}`, style: `--pct:${score ?? 0}` },
        h("span", {}, [h("strong", { text: score ?? "?" }), h("small", { text: "out of 100" })])),
      h("div", { class: "report-head-text" }, [
        h("h2", { text: summary?.headline || "Here's where you're losing jobs online" }),
        summary?.summary ? h("p", { text: summary.summary }) : null,
      ]),
    ]);
  }

  function renderGrades(report) {
    const grades = (report?.grades || []).filter((g) => !/overall/i.test(g.name || "") && num(g.score) !== null);
    if (!grades.length) return null;
    return h("section", { class: "report-block" }, [
      h("h3", { text: "Your scores" }),
      h("ul", { class: "grade-list" }, grades.map((g) =>
        h("li", { class: `grade tone-${g.level === "success" ? "good" : g.level === "warning" ? "warn" : "bad"}` }, [
          h("span", { class: "grade-name", text: GRADE_LABELS[g.name] || g.name }),
          h("span", { class: "grade-bar" }, h("span", { class: "grade-fill", style: `width:${Math.max(2, Math.min(100, g.score))}%` })),
          h("span", { class: "grade-score", text: String(g.score) }),
        ])
      )),
    ]);
  }

  function renderFindings(summary) {
    const findings = summary?.findings || [];
    if (!findings.length) return null;
    return h("section", { class: "report-block" }, [
      h("h3", { text: "What's costing you jobs" }),
      h("ol", { class: "report-findings" }, findings.map((f) =>
        h("li", { class: `report-finding tone-${SEVERITY_TONE[f.severity] || "warn"}` }, [
          h("p", { class: "report-finding-head" }, [
            h("strong", { text: f.title || "" }),
            f.area ? h("span", { class: "report-area", text: AREA_LABELS[f.area] || String(f.area).replace(/_/g, " ") }) : null,
          ]),
          f.detail ? h("p", { text: f.detail }) : null,
          f.fix ? h("p", { class: "report-fix", text: `Fix: ${f.fix}` }) : null,
        ])
      )),
    ]);
  }

  function renderRanking(report) {
    const r = report?.ranking;
    if (!r || !Array.isArray(r.ranks) || !r.ranks.length) return null;
    const competitors = r.topCompetitors || [];
    return h("section", { class: "report-block" }, [
      h("h3", { text: `Where you show up for "${r.keyword}"` }),
      h("div", { class: "rank-grid", "aria-hidden": "true" }, r.ranks.map((rank) =>
        h("span", { class: `rank-cell tone-${!rank || rank > 10 ? "bad" : rank <= 3 ? "good" : "warn"}`, text: rank ? String(rank) : "20+" })
      )),
      h("p", { class: "muted", text: `Your position on Google Maps at ${r.gridPoints} points around your business. You are in the top 3 at ${r.pointsInTop3} of them.` }),
      competitors.length
        ? h("table", { class: "cmp" }, [
            h("thead", {}, h("tr", {}, [h("th", { text: "Competing nearby" }), h("th", { text: "Rating" }), h("th", { text: "Reviews" })])),
            h("tbody", {}, competitors.map((c) =>
              h("tr", {}, [
                h("td", { text: c.name || "" }),
                h("td", { text: num(c.rating) !== null ? `${c.rating.toFixed(1)}★` : "None" }),
                h("td", { text: String(c.reviewCount ?? 0) }),
              ])
            )),
          ])
        : null,
    ]);
  }

  function renderReviews(report) {
    const rv = report?.reviews;
    if (!rv || num(rv.googleReviewCount) === null) return null;
    const items = [
      { ok: true, text: `${rv.googleRating ?? "?"}★ from ${rv.googleReviewCount} Google reviews` },
      num(rv.unansweredCount) !== null
        ? { ok: rv.unansweredCount === 0, text: rv.unansweredCount === 0 ? "Every review has a reply" : `${rv.unansweredCount} reviews with no reply from you` }
        : null,
      rv.lastReviewAt ? { ok: true, text: `Last review came in on ${rv.lastReviewAt}` } : null,
      num(rv.facebookReviewCount) !== null
        ? { ok: rv.facebookReviewCount > 0, text: rv.facebookReviewCount > 0 ? `${rv.facebookReviewCount} Facebook reviews` : "No reviews on Facebook" }
        : null,
    ].filter(Boolean);
    return h("section", { class: "report-block" }, [
      h("h3", { text: "Your reputation" }),
      h("ul", { class: "checks" }, items.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
    ]);
  }

  function renderListings(report) {
    const l = report?.listings;
    if (!l || !num(l.checked)) return null;
    return h("section", { class: "report-block" }, [
      h("h3", { text: "Where your business is listed" }),
      h("p", { class: `badge badge-${l.missing > l.found ? "bad" : "warn"}`, text: `Found on ${l.found} of ${l.checked} directories, missing from ${l.missing}` }),
      (l.missingOn || []).length ? h("p", { class: "muted", text: `Missing on: ${l.missingOn.join(", ")}` }) : null,
      (l.partialOn || []).length ? h("p", { class: "muted", text: `Wrong or incomplete on: ${l.partialOn.join(", ")}` }) : null,
    ]);
  }

  function renderWebsite(report) {
    const w = report?.website;
    if (!w) return null;
    if (!w.found || !w.url) {
      return h("section", { class: "report-block" }, [
        h("h3", { text: "Your website" }),
        h("p", { class: "badge badge-bad", text: "No working website found" }),
      ]);
    }
    const checks = [
      num(w.mobileScore) !== null ? { ok: w.mobileScore >= 50, text: `Phone speed score ${w.mobileScore} out of 100${w.mobileLoadTime ? `, main content in ${w.mobileLoadTime}` : ""}` } : null,
      w.https === null || w.https === undefined ? null : { ok: w.https, text: w.https ? "Secure (HTTPS)" : "Not secure, browsers warn visitors" },
      w.googleAnalytics === null || w.googleAnalytics === undefined ? null : { ok: w.googleAnalytics, text: w.googleAnalytics ? "Visitor tracking is set up" : "No visitor tracking, you can't see where leads come from" },
      w.facebookPixel === null || w.facebookPixel === undefined ? null : { ok: w.facebookPixel, text: w.facebookPixel ? "Facebook ad tracking is set up" : "No Facebook ad tracking" },
      w.chatWidget === null || w.chatWidget === undefined ? null : { ok: w.chatWidget, text: w.chatWidget ? "Visitors can message you from the site" : "No way to message you from the site" },
    ].filter(Boolean);
    return h("section", { class: "report-block" }, [
      h("h3", { text: "Your website" }),
      h("p", { class: "live-domain", text: w.url.replace(/^https?:\/\//i, "").replace(/\/$/, "") }),
      h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : "bad", text: c.text }))),
    ]);
  }

  function renderStrengths(summary) {
    const strengths = summary?.strengths || [];
    if (!strengths.length) return null;
    return h("section", { class: "report-block" }, [
      h("h3", { text: "What's already working" }),
      h("ul", { class: "checks" }, strengths.map((s) => h("li", { class: "ok", text: s }))),
    ]);
  }

  function renderNextStep(summary) {
    if (!summary?.nextStep && !summary?.answersInsight) return null;
    return h("section", { class: "report-block report-next" }, [
      summary.answersInsight ? h("p", { text: summary.answersInsight }) : null,
      summary.nextStep ? h("p", { class: "report-cta", text: summary.nextStep }) : null,
    ]);
  }

  function render(payload) {
    const { report, summary } = payload;
    const body = $("reportBody");
    if (!body) return;
    body.replaceChildren(
      ...[
        renderHeadline(summary, report),
        renderFindings(summary),
        renderGrades(report),
        renderRanking(report),
        renderReviews(report),
        renderListings(report),
        renderWebsite(report),
        renderStrengths(summary),
        renderNextStep(summary),
      ].filter(Boolean)
    );
    body.hidden = false;
    setStatus("");
    $("report").hidden = false;
    body.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
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
    setStatus("");
  }

  window.DialBridgeReport = { start, reset, render };
})();
