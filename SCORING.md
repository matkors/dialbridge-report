# Lost Job Report — scoring, as built

This is the implementation record for the scoring spec. It covers what went in as written,
what could not be built because the data does not exist, and three places where the
implementation deliberately differs from the spec. Every formula below is in `engine.js`.

## Inputs: what we can actually get

The spec lists fifteen inputs. Twelve are available. Three are not, and that shapes
everything else.

| Input | Status | Source |
|---|---|---|
| `review_count` | ✅ | Places Place Details |
| `review_rating` | ✅ | Places |
| `top_competitor_review_count` | ✅ | Nearby Search, highest count in the set |
| `gbp_completeness` | ⚠️ partial | Places: categories, hours, photos, phone, website, description. **Post recency is not exposed by the Places API**, so it is not in the 0-100. |
| `nap_match` | ✅ | the n8n site check compares `tel:` links to the listing number |
| `maps_rank_avg` | ✅ | our own 9-point grid |
| `page_speed_score` | ✅ | PageSpeed Insights, mobile |
| tappable CTA | ⚠️ proxy | we can see whether the number is tappable; **"above the fold" is not measurable** from a Lighthouse run, so it is tappable-anywhere |
| `q1`–`q4` | ✅ | the quiz |
| `review_velocity_90d` | ⚠️ **saturates at 5** | Places returns a maximum of five reviews per place. A business with forty reviews in ninety days is indistinguishable from one with five. Treat it as "at least this many". |
| `business_age_years` | ⚠️ **estimated, and a weak floor** | Not in Places. Estimated from the oldest of those five reviews, and Google picks those five by relevance, not age. Flagged `estimated: true` wherever it is used. |
| `owner_reply_rate` | ❌ **no source** | Places does not return owner replies at all. Its 0.15 weight redistributes (see below). Getting this needs Apify or the GHL audit back. |

## Renormalisation

Every sub-score is a weighted average that drops unknown inputs and rescales the remaining
weights to 1.0. This is `weighted()` in `engine.js`. It matters more than it sounds: scoring
a missing input as zero would hand a good business a bad score for something we never
measured. The spec asks for this behaviour for `pace_score`; it is applied to every input.

So `owner_reply_rate` being unavailable does not cost anyone 15 points. Its weight goes to
rating, rival comparison, pace and velocity in proportion.

## Sub-scores, as built

```
Reviews & Reputation   0.25  rating / 5 × 100
                       0.25  min(100, review_count / top_competitor × 100)
                       0.20  pace: min(100, (reviews_per_year / 18) × 100)
                       0.15  min(100, review_velocity_90d × 20)
                       0.15  owner_reply_rate           ← unavailable, redistributes

Website                0.40  nap_match (100 / 0)
                       0.30  page_speed_score
                       0.30  tappable number (100 / 40)

Google Profile         gbp_completeness, passed through

Catching the Lead      0.5 × curve(q1) + 0.5 × curve(q2)
```

Quiz curve is the spec's: `0 → 95, 1 → 72, 2 → 45, 3 → 15`. A good answer is 95 rather than
100 because "we reply within the hour" is a claim, not a measurement.

`reviews_per_year` benchmark is 18, per the spec. It is a single constant
(`REVIEWS_PER_YEAR_BENCHMARK`) so it can be moved per trade later.

## The two headline circles

```
Getting Found     = 0.40 × Reviews&Reputation
                  + 0.30 × GoogleProfile
                  + 0.30 × MapRanking          ← DEVIATION, see below

Catching the Lead = the sub-score above, shown directly
```

Website stays out of Getting Found, as the spec says: the site is how they get chosen, not
how they get discovered.

## Three deviations from the spec

**1. The map is in Getting Found.** The spec lists `maps_rank_avg` as an input and then
never uses it in any sub-score or headline score. That reads as an oversight rather than a
decision, because where a contractor sits on the 9-point grid is the most direct measurement
of being found that we have, and it is now the most prominent thing in the report. Removing
the third line of `foundScore` reverts this exactly.

**2. The dollar figure does not use `miss_rate = (100 - min(sub-scores)) / 100`.** That
formula reads a weak review count as a share of lost leads. Worked through on a real
business: a contractor scoring 45 comes out losing 55% of their work, which on their own job
value is a dozen jobs a month. It is not a number that survives being said out loud on a
phone call, and the report's whole credibility rests on the owner recognising their own
business in it.

