# EcoSwitch — schematic

Intelligent classroom energy management: an interactive, browser-based simulation of a three-zone classroom.

```
index.html / style.css / script.js   the site
config.js                            public URL of the Apps Script Web App
chatbot.js                           chat widget (talks to Apps Script, never to Groq directly)
contact.js                           contact form (posts to Apps Script)
google-apps-script/Code.gs           backend: contact form -> Google Sheet, chatbot -> Groq
optional-cloudflare/                 unused alternative backend (Cloudflare Worker)
```

## Backend setup (Google Apps Script — one deployment for chat + contact form)

1. Create a Google Sheet → **Extensions → Apps Script**. Replace the code with `google-apps-script/Code.gs`.
2. **Save the Groq key:** gear icon **Project Settings → Script properties → Add script property**
   - Property: `GROQ_API_KEY`
   - Value: your key from https://console.groq.com/keys (starts with `gsk_`)
3. Pick `testChat` in the function dropdown → **Run** → accept the permission prompts
   (the "Connect to an external service" permission is what lets the script call Groq).
   The Execution log should print a reply with `"ok":true`.
4. **Deploy → New deployment → Web app** (or **Manage deployments → Edit → New version**
   if you already have one). Execute as **Me**, access **Anyone**.
5. Put the Web App URL (ends in `/exec`) in `config.js` as both `CHAT_API_URL` and `CONTACT_API_URL`.
6. Open the `/exec` URL in a browser: you should see `"chatConfigured":true`.

After **any** edit to Code.gs you must create a **new version** of the deployment, or the live URL keeps running the old code.

## Notes
- The Groq key exists only in Script Properties. It is not in the repo, `config.js`, or the browser.
- Built-in limits: 20 chat requests/minute and 500/day across all visitors (edit at the top of Code.gs).
- Google's free quota is 20,000 URL Fetch calls/day (Gmail accounts).
- Contact submissions are saved in a tab named `Contact Submissions`.
