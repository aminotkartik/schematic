# Optional: Cloudflare Worker chat backend (not used by default)

The site's chatbot uses Google Apps Script (see the main README). This folder keeps the
alternative in case you want an origin-restricted backend and faster responses.

To switch: move `worker/` to the repo root, move `deploy-chat-worker.yml` to `.github/workflows/`,
add the GitHub secrets `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, set
`ALLOWED_ORIGINS` in `worker/wrangler.toml`, then point `CHAT_API_URL` in `config.js` at the Worker
and change `chatbot.js` back to a normal JSON POST that reads `{ reply }`.
