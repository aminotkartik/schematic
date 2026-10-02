# EcoSwitch — schematic

Intelligent classroom energy management: an interactive, browser-based simulation of a three-zone classroom.

```
index.html / style.css / script.js   the site
config.js                            public URLs for the chatbot + contact form
chatbot.js                           chat widget (talks to the Worker, never to Groq directly)
contact.js                           contact form (posts to Google Apps Script)
worker/                              Cloudflare Worker that proxies Groq and holds the API key
google-apps-script/Code.gs           Google Sheets backend for the contact form
.github/workflows/                   deploys the Worker and pushes the GROQ_API_KEY secret to it
```

## 1. Chatbot (Groq) — API key kept in GitHub Secrets

A static site (GitHub Pages) cannot read GitHub Secrets at runtime, and any key placed in browser
JavaScript is public. So the browser calls a small Cloudflare Worker; GitHub Actions copies your
secret into the Worker; the Worker calls Groq.

1. Create a key at https://console.groq.com/keys.
2. In your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**, add:

   | Secret name             | Value                                              |
   | ----------------------- | -------------------------------------------------- |
   | `GROQ_API_KEY`          | your Groq API key                                  |
   | `CLOUDFLARE_API_TOKEN`  | Cloudflare token with the "Edit Cloudflare Workers" template |
   | `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID (Workers & Pages overview) |

3. Edit `worker/wrangler.toml` → set `ALLOWED_ORIGINS` to your site origin, e.g. `https://username.github.io`
   (origin only — no repo path, no trailing slash).
4. Push to `main`. The **Deploy chat worker** action runs; open its log or the Cloudflare dashboard
   for the Worker URL (`https://ecoswitch-chat.<subdomain>.workers.dev`).
5. Put that URL in `config.js` → `CHAT_API_URL`, commit, push.

Local testing: serve the site on `http://localhost:8000` (already in `ALLOWED_ORIGINS`).

## 2. Contact form (Google Sheets)

1. Create a Google Sheet. **Extensions → Apps Script**, paste `google-apps-script/Code.gs`.
2. (Optional) set `NOTIFY_EMAIL` at the top to get an email per message.
3. **Deploy → New deployment → Web app** → Execute as **Me**, Who has access **Anyone** → Deploy, authorize.
4. Copy the Web App URL (ends in `/exec`) into `config.js` → `CONTACT_API_URL`.
5. After any later change to Code.gs: **Deploy → Manage deployments → Edit → New version**.

Submissions land in a sheet tab named `Contact Submissions`.
