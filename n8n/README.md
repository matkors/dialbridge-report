# n8n pieces that live outside the browser

Copies of code that runs inside n8n, kept here so it is reviewable in git. n8n is the
source of truth: paste changes into the node named in each file's header.

| File | Node | Workflow |
|---|---|---|
| `email-template.js` | Build Email HTML | DialBridge - Send Audit Report Email (`nq9f9GLkGaojuJc9`) |
| `site-check.js` | Detect Website Tech | DialBridge - Audit Report Builder (GHL) (`NV082ePpGt0zarIL`) |

## Pending changes to apply in n8n

All applied. One manual step is left, because a key cannot be written from a tool call
without printing it:

**Add the map key to n8n.** Settings -> Variables -> new variable named
`GOOGLE_STATIC_MAPS_KEY`, value = the same Google browser key in `.env`. Until it exists the
email still sends, just without the map image. Static Maps answers without a referrer, so
the recipient's mail client can load the URL directly.

## Not possible from Google's public API

Owner replies to reviews. Places returns review text and ratings but never the business's
reply, so the count of unanswered reviews can only come from GHL's audit (already in the
emailed report) or a scraper such as the Apify Google Maps actor.