What is built instead: the leak rate comes from the two behaviour answers only, and is
hard-capped at 20%.

```
leadResponse   same_day 0.03   when_slammed 0.08   fall_through 0.14
quoteFollowUp  once_or_twice 0.02   when_remember 0.05   nothing 0.08
cap            0.20
```

Job count is the lower of two independent readings, both conservative:
- the span of the reviews we can see, at roughly one review per ten jobs
- the last 90 days of reviews, at roughly one review per eight jobs

and when neither is readable, a typical month for the job size they chose
(20 / 10 / 4 / 2 jobs for the four bands).

**3. A monthly figure always shows; the per-lead figure never does.** The spec shows the
flat per-lead number by default and only switches to monthly when `review_velocity_90d >= 3`.
Product decision went the other way: the report only ever talks in months, because a per-job
figure asks the reader to do the arithmetic. There is no case left where a per-lead number
shows, including a business with no trading history to build a month on — that one falls back
to the typical job count for its band.

Job value uses the spec's **midpoints** ($750 / $3,000 / $10,000 / $20,000), not the bottom
of each band.

The working is shown as a single multiplication line — `4 jobs a month × $10,000 a job ×
13% at risk` — rather than three labelled cells. Three cells each carrying a number, a label
and a note of its own length stacked raggedly, and per the stat-tile contract they read as
three hero figures competing with the total above them.

**One thing to know about that:** the line naming which job count was used ("a typical month
for $10,000 jobs" vs "from how fast reviews land on your profile") was removed as clutter,
so the job count now appears without its source on the page. The basis is still tracked in
the data as `leak.basis` and goes to n8n, so it is recoverable — but a contractor who
disputes the job count will not find the assumption stated on the report.

## The heat map

Google's Static Maps markers carry a **single character** label, so a rank of 14 cannot be
drawn on one. Every workaround inside Static Maps misleads: labelling it "X" makes a 14 look
identical to a business that does not appear at all, and dropping the label leaves a coloured
pin with no number on it.

So we do not use Google's markers. `rankingMap()` fetches a clean map (POIs and transit
switched off) and the report draws its own numbered circles over it, positioned by projecting
each grid point to a pixel offset from the centre. Equirectangular around the centre, which
is sub-pixel accurate over six kilometres. Circles are placed in percentages so they scale
with the image on a narrow screen.

Green is top 3, orange is 4 or lower with the real number on it, red is an X for "does not
come up here". There is no separate pin for their address: the middle of the grid IS their
address, and an H marker there covered the one rank they care about most.

Same single Static Maps request as before, so no change in cost.

## Service-area businesses have no map, and that is deliberate

**Measured 2026-09-17:** a pure service-area business never appears in Places `searchText`
results for a trade. Tried location bias, location restriction, a plain town query, and with
and without `includePureServiceAreaBusinesses` — absent from all twenty results every time,
across three different businesses. That flag only makes them findable when you search their
**name**, which is what the search box does.

So the 9-point grid cannot rank them. The first attempt at a fix centred the grid on the
median of their competitors' pins, which worked mechanically and was wrong: it produced nine
red X pins telling a working contractor with 81 reviews that they are invisible. That is not
a measurement, it is a false claim about somebody's business.

What ships instead: no grid, and a card that says why, explicitly framed as a limit on what
we can measure rather than a verdict on how they rank. The map sub-score is `null`, so
`weighted()` drops it and Getting Found is computed from reviews and the profile alone —
they are not penalised for something we never measured.

**This affects about half of them.** Of fourteen real contractors tested, seven were pure
service-area: roofing, demolition, window cleaning, pressure washing, junk removal and lawn
care. The real fix is a SERP scraper (the Apify Google Maps actor sees what a person sees,
service-area businesses included). Until then, half of paid traffic gets a report with no map.

The centroid code is still there for the narrow case it is honest for: a business that is
not flagged service-area but is missing coordinates anyway, which Google will return in a
trade search.

Verified end to end against fourteen real businesses: seven real maps, seven honest
explanations, zero grids of X pins for a business that cannot be measured, zero sections
that silently disappear.

