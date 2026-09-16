// Paste into the "Build Email HTML" Code node of the n8n workflow
// "DialBridge - Send Audit Report Email" (nq9f9GLkGaojuJc9).
//
// Changes from the first version:
//  - The Google Maps ranking image is the hero. Static Maps answers without a referrer,
//    so the mail client's image proxy can load it straight from the URL. No hosting, and
//    no more coloured squares standing in for a map.
//  - Nothing is said twice. The numbers live in one row, the findings say what they mean,
//    and the Blueprint says what to do. Previously all three repeated each other.
//  - No PDF. Delete the "Report To PDF" node and wire Build Email HTML straight into
//    "Send Email Through GHL", then drop the attachments field from its body.
const row = $('Load Submission').first().json;
const ready = $input.first().json;
const data = ready.report || {};
const s = ready.summary || {};
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const KEY = 'GOOGLE_STATIC_MAPS_KEY'; // same browser key the page uses

const INK = '#0f1b2d', INK2 = '#44526a', ACCENT = '#e8702a';
const GOOD = '#1f7a4d', WARN = '#b8860b', BAD = '#a33a22', RULE = '#dde2e8';
const biz = data.profile?.name || row.businessName || 'your business';
const r = data.ranking || {}, ls = data.listings || {}, w = data.website || {}, rv = data.reviews || {};

// ---- the map, exactly as the page draws it ----
function mapUrl() {
  const points = (r.points || []).filter((p) => n(p.lat) !== null && n(p.lng) !== null);
  if (!points.length) return '';
  const parts = ['size=640x420', 'scale=2', 'maptype=roadmap', 'format=png'];
  if (r.center && n(r.center.lat) !== null) {
    parts.push('markers=' + encodeURIComponent(`color:0x0f1b2d|label:H|${r.center.lat},${r.center.lng}`));
  }
  for (const p of points) {
    const rank = n(p.rank);
    const color = !rank || rank > 10 ? '0xa33a22' : rank <= 3 ? '0x1f7a4d' : '0xe8702a';
    const label = rank && rank <= 9 ? String(rank) : 'X';
    parts.push('markers=' + encodeURIComponent(`color:${color}|label:${label}|${p.lat},${p.lng}`));
  }
  parts.push('key=' + encodeURIComponent(KEY));
  return 'https://maps.googleapis.com/maps/api/staticmap?' + parts.join('&');
}

const map = mapUrl();
const mapLine = r.pointsInTop3
  ? `You are in the top 3 at ${r.pointsInTop3} of ${r.gridPoints} spots. Green is top 3, orange is 4 to 10, red means customers there never see you.`
  : `You are not in the top 3 at any of the ${r.gridPoints} spots we checked. Every one of those searches puts another company in front of you.`;

// ---- one row of numbers, said once ----
const tiles = [
  n(rv.googleRating) !== null ? { v: `${rv.googleRating}`, l: `stars from ${rv.googleReviewCount || 0} reviews`, c: rv.googleRating >= 4.5 ? GOOD : WARN } : null,
  Array.isArray(r.ranks) && r.ranks.length ? { v: `${r.pointsInTop3}/${r.ranks.length}`, l: 'spots in the top 3', c: r.pointsInTop3 >= r.ranks.length / 2 ? GOOD : BAD } : null,
  n(ls.checked) ? { v: `${ls.found}/${ls.checked}`, l: 'directories list you', c: ls.missing > ls.found ? BAD : GOOD } : null,
  n(w.mobileScore) !== null ? { v: `${w.mobileScore}`, l: 'website speed on a phone', c: w.mobileScore >= 70 ? GOOD : w.mobileScore >= 50 ? WARN : BAD } : null,
].filter(Boolean);

