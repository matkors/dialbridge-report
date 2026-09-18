# DialBridge Lost Job Report (experiment)

A contractor types their business name, picks it from Google's suggestions, answers four
questions, and the page builds their whole report in about forty seconds from public Google
APIs. Two scores are free to read. Everything else is blurred behind a dialog that asks for
a name and a mobile number, and opens on a code we text them.

## Run it locally

```bash
python -m http.server 5500
```

Open http://localhost:5500

## How the report gets to the page

Nothing is polled and nothing waits on GHL. The page is the audit.

1. `app.js` sends the picked business to the intake webhook and gets a `submissionId` back.
   n8n creates the GHL contact in parallel; the page never waits for it.
2. `questions.js` asks the four questions before the scan starts, because two of the answers
   are the only way to price what happens to a lead after it arrives.
3. `scan.js` runs the seven scan steps in the browser: profile, competitors, **ranking grid**,
   reviews, photos, website speed test, contact details. Everything is fired at once and the
   steps reveal them one at a time. The ranking step says what it searched and how far apart,
   and deliberately does **not** show the map: that is the payoff of the report.
4. `engine.js` scores it and writes the findings by rule, not by model, so a number can never
   be invented. Two scores come out: **getting found** (Google's data) and **catching the
   lead** (their answers).
5. `report.js` draws it. The two scores are free. The rest goes into a blurred, inert wrapper
   with a dialog over it; `openGate` has no close button, no backdrop dismiss and no Escape,
   and traps focus so a screen reader cannot read the report out from behind it. The only
   ways past are the texted code or "Not now, take me back", which abandons the report.
6. On verify, n8n writes the lead's name and phone to the GHL contact's Lead Phone field,
   restores the business number as the primary, and the page unblurs in place.

The ranking map used to be the reward for an email address and went out server side. It is
free and on the page now: nine Text Search calls with a `places.id` field mask, which is the
one Places mask Google does not bill for. Rival names in the map table come from the Nearby
Search the scan already ran, matched by place ID, so no call is paid for twice. See
`COSTS.md`.

**Which keyword the map measures** is decided by `tradesOf` in `scan.js`, by rule and not by
a model: Google's own primary category leads (it is the category Google ranks them under),
then trade words matched out of the business name, canonicalised so "heating", "A/C" and
"hvac" collapse to one term. It returns every trade it finds, best guess first. Plenty of
contractors sell two or three, so the map card names the term it used and offers the others
as a one-click re-measure. Nine more free searches, so a second opinion costs $0.002 for the
new map image and nothing else.

The map does not use Google's own markers, because a Static Maps label is a single character
and a rank of 14 cannot be written on one. `rankingMap()` returns a clean map plus a pixel
offset per grid point, and the report draws its own numbered circles over it. Green is top 3,
orange carries the real number, red is an X for "does not come up here".

Scoring is documented separately in `SCORING.md`, including the three places the
implementation deliberately differs from the scoring spec and what still has to be built
server side (the LLM contractor check and the Meta post).

A finished report is kept in `sessionStorage` for the tab, so a refresh redraws it instead of
throwing the lead back to the search box. The unlock is remembered the same way, keyed to the
submission id.

## Google Maps API key setup

1. Go to https://console.cloud.google.com and create a project (e.g. `dialbridge-report`). Turn on billing.
2. **APIs & Services > Library**, enable **Places API (New)**. (The page calls the Places web API directly so it can include service-area businesses; the Maps JavaScript API isn't used.)
3. **APIs & Services > Credentials > Create credentials > API key**.
4. Edit the key:
   - **Application restrictions:** Websites. Add `http://localhost:5500/*` (add your real domain later).
   - **API restrictions:** Places API (New), **Maps Static API** (the competitor map and the
     ranking map) and **PageSpeed Insights API** (the website speed test).
5. Copy `config.example.js` to `config.js` and paste the key. `config.js` is gitignored.
6. **Billing > Budgets & alerts:** add an alert (e.g. $25).
7. **Places API (New) > Quotas:** set a daily cap so bots can't run up a bill.

This is a browser key, so anyone who loads the deployed page can see it. That's normal for Google Maps; the website and API restrictions above are what protect it.

## What it costs (Places API New, Sept 2026)

- Autocomplete: suggestions in a session that ends with a details lookup are free. Searches abandoned before picking count toward 10,000 free requests a month, then $2.83 per 1,000.
- Place Details with phone, website, rating and review count bills as **Enterprise**: 1,000 free a month, then $20 per 1,000.

## Hosting

Live at https://matviykorsunskiy.me/dialbridge-report/ via GitHub Pages (public repo, since Pages can't host private repos on the free plan).

Every push to `main` runs `.github/workflows/deploy.yml`, which writes `config.js` at deploy time from two repo secrets. Neither is ever committed:

- `GOOGLE_MAPS_API_KEY`: Places API (New) browser key
- `N8N_REPORT_WEBHOOK_URL`: n8n workflow "DialBridge - Report Request Intake" (validates the submission and saves it to the `dialbridge_report_submissions` data table)
- `N8N_SITE_CHECK_URL`: n8n workflow "Site Check (page)" — fetches the contractor's page source, which a browser cannot read cross-origin
- `N8N_UNLOCK_SEND_URL` / `N8N_UNLOCK_VERIFY_URL`: n8n workflow "DialBridge - Phone Unlock (OTP)". The code is generated and checked server side; the page only ever learns whether it was right
- `N8N_REPORT_EMAIL_URL`: n8n workflow "DialBridge - Growth Blueprint Capture". The email form at the bottom of the unlocked report posts here; it saves the address on the submission and the GHL contact, tags `blueprint-requested`, and emails the Growth Blueprint PDF at `/dialbridge-report/blueprint/DialBridge-Growth-Blueprint.pdf`
- `N8N_REPORT_STATUS_URL` is still written into `config.js` but nothing reads it; the status endpoint is archived

Both values are visible to anyone who opens the live page, since the browser has to use them. The Google key is locked to this site by referrer restriction; the n8n webhook only accepts this site's origin, rejects bots via a hidden `company_fax` field, and validates every field.

- Set or change a secret: `gh secret set GOOGLE_MAPS_API_KEY --repo matkors/dialbridge-report` (same for `N8N_REPORT_WEBHOOK_URL`)
- Redeploy without a code change: `gh workflow run deploy.yml --repo matkors/dialbridge-report`
- The key's website restrictions must include **`https://matviykorsunskiy.me/*`**, not just
  the `/dialbridge-report/` path.

  **This is not optional and it is not a mobile-only problem.** Measured against real browser
  engines on the live page:

  | engine | referrer Google receives | result |
  |---|---|---|
  | Chromium (Chrome, Edge) | `https://matviykorsunskiy.me/dialbridge-report/` | 200 |
  | WebKit (Safari, all iOS browsers) | `https://matviykorsunskiy.me/` | **403** |
  | Firefox | `https://matviykorsunskiy.me/` | **403** |

  WebKit and Firefox trim cross-origin referrers to the origin and there is nothing the page
  can do about it. The `<meta name="referrer">` tag does not help, and neither does
  `fetch(..., { referrerPolicy: "unsafe-url" })` — both were tested and both are ignored by
  those engines. Every iPhone, every Safari and every Firefox visitor gets a dead search box
  until the origin is on the allowlist. Adding `https://matviykorsunskiy.me/*` covers both
  the origin and the full path, so Chromium keeps working too.