## "No website" is three states, not two

A missing website link on a Google listing does **not** mean the business has no website.
A1 Progressive has one; it is simply not linked. The report called that "you don't have a
website" and landed a foundation-level finding, which is wrong and reads as if we never
checked.

`DialBridge - Find Website` (`D82795IfOpeUqBnu`) searches the web when the listing carries
no link, on Brave via gateway credits. The three states now are:

| state | finding |
|---|---|
| Linked on the listing | scored as before |
| **Found by search, not linked** | "Your website isn't on your Google listing" — the cheapest fix on the list |
| Nothing found anywhere | "There's no website on your listing, and we couldn't find one" |

The middle state is a better finding than the one it replaces: the listing looks unfinished
*and* every click from the map goes nowhere, and it takes five minutes to fix.

**Precision is the whole game here**, because the wrong domain means running a speed test on
a stranger's website and printing the score in this contractor's report. Empty is a perfectly
good answer. Four real false positives shaped the rules:

- **Directories outrank the business for its own name.** Every result for A1 Progressive was
  dexknows, yellowpages, thumbtack, yelp, buildzoom, cylex, chamberofcommerce or mapquest.
  The real domain was *inside* two of them — a cylex location link and a chamberofcommerce
  FAQ answer — so domains are harvested from page text and location links, not only result
  URLs.
- **Only the registrable domain may earn a match.** `wheree.com` puts the whole business name
  in a subdomain, so `mr-rooter-plumbing-of-central-new-jersey.wheree.com` sailed through on
  "rooter". Matching the registrable part kills every directory that plays this trick.
- **Trade words cannot earn a match.** A made-up "Zzqqx Nonexistent Fake Plumbing" matched
  `benjaminfranklinplumbing.com` on "plumbing". A trade word says what they do, never which
  business they are.
- **Nor can geography.** "Jersey Shore Window Washing" matched
  `jerseyshoreguttercleaning.com` — a different company sharing a regional prefix.

A name made only of weak words has to match three of them, which is exactly what separates
`jerseyshorewindowwashing.com` from `jerseyshoreguttercleaning.com`.

Two implementation notes worth keeping. **Quoting the name in the query excluded the real
site**, because a contractor's homepage rarely carries its full legal name as a phrase, so
the quoted search returned only the directories that do. And **`new URL()` is not reliably
available in the n8n code sandbox**: it threw, a `try/catch` swallowed it, and every business
came back with results-found and zero candidates. Hosts are parsed by regex now, and parse
failures are counted in the response rather than hidden.

Verified: six of six real businesses found (`a1progressive.com`, `junkbustersremoval.com`,
`jerseyshorewindowwashing.com`, `monmouthcountytree.com`, `mrrooter.com`,
`precisiondoorjersey.com`) and three invented or wholly generic names correctly returned
nothing.

## The worst-first list

Candidates are built with their own sub-metric score; `severity = 100 - score`. Sorted by
severity, tie-broken by `dollarWeight` (how directly that gap costs a job today: losing an
enquiry you already earned is a 10, an unfinished profile is a 3).

- `severity >= 70` → red, critical
- `severity 40-69` → gold, slowing them down
- `severity < 40` → off the list entirely

Top four are shown. `review_pace_stagnant` only enters the pool at three years or more of
(estimated) trading. `owner_reply_low` is in the spec and absent here, because we cannot
measure it.

The intro line counts are real: `redCount` and `goldCount` come off the sort, so the page
cannot claim five problems above a list of two. Beyond the spec's list we also score
`no_website`, `map_ranking`, `website_speed`, `website_usability`, `website_stale`,
`no_tap_to_call`, `review_request` (q3) and `no_phone`, because dropping "you have no
website" to match a nine-item list would have been a regression.

Max two findings per area, so three variations on "your website is slow" cannot fill the
list.

## Copy rules applied

- No "call"-specific language. Lead, enquiry or job throughout.
- Headline is "You're missing the pieces that bring the **jobs** in".
- Every count runs through a singular/plural helper — `reviewWord()`, `yearWord()`.
- The three-step model uses **get found / get chosen / catch the lead** in both the flow
  strip at the top and the plan at the bottom. The top strip used to say "they check you
  out".
