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

## The ranking map is ours, not GHL's

`ranking-grid.js` holds the three nodes in "Send Audit Report Email" that build the Google
Maps ranking grid from the Places API. GHL's own heatmap needs a keyword set on it and sits
`QUEUED` indefinitely when one is not, so the email that exists to carry the map used to
wait five minutes and then go out without it. Nine text searches around the business answer
the same question in under a second.

It needs an n8n variable `GOOGLE_MAPS_API_KEY` (Settings, Variables) holding a **server**
key: no application restriction, restricted to Places API (New) and Maps Static API. The
browser key the page uses is locked to a referrer and is refused server-side with
`Requests from referer <empty> are blocked`. That server key must never reach the page.

## GHL will only text a number already on the contact

`conversations/messages` with `type: SMS` refuses a `toNumber` that does not match the
contact, with `CONVERSATIONS_MSG_PHONE_MISMATCH`. Our contacts carry the business number
from the Google listing, so every unlock code failed. The Phone Unlock workflow now writes
the lead's name and number onto the contact before sending: into the standard `phone` field
so the text can go at all, into `Lead Phone` so it is clear which number came from the
person, and the listing's number into `Business Phone` so nothing is lost. Both custom
fields are looked up by name at run time, because field ids change when a field is rebuilt.
