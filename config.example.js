// Copy this file to config.js and paste your browser key.
// config.js is gitignored so the key never gets committed.
window.DIALBRIDGE_CONFIG = {
  GOOGLE_MAPS_API_KEY: "PASTE_YOUR_KEY_HERE",
  N8N_REPORT_WEBHOOK_URL: "PASTE_N8N_WEBHOOK_URL_HERE",
  N8N_KEYWORD_URL: "",
};

// Note: n8n needs a SEPARATE, server-side Google key, set as the n8n variable
// GOOGLE_MAPS_API_KEY. The key above is a browser key locked to the site's referrer, and
// Google refuses it from a server. See .env and n8n/ranking-grid.js.
