# What one Lost Job Report costs

Checked 2026-09-17 against Google's published SKU list and verified against live runs.
Every number below is per **one business**, start to finish.

## The short version

| | Per audit | Free each month |
|---|---|---|
| Google Maps Platform | **$0.064** | first ~1,000 audits |
| GHL (one text) | **$0.0115** | nothing, it is pass-through |
| n8n | 4 executions | 2,500 on Starter, so ~625 audits |
| PageSpeed Insights | $0 | 25,000 calls a day |
| **Total** | **~$0.076** | **$0 for the first ~1,000 a month** |

A "full" audit means someone searches their business, answers the four questions, gets the
report and unlocks it with a texted code. Somebody who scans and walks away at the gate
costs the same **$0.064** in Google calls and 2 n8n executions: the whole audit, ranking map
included, is built before the gate goes up.

**The 2026-09-17 change moved the ranking map onto the page and free.** It used to be the
reward for an email address, built server side and posted out; the email step is gone and
every lead gets the map in the report. The Google bill did not move, because the nine grid
searches were already free and the static map that draws them was already counted. What went
away was the email itself, two n8n workflows per lead, and the six-minute wait.

## Every call we make, and what Google charges for it

Google prices Places calls by the **most expensive field you ask for**, not by the endpoint.
That single fact is where all the money is: the same search costs $0.00 or $35.00 per 1,000
depending on the field mask. Tiers go Essentials (IDs Only) → Essentials → Pro → Enterprise
→ Enterprise + Atmosphere.

| What runs | When | Count | SKU it lands in | Per 1,000 | Free/month | Cost here |
|---|---|---|---|---|---|---|
| Autocomplete | as they type | ~3 | Autocomplete (Included with Place Details) | **$0** | unlimited | $0 |
| Place Details | on selecting the business | 1 | Place Details **Enterprise + Atmosphere** | $25.00 | 1,000 | $0.025 |
| Nearby Search | competitors, during the scan | 1 | Nearby Search **Enterprise** | $35.00 | 1,000 | $0.035 |
| Static Maps | competitor map on the scan screen | 1 | Static Maps | $2.00 | 10,000 | $0.002 |
| Text Search | the whole ranking grid, from the browser | 9 | Text Search **Essentials (IDs Only)** | **$0** | unlimited | $0 |
| Static Maps | the ranking map in the report | 1 | Static Maps | $2.00 | 10,000 | $0.002 |
| PageSpeed Insights | phone + desktop speed test | 2 | not a Maps SKU | $0 | 25,000/day | $0 |

**Google total: $0.064 per audit.** A pure service-area business has no pin for the grid to
search around, so it gets the rest of the report and no map, and costs $0.062. The page
cannot geocode its way to a centre the way the old email path did, so **Geocoding is no
longer on the per-audit path at all**.

Re-measuring on a second keyword (the "do you do more than one trade?" control on the map
card) is another nine free Text Search calls plus one more Static Maps request, so **$0.002
per click**. There is no per-audit cap on it; if that ever matters, the Static Maps daily
quota below is the backstop.

The nine grid searches run on the **browser** key now, not the server key. The field mask is
`places.id` and nothing else, which is the only Places mask Google does not bill for; adding
a name or a rating to it would put all nine calls on a paid SKU and turn a free feature into
the most expensive thing on this page. The rival names in the map table come from the Nearby
Search the scan has already paid for, matched by place ID.

Why the autocomplete is free: every keystroke goes out with a session token, and the session
ends in a Place Details call. Google then bills those keystrokes under "Autocomplete
(Included with Place Details)", which is free at any volume. Break the session token and
they become $2.83 per 1,000.

## Where the free tier actually runs out

Since March 2025 there is no shared $200 credit. Each SKU has its own monthly allowance:
**10,000 calls for Essentials, 5,000 for Pro, 1,000 for Enterprise.**

Two Enterprise SKUs get used once per audit each, so both run out together:

- Place Details Enterprise + Atmosphere: 1 per audit → 1,000 audits
- Nearby Search Enterprise: 1 per audit → 1,000 audits

So the first **~1,000 audits a month cost nothing**, and everything after that is ~$0.06.

## GHL, per audit

| | Rate | Count | Cost |
|---|---|---|---|
| OTP text | ~$0.0075/segment + carrier fee ~$0.004 + 5% | 1 | ~$0.0115 |
| Contact upsert, tags, custom fields | API, no charge | ~5 | $0 |

**~$0.0115 per audit.** Carrier fees vary by the lead's network (AT&T $0.0035,
T-Mobile and Verizon $0.0045, others $0.0040) so treat this as approximate.

The email transport and the media CDN hosting are no longer used per audit. GHL is down to
one job on this path: the text.

