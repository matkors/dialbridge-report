// Paste into the "Detect Website Tech" Code node of "DialBridge - Audit Report Builder
// (GHL)" (NV082ePpGt0zarIL), replacing what is there. The node upstream of it,
// "Fetch Website HTML", already puts the page source on `json.html`.
//
// Four checks a speed test cannot answer, all read from the page source:
//   1. Stale site      a copyright year or newest date years in the past
//   2. Click to call    whether a phone on a phone is actually tappable
//   3. Contact path     whether there is any form or email at all
//   4. Paying for ads   ad tracking present while their own answers say leads leak
//
// Everything is a plain string search. No parser, no dependency, and if the fetch failed
// the page source is empty and every check comes back null instead of a wrong answer.
const src = $('Add Map Pins').first().json;
const data = src.reportData;
const res = $input.first().json || {};
const html = typeof res.html === 'string' ? res.html.slice(0, 600000) : '';
const website = data.website || {};

if (html && website.url) {
  const has = (re) => re.test(html);

  // --- tracking and chat, as before ---
  website.googleAnalytics = has(/gtag\(|googletagmanager\.com\/gtag|google-analytics\.com\/(analytics|ga)\.js|['"]G-[A-Z0-9]{6,}/i);
  website.googleTags = has(/googletagmanager\.com\/gtm\.js|['"]GTM-[A-Z0-9]{4,}/i);
  website.facebookPixel = has(/connect\.facebook\.net\/[^'"]*fbevents\.js|fbq\s*\(/i);
  website.chatWidget = has(/tawk\.to|intercom(cdn|\.io)|drift\.com|livechatinc|crisp\.chat|tidio|zdassets|zopim|leadconnectorhq\.com\/chat|podium\.com|birdeye/i);

  // --- 1. is anyone still looking after this site? ---
  // Take the newest year the page mentions in a copyright or date, and compare to now.
  const thisYear = new Date().getFullYear();
  const years = [...html.matchAll(/(?:©|&copy;|copyright[^0-9]{0,20})\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/gi)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 2000 && y <= thisYear);
  const newestYear = years.length ? Math.max(...years) : null;
  website.copyrightYear = newestYear;
  website.yearsStale = newestYear ? thisYear - newestYear : null;

  // --- 2. can a customer tap to call from their phone? ---
  const telLinks = [...html.matchAll(/href\s*=\s*['"]tel:([^'"]+)/gi)].map((m) => m[1].replace(/\D/g, ''));
  website.clickToCall = telLinks.length > 0;
  // Does the tappable number match the one Google has? A wrong number is worse than none.
  const googlePhone = String(data.profile?.phone || '').replace(/\D/g, '').slice(-10);
  website.callNumberMatchesGoogle = telLinks.length && googlePhone
    ? telLinks.some((t) => t.slice(-10) === googlePhone)
    : null;

  // --- 3. any way to reach them other than the phone? ---
  website.hasForm = has(/<form[\s>]/i) || has(/(typeform|jotform|hubspot|gravityform|wpforms|formspree)/i);
  website.hasEmailLink = has(/href\s*=\s*['"]mailto:/i);

  // --- 4. are they paying for clicks while leads leak? ---
  website.googleAdsTracking = has(/['"]AW-\d{6,}|googleadservices\.com|gtag\/js\?id=AW-/i);
  website.adsRunning = website.googleAdsTracking || website.facebookPixel;

  website.techCheckedBy = 'dialbridge';
}

data.website = website;

// Review replies are the one thing Google's public API will not give us, so keep GHL's
// numbers when its scan finished, and say nothing when it did not.
const reviewsDone = String(data.reviews && data.reviews.status || '').toUpperCase() === 'COMPLETED';
if (!reviewsDone && data.reviews) {
  data.reviews = {
    status: data.reviews.status || 'PENDING',
    pending: true,
    googleRating: data.reviews.googleRating,
    googleReviewCount: data.reviews.googleReviewCount,
  };
  data.grades = (data.grades || []).filter((g) => !/reputation|review/i.test(g.name || ''));
}

const notes = [];
if (!reviewsDone) {
  notes.push('The review scan has not finished. reviews.googleRating and reviews.googleReviewCount are real, everything else about reviews is unknown. Do not say the business has no reviews, none visible, or no replies. Do not make reviews a finding at all.');
}

const { reportId, submissionId, contactId, placeId, ...promptFacts } = data;

return [{ json: {
  reportData: data,
  systemPrompt: notes.length ? src.systemPrompt + '\n\nThis report:\n- ' + notes.join('\n- ') : src.systemPrompt,
  promptData: JSON.stringify(promptFacts),
} }];
