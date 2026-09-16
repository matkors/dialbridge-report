# What one Lost Job Report costs

Checked 2026-09-16 against Google's published SKU list and verified against live runs.
Every number below is per **one business**, start to finish.

## The short version

| | Per audit | Free each month |
|---|---|---|
| Google Maps Platform | **$0.099** | first ~1,000 audits |
| GHL (one text, one email) | **$0.012** | nothing, it is pass-through |
| n8n | 6 executions | 2,500 on Starter, so ~416 audits |
| PageSpeed Insights | $0 | 25,000 calls a day |
| **Total** | **~$0.11** | **$0 for the first ~1,000 a month** |

A "full" audit means someone searches their business, gets the report, unlocks it with a
texted code, and asks for the ranking map. Somebody who only scans and leaves costs
**$0.062** and 2 n8n executions.

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
| PageSpeed Insights | phone + desktop speed test | 2 | not a Maps SKU | $0 | 25,000/day | $0 |
| Text Search | ranking grid, centre point | 1 | Text Search **Enterprise** | $35.00 | 1,000 | $0.035 |
| Text Search | ranking grid, other 8 points | 8 | Text Search **Essentials (IDs Only)** | **$0** | unlimited | $0 |
| Static Maps | the emailed ranking map | 1 | Static Maps | $2.00 | 10,000 | $0.002 |
| Geocoding | only when the business has no pin | 0 or 1 | Geocoding | $5.00 | 10,000 | $0 or $0.005 |

**Google total: $0.099 per audit**, or $0.104 for a pure service-area business, which has
no pin on Google Maps and needs its town geocoded to give the ranking grid a centre.
**Geocoding API has to be enabled on the project and added to the server key's
restrictions**, or those businesses get no map at all.

Why the autocomplete is free: every keystroke goes out with a session token, and the session
ends in a Place Details call. Google then bills those keystrokes under "Autocomplete
(Included with Place Details)", which is free at any volume. Break the session token and
they become $2.83 per 1,000.

## Where the free tier actually runs out

Since March 2025 there is no shared $200 credit. Each SKU has its own monthly allowance:
**10,000 calls for Essentials, 5,000 for Pro, 1,000 for Enterprise.**

Three Enterprise SKUs get used once per audit each, so all three run out together:

- Place Details Enterprise + Atmosphere: 1 per audit → 1,000 audits
- Nearby Search Enterprise: 1 per audit → 1,000 audits
- Text Search Enterprise: 1 per emailed map → 1,000 maps

So the first **~1,000 audits a month cost nothing**, and everything after that is ~$0.10.

## GHL, per audit

| | Rate | Count | Cost |
|---|---|---|---|
| OTP text | ~$0.0075/segment + carrier fee ~$0.004 + 5% | 1 | ~$0.0115 |
| The map email | ~$0.80 per 1,000 | 1 | $0.0008 |
| Contact upsert, tags, custom fields, media upload | API, no charge | ~6 | $0 |

**~$0.012 per audit.** Carrier fees vary by the lead's network (AT&T $0.0035,
T-Mobile and Verizon $0.0045, others $0.0040) so treat this as approximate.

GHL is also doing three jobs here that would otherwise be separate bills: the email
transport, the SMS, and hosting the emailed map image on its media CDN.

## n8n, per audit

| Workflow | Runs | When |
|---|---|---|
| Report Request Intake | 1 | always |
| Site Check (page) | 1 | always |
| Report Email Capture | 1 | only if they give an email |
| Send Audit Report Email | 1 | sub-workflow of the above |
| Phone Unlock (send code) | 1 | only if they unlock |
| Phone Unlock (verify code) | 1+ | one per attempt |

**6 executions for a full audit, 2 for a scan that goes no further.** On n8n Cloud Starter
(2,500 executions/month) that is roughly **416 full audits a month** before the plan is the
binding constraint rather than Google.

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
| Geocoding API | 200 requests/day | at most 1 per audit, and only for service-area businesses |
| Maps Static API | 500 requests/day | 2 per audit |
| PageSpeed Insights | 500 requests/day | 2 per audit, default is 25,000 |

Two keys exist and they must stay separate:

- **Browser key** — shipped in the page's `config.js`, restricted to the site's referrer.
  Safe to be public precisely because of that restriction.
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

Together: **$0.419 → $0.099 per audit, a 76% cut**, and the free tier went from covering
~111 emailed maps a month to ~1,000 full audits. Verified: ranks came back
`[7,6,6,8,4,5,8,6,6]` before and after, average 6.2, rival table still naming five
competitors with their review counts.

## Sources

- [Google Maps Platform core services pricing list](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Place data fields and their SKU tiers](https://developers.google.com/maps/documentation/places/web-service/data-fields)
- [API usage details by SKU](https://developers.google.com/maps/billing-and-pricing/sku-details)
- [Reporting and monitoring](https://developers.google.com/maps/reporting-and-monitoring/reporting)
