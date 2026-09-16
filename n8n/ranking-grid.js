// The ranking map, built by us instead of by GHL.
//
// Lives in "DialBridge - Send Audit Report Email" (nq9f9GLkGaojuJc9) as three nodes:
//   Plan Rank Grid (Code)  ->  Rank At Point (HTTP, once per item)  ->  Collect Ranks (Code)
//
// Why we build it ourselves: GHL's prospecting heatmap needs a keyword set on it, and when
// none is set it stays "QUEUED" forever. We polled it for five minutes and then sent the
// email with an empty map, which is the one thing the email is for. Nine Places text
// searches around the business give the same answer in well under a second, and they land
// within a position or two of GHL's grid.
//
// Auth: an n8n credential of type "Query Auth" named "Google Maps Server Key", with
// parameter name `key` and the server key as its value. NOT an n8n Variable: Variables are
// a Pro-plan feature and the section does not exist on Starter. Query Auth works because
// Places API (New) accepts ?key= as well as the X-Goog-Api-Key header, so one credential
// serves both the grid and the static map, and the key never touches item data or a Code
// node. The parameter name is literally `key`, with no equals sign; n8n adds that itself.
//
// The key must be a SERVER key: no application restriction, restricted to Places API (New)
// and Maps Static API. The browser key the page uses is locked to a referrer and is refused
// server-side with "Requests from referer <empty> are blocked".
//
// The map image is fetched here and uploaded to GHL's media library, which returns a public
// CDN url on assets.cdn.filesafe.space that mail clients load with no auth. The email points
// at that, so no Google key is ever sitting in somebody's inbox waiting to be lifted.

// ============ Plan Rank Grid ============
// Nine points in a 3 x 3 grid, 3km apart, centred on the business. Each one becomes a
// search a homeowner in that spot would make.

const row = $input.first().json || {};
const parse = (v) => { if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } };
const report = parse(row.reportData);

const GRID = 3, SPACING_M = 3000;
const lat = Number(row.lat);
const lng = Number(row.lng);
const placeId = String(row.placeId || '');

// "plumber in Freehold" is what somebody actually types. The bare category is not.
const service = String(row.primaryType || (report && report.profile && report.profile.category) || '')
  .replace(/_/g, ' ').trim() || 'contractor';
const city = String(row.address || '').split(',')[1];
const query = city && city.trim() ? service + ' in ' + city.trim() : service;

let skip = '';
if (!Number.isFinite(lat) || !Number.isFinite(lng)) skip = 'no_coordinates';
else if (!placeId) skip = 'no_place_id';

if (skip) return [{ json: { skip, service, query, placeId, lat: 0, lng: 0, pointIndex: 0 } }];

const half = (GRID - 1) / 2;
const latStep = SPACING_M / 111320;
const lngStep = SPACING_M / (111320 * Math.cos((lat * Math.PI) / 180));
const out = [];
let i = 0;
for (let r = -half; r <= half; r++) {
  for (let c = -half; c <= half; c++) {
    out.push({ json: {
      pointIndex: i++,
      lat: Math.round((lat + r * latStep) * 1e6) / 1e6,
      lng: Math.round((lng + c * lngStep) * 1e6) / 1e6,
      query,
      service,
      placeId,
      centerLat: lat,
      centerLng: lng,
      spacingMiles: Math.round((SPACING_M / 1609) * 10) / 10,
      skip: ''
    } });
  }
}
return out;

// ============ Rank At Point (HTTP Request node) ============
// POST https://places.googleapis.com/v1/places:searchText
// Auth: Generic Credential Type -> Query Auth -> "Google Maps Server Key".
// Headers:
//   X-Goog-FieldMask: places.id,places.displayName,places.rating,places.userRatingCount
//   Content-Type: application/json
// Body: { textQuery, locationBias: { circle: { center: { latitude, longitude }, radius: 3000 } },
//         includePureServiceAreaBusinesses: true, pageSize: 20 }
// Never error, always output data, continue on error, so one dead point costs one pin
// rather than the whole map.

// ============ Collect Ranks ============
// Turns nine result lists into the shape the email already draws: a rank per point, the pins
// to plot, and who keeps turning up instead of them. A point we could not search is left
// null rather than counted as "not ranking", because those are different things.

const plan = $('Plan Rank Grid').all().map((i) => i.json);
const results = $input.all().map((i) => i.json);
const first = plan[0] || {};

if (first.skip) {
  return [{ json: { ranking: null, rankingError: first.skip } }];
}

const seen = new Map();
const points = [];
let failures = 0;

for (let i = 0; i < plan.length; i++) {
  const point = plan[i];
  const res = results[i] || {};
  const places = Array.isArray(res.places) ? res.places : null;

  if (!places) {
    failures++;
    points.push({ lat: point.lat, lng: point.lng, rank: null, failed: true });
    continue;
  }

  places.forEach((place, index) => {
    if (!place || !place.id || place.id === first.placeId) return;
    const rec = seen.get(place.id) || {
      name: (place.displayName && place.displayName.text) || '',
      rating: typeof place.rating === 'number' ? place.rating : null,
      reviewCount: place.userRatingCount || 0,
      appearances: 0,
      bestRank: 99
    };
    rec.appearances += 1;
    rec.bestRank = Math.min(rec.bestRank, index + 1);
    seen.set(place.id, rec);
  });

  const idx = places.findIndex((p) => p && p.id === first.placeId);
  points.push({ lat: point.lat, lng: point.lng, rank: idx >= 0 ? idx + 1 : null });
}

if (failures === plan.length) {
  const why = (results[0] && results[0].error && results[0].error.message) ? 'places_api_refused' : 'all_points_failed';
  return [{ json: { ranking: null, rankingError: why } }];
}

const ranks = points.filter((p) => !p.failed).map((p) => p.rank);
const ranked = ranks.filter((r) => r && r > 0);

return [{ json: {
  ranking: {
    keyword: first.service,
    query: first.query,
    status: 'COMPLETED',
    source: 'dialbridge',
    gridPoints: ranks.length,
    pointDistanceMiles: first.spacingMiles,
    averageRank: ranked.length ? Math.round((ranked.reduce((a, b) => a + b, 0) / ranked.length) * 10) / 10 : null,
    pointsInTop3: ranks.filter((r) => r && r <= 3).length,
    pointsNotRanked: ranks.filter((r) => !r).length,
    ranks,
    points: points.filter((p) => !p.failed),
    center: { lat: first.centerLat, lng: first.centerLng },
    topCompetitors: Array.from(seen.values())
      .sort((a, b) => b.appearances - a.appearances || a.bestRank - b.bestRank || b.reviewCount - a.reviewCount)
      .slice(0, 5)
      .map((c) => ({ name: c.name, rating: c.rating, reviewCount: c.reviewCount }))
  },
  rankingError: failures ? failures + '_points_failed' : ''
} }];
