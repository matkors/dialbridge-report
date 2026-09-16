# n8n pieces that live outside the browser

Copies of code that runs inside n8n, kept here so it is reviewable in git. n8n is the
source of truth: paste changes into the node named in each file's header.

| File | Node | Workflow |
|---|---|---|
| `email-template.js` | Build Email HTML | DialBridge - Send Audit Report Email (`nq9f9GLkGaojuJc9`) |
| `site-check.js` | Detect Website Tech | DialBridge - Audit Report Builder (GHL) (`NV082ePpGt0zarIL`) |

## Pending changes to apply in n8n

1. **Email: real map, no PDF.** Paste `email-template.js` into **Build Email HTML** and put
   the page's browser key where `GOOGLE_STATIC_MAPS_KEY` is. Static Maps answers without a
   referrer, so the recipient's mail client loads the map straight from the URL. Then delete
   the **Report To PDF** node, connect **Build Email HTML** to **Send Email Through GHL**, and
   drop `attachments` from that node's body.

2. **Site checks.** Paste `site-check.js` into **Detect Website Tech**. It adds four things a
   speed test cannot see: a stale copyright year, whether the phone number is tappable and
   matches Google, whether any form or email exists, and whether ad tracking is running.

3. **Make those checks show on the page too.** The page asks for them at
   `N8N_SITE_CHECK_URL` if that secret exists, and leaves the findings out if it does not.
   Build a small published workflow: Webhook (POST, origin-checked like the others) ->
   HTTP GET the posted `url` with a browser user agent and `neverError` ->
   the same string checks as `site-check.js` -> Respond with the flags as JSON. Then
   `gh secret set N8N_SITE_CHECK_URL` and add it to `deploy.yml` beside the others.

4. **Store the three answers on the contact.** The page already sends `answers` on both the
   submit and the email request: `{ afterHours, quoteFollowUp, jobValue, jobValueLow }`.
   They map to existing custom fields After-Hours Lead Handling (`2xNAPRreqVEICumA6zCp`),
   Quote Follow-Up (`85s0vDiOxqe4fpGzTs7R`) and Average Job Value (`Y7XaNBZYUnTvaWxu8T99`).

## Not possible from Google's public API

Owner replies to reviews. Places returns review text and ratings but never the business's
reply, so the count of unanswered reviews can only come from GHL's audit (already in the
emailed report) or a scraper such as the Apify Google Maps actor.
