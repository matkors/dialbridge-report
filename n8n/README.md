# n8n pieces that live outside the browser

These are copies of code that runs inside n8n, kept here so it is reviewable in git.
n8n is the source of truth: paste changes into the node named in each file's header.

| File | Node | Workflow |
|---|---|---|
| `email-template.js` | Build Email HTML | DialBridge - Send Audit Report Email (`nq9f9GLkGaojuJc9`) |

## Pending changes to apply in n8n

1. Paste `email-template.js` into **Build Email HTML**, and replace `GOOGLE_STATIC_MAPS_KEY`
   with the same browser key the page uses. Static Maps answers without a referrer, so the
   recipient's mail client can load the map straight from the URL.
2. Delete the **Report To PDF** node and connect **Build Email HTML** straight to
   **Send Email Through GHL**. Then remove the `attachments` field from that node's body,
   leaving `type`, `contactId`, `subject` and `html`.
3. Store the three question answers on the GHL contact. The page already sends them as
   `answers` on both the submit and the email requests:
   `{ afterHours, quoteFollowUp, jobValue, jobValueLow }`. They map to the existing custom
   fields After-Hours Lead Handling (`2xNAPRreqVEICumA6zCp`), Quote Follow-Up
   (`85s0vDiOxqe4fpGzTs7R`) and Average Job Value (`Y7XaNBZYUnTvaWxu8T99`).