const tileRow = tiles.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tiles
  .map((t) => `<td align="center" style="padding:14px 6px;">
      <p style="margin:0;font:800 24px Arial,Helvetica,sans-serif;color:${t.c};">${esc(t.v)}</p>
      <p style="margin:4px 0 0;font:400 12px Arial,Helvetica,sans-serif;color:${INK2};line-height:1.35;">${esc(t.l)}</p>
    </td>`).join('')}</tr></table>` : '';

// ---- findings: what those numbers cost, no fix lines (the Blueprint does that) ----
const findings = (s.findings || []).slice(0, 3).map((f, i) => `<tr><td style="padding:0 0 14px;">
    <p style="margin:0 0 4px;font:700 15px Arial,Helvetica,sans-serif;color:${INK};">${i + 1}. ${esc(f.title)}</p>
    <p style="margin:0;font:400 14px/1.55 Arial,Helvetica,sans-serif;color:${INK2};">${esc(f.detail)}</p>
  </td></tr>`).join('');

// ---- the Blueprint: the offer, explained as the work behind the findings ----
const has = (area) => (s.findings || []).some((f) => f.area === area);
const steps = [
  has('lead_follow_up') ? ['Catch every call, day or night', 'A missed call gets a text back in seconds and the conversation keeps going until the job is booked.'] : null,
  has('reviews') || has('map_ranking') ? ['Turn finished jobs into reviews', 'Every customer gets asked by text right after the work. More reviews lift where you sit on the map.'] : null,
  has('website') ? ['A site that loads fast and asks for the job', 'Opens quickly on a phone, your number one tap away, and a form that reaches you instantly.'] : null,
  has('listings') || has('google_profile') ? ['One set of business details everywhere', 'Your profile and every listing say the same thing, so Google trusts you and customers reach the right number.'] : null,
].filter(Boolean).slice(0, 4);

const blueprint = steps.length ? steps.map(([title, body], i) => `<tr><td style="padding:0 0 14px;">
    <p style="margin:0 0 3px;font:700 15px Arial,Helvetica,sans-serif;color:${INK};">${i + 1}. ${esc(title)}</p>
    <p style="margin:0;font:400 14px/1.55 Arial,Helvetica,sans-serif;color:${INK2};">${esc(body)}</p>
  </td></tr>`).join('') : '';

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lost Job Report for ${esc(biz)}</title></head>
<body style="margin:0;background:#f6f7f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#fff;border-radius:14px;overflow:hidden;">

  <tr><td style="padding:20px 30px;background:${INK};"><p style="margin:0;font:800 18px Arial,Helvetica,sans-serif;color:#fff;">DialBridge</p></td></tr>

  <tr><td style="padding:28px 30px 4px;border-top:4px solid ${ACCENT};">
    <p style="margin:0 0 6px;font:700 11px Arial,Helvetica,sans-serif;color:${ACCENT};letter-spacing:.1em;">LOST JOB REPORT</p>
    <h1 style="margin:0 0 10px;font:800 25px/1.2 Arial,Helvetica,sans-serif;color:${INK};">${esc(biz)}</h1>
    <p style="margin:0;font:400 15px/1.6 Arial,Helvetica,sans-serif;color:${INK2};">${esc(s.headline || '')}</p>
  </td></tr>

  ${map ? `<tr><td style="padding:20px 30px 6px;">
    <img src="${map}" width="580" alt="Where you rank on Google Maps around your service area" style="display:block;width:100%;max-width:580px;border-radius:12px;border:1px solid ${RULE};" />
    <p style="margin:10px 0 0;font:400 13px/1.5 Arial,Helvetica,sans-serif;color:${INK2};">${esc(mapLine)}</p>
  </td></tr>` : ''}

  ${tileRow ? `<tr><td style="padding:10px 24px 6px;border-top:1px solid ${RULE};">${tileRow}</td></tr>` : ''}

  ${findings ? `<tr><td style="padding:22px 30px;border-top:1px solid ${RULE};">
    <h2 style="margin:0 0 14px;font:700 17px Arial,Helvetica,sans-serif;color:${INK};">What this is costing you</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${findings}</table>
  </td></tr>` : ''}

  ${blueprint ? `<tr><td style="padding:22px 30px;border-top:1px solid ${RULE};background:#fcfbf9;">
    <p style="margin:0 0 4px;font:700 11px Arial,Helvetica,sans-serif;color:${ACCENT};letter-spacing:.1em;">GROWTH PLAN BLUEPRINT</p>
    <h2 style="margin:0 0 6px;font:700 17px Arial,Helvetica,sans-serif;color:${INK};">How this gets fixed without hiring anyone</h2>
    <p style="margin:0 0 16px;font:400 14px/1.6 Arial,Helvetica,sans-serif;color:${INK2};">Every line above is work somebody has to do daily: answer the phone, chase the quote, ask for the review, keep the listings straight. This is that work, done by a system instead of another salary.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${blueprint}</table>
    <p style="margin:14px 0 0;font:400 13px/1.55 Arial,Helvetica,sans-serif;color:${INK2};">You keep everything we build. The site, the profile, the number, the reviews.</p>
  </td></tr>` : ''}

  <tr><td style="padding:26px 30px;background:${INK};">
    <h2 style="margin:0 0 8px;font:700 17px Arial,Helvetica,sans-serif;color:#fff;">Want me to walk you through it?</h2>
    <p style="margin:0 0 18px;font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#c9d0da;">Fifteen minutes, this report open in front of us, and I will show you which piece I would fix first.</p>
    <a href="https://www.dialbridge.ai" style="display:inline-block;padding:14px 26px;background:${ACCENT};border-radius:10px;font:700 15px Arial,Helvetica,sans-serif;color:#fff;text-decoration:none;">Book a 15 minute call</a>
  </td></tr>

  <tr><td style="padding:20px 30px;">
    <p style="margin:0 0 4px;font:400 14px/1.6 Arial,Helvetica,sans-serif;color:${INK2};">Or just reply to this email.</p>
    <p style="margin:0;font:700 14px Arial,Helvetica,sans-serif;color:${INK};">Matviy Korsunskiy</p>
    <p style="margin:2px 0 0;font:400 12px Arial,Helvetica,sans-serif;color:#7b879a;">DialBridge &middot; Ranking, reviews and business details from Google.</p>
  </td></tr>

</table></td></tr></table></body></html>`;

return [{ json: {
  submissionId: ready.submissionId,
  contactId: ready.contactId,
  email: ready.email,
  business: biz,
  subject: `${biz}: where you rank on Google, and what it is costing you`,
  html,
} }];
