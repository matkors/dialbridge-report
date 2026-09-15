# DialBridge Lost Job Report (experiment)

Landing page experiment: a contractor types their business name, picks it from Google's suggestions, and we pull their Google listing details. Later steps (questions, blurred report, phone verification) get built on top of this.

## Run it locally

```bash
python -m http.server 5500
```

Open http://localhost:5500

## Google Maps API key setup

1. Go to https://console.cloud.google.com and create a project (e.g. `dialbridge-report`). Turn on billing.
2. **APIs & Services > Library**, enable **Places API (New)**. (The page calls the Places web API directly so it can include service-area businesses; the Maps JavaScript API isn't used.)
3. **APIs & Services > Credentials > Create credentials > API key**.
4. Edit the key:
   - **Application restrictions:** Websites. Add `http://localhost:5500/*` (add your real domain later).
   - **API restrictions:** Restrict key to Places API (New).
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

Both values are visible to anyone who opens the live page, since the browser has to use them. The Google key is locked to this site by referrer restriction; the n8n webhook only accepts this site's origin, rejects bots via a hidden `company_fax` field, and validates every field.

- Set or change a secret: `gh secret set GOOGLE_MAPS_API_KEY --repo matkors/dialbridge-report` (same for `N8N_REPORT_WEBHOOK_URL`)
- Redeploy without a code change: `gh workflow run deploy.yml --repo matkors/dialbridge-report`
- The key's website restrictions must include `https://matviykorsunskiy.me/dialbridge-report/*`