- Stagnant-pace narrative fires as a finding when pace is below 60 and the business is three
  years old or more, naming the trade and the benchmark.

## Lead score — for Meta, never shown to the lead

`leadScore()` in `engine.js`. This is a different question from everything above: the report
scores the contractor's business, this scores whether the lead was worth an ad click.

```
capacity  0.50  review_count scaled 0-120     ← a HIGH count is the good signal here
          0.30  job value band
          0.20  has a website (100 / 40)
pain      0.50  100 - Getting Found
          0.50  100 - Catching the Lead
value     log-scaled monthly loss, $500 to $15,000

score = 0.45 capacity + 0.35 pain + 0.20 value
band  = hot >= 70, warm >= 50, cool below
```

The counter-intuitive part is deliberate. A high review count means real job volume, years
of trading and money coming in. The business with two reviews and no website has the worst
report on the page and no budget to fix any of it.

A missing `value` does **not** renormalise away: if they finished the quiz and we still
cannot point at a monthly loss, that is a real answer, not a gap. Renormalising it let a
250-review shop with a perfect process score warmer than a mid-sized one bleeding $1,600 a
month, purely on the size of its review count.

How it separates, on constructed cases:

| lead | score | band |
|---|---|---|
| Big HVAC, 400 reviews, $20k jobs, no map presence | 79 | hot |
| Established roofer, 180 reviews, $10k jobs, weak map | 73 | hot |
| Established plumber, 90 reviews, $3k jobs, decent map | 56 | warm |
| Strong shop, 250 reviews, nothing broken | 48 | cool |
| Brand new, 1 review, no website | 46 | cool |
| Handyman, 8 reviews, $750 jobs, no website | 37 | cool |

## What still has to be built server side

The page sends everything needed on the **verify** call, at the moment the phone is
confirmed. Nothing is sent before that, so only committed leads exist downstream. Payload
shape is `leadPayload()` in `report.js`:

- `classify` — name, Google category, primary type, detected trades, website, description,
  address. This is the input for the **LLM contractor check**, which is not built yet. It has
  to run in n8n and gate everything after it: if the LLM says this is not a contractor or
  home service business, the lead must not go to Meta.
- `score` — the lead score above, with the facts behind it in `reasons` so a decision can be
  argued with later.
- `report` — the sub-scores, signals, map result, monthly loss, red and gold counts.
- `answers` — the four quiz answers.

The keyword and the classification both come from `DialBridge - Pick Search Keyword`
(`2u0m8WpSrZ50mYpS`), one gpt-4o-mini call per audit, about $0.00005. The two answers are
deliberately independent: the keyword has to make the report work for whoever turns up, and
the classification is only the gate on the Meta send. Tying them together meant an ambiguous
business got no keyword and therefore no map.

The classifier is instructed to answer **true when unsure**, because dropping a real
contractor costs far more than one wasted conversion. "Apex Contracting Group" was a false
negative before that instruction went in.

`DialBridge - Phone Unlock (OTP)` now catches all of it after `Respond Unlocked`, so the
unlock stays instant: `Score The Lead` → `Save Lead Score` → `Tag Lead Quality`. Stored on
the submission as `leadScore`, `leadBand`, `isHomeService`, `metaQualified` and a
`leadSignals` JSON blob, and tagged on the GHL contact as `lead-hot` / `lead-warm` /
`lead-cool` plus `meta-qualified` or `not-home-service`.

**The Meta gate is `metaQualified`, and it is not the score.** Two conditions only: the phone
was verified, and the model did not say this is something other than a contractor. Unknown
counts as qualified. The score is the event *value*, not a second gate — sending only the
best leads starves the algorithm, while sending every verified contractor with a value
attached is what lets Meta learn which clicks are worth buying.

Outstanding:
1. **Meta CAPI post** for leads where `metaQualified` is true, with `leadScore` as the event
   value. Needs a Pixel ID and a CAPI access token, which are not in n8n yet.
3. **Growth Blueprint PDF** hosted on GHL, and the email workflow behind the form at the
   bottom of the report (it currently posts to the old `Report Email Capture` webhook, which
   stores the address but does not yet send a PDF).
4. `owner_reply_rate` via Apify if we want that 0.15 back.