## n8n, per audit

| Workflow | Runs | When |
|---|---|---|
| Report Request Intake | 1 | always |
| Site Check (page) | 1 | always |
| Phone Unlock (send code) | 1 | only if they unlock |
| Phone Unlock (verify code) | 1+ | one per attempt |

**4 executions for a full audit, 2 for a scan that goes no further.** On n8n Cloud Starter
(2,500 executions/month) that is roughly **625 full audits a month**, so Google's 1,000-audit
Enterprise allowance and the n8n plan now run out at about the same point. `Report Email
Capture` and `Send Audit Report Email` are still published but nothing calls them; they cost
nothing while idle, and they are worth keeping until we are sure nobody wants an emailed
copy.

## Where to see the numbers in Google Cloud Console

Only one of these shows per-SKU usage, which is the one that matters for the free tier.

1. **Billing → Reports**, then expand **Group by** and pick **SKU**. The only place that
   shows usage and cost per SKU, so the only way to tell how much of a 1,000-call Enterprise
   allowance you have eaten. Filter by time range and product.
2. **Google Maps Platform → Metrics** — requests, errors and latency per API. Useful for
   spotting failures, no SKU breakdown.
3. **Google Maps Platform → Overview** — 30-day table of enabled APIs with request counts.
4. **APIs & Services → Dashboard** — the same for every API on the project, including
   PageSpeed Insights, which does not appear in the Maps console at all.
5. **APIs & Services → Quotas** — where to set the daily caps below.

## Caps worth setting

The point is not to save money, it is that a leaked key or a loop cannot run up a bill.

| API | Suggested cap | Reasoning |
|---|---|---|
| Places API (New) | 2,000 requests/day | ~14 per audit, so this allows ~140 audits a day |
| Maps Static API | 500 requests/day | 2 per audit, plus 1 per keyword re-measure |
| PageSpeed Insights | 500 requests/day | 2 per audit, default is 25,000 |

Two keys exist and they must stay separate:

- **Browser key** — shipped in the page's `config.js`, restricted to the site's referrer.
  Safe to be public precisely because of that restriction, which is now carrying more
  weight: this key makes the nine grid calls as well, so eleven Places calls per visitor.
  The referrer allowlist is the only thing standing between it and somebody else's script.
- **Server key** — the n8n "Google Maps Server Key" credential. No application restriction,
  so it must never reach the page or an email. Restricted to Places API (New) and Maps
  Static API.

## What was switched off, and what it was costing

| Thing | State | Why |
|---|---|---|
| `Audit Report Builder (GHL)` | unpublished | Polled GHL's audit for up to 5 minutes per lead. Nothing the lead saw came from it once the ranking map became ours. |
| `Report Status (page)` | archived | Existed only to serve GHL audit data to the page. |
| GHL "Generate Marketing Audit Report" automation | **still on, switch it off** | Otherwise GHL keeps calling a webhook that no longer listens. |

## Two savings found on 2026-09-16

**The same business was looked up twice.** The search box fetched Place Details, then the
scan fetched the same place again with a longer field list. Google bills those separately
and by their most expensive field, so it was one Enterprise call ($20) plus one
Enterprise + Atmosphere call ($25) for one business. Now the search box asks for the union
once and hands it to the scan: $25 instead of $45 per 1,000, and one less round trip.

**The grid asked all nine points for names and review counts.** A rank is only a position
in a list, so it needs nothing but place ids. Eight points now ask for `places.id` alone,
which is Text Search Essentials (IDs Only) at **$0.00, unlimited**. Only the centre point
asks for names, which is all the rival table in the email needs.

Together with the third saving below: **$0.419 -> $0.064 per audit, an 85% cut**, and the free tier went from covering
~111 emailed maps a month to ~1,000 full audits. Verified: ranks came back
`[7,6,6,8,4,5,8,6,6]` before and after, average 6.2, rival table still naming five
competitors with their review counts.

## Sources

- [Google Maps Platform core services pricing list](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Place data fields and their SKU tiers](https://developers.google.com/maps/documentation/places/web-service/data-fields)
- [API usage details by SKU](https://developers.google.com/maps/billing-and-pricing/sku-details)
- [Reporting and monitoring](https://developers.google.com/maps/reporting-and-monitoring/reporting)

## A third saving, found on the same day

Pinning the rival table to one named grid point turned out to be fragile as well as
billable: a single search point can come back with one result and no rivals, which is
exactly what happened to a real lead's email. The page already pays for a Nearby Search
with names and review counts during the scan and then threw it away, so that list is now
stored and reused. Every grid point asks for ids only, so **the whole grid is free**, and
the rival table is better for it, being ranked by popularity across a 25km radius rather
than by whatever one point returned.
