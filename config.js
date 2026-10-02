/* Public, non-secret settings. Safe to commit: these are just URLs.
   The Groq API key is NEVER placed here — it lives in GitHub Secrets and the Worker. */
window.ECOSWITCH_CONFIG = {
  // Your deployed Cloudflare Worker URL, e.g. https://ecoswitch-chat.your-name.workers.dev
  CHAT_API_URL: '',
  // Your Google Apps Script Web App URL (ends with /exec)
  CONTACT_API_URL: ''
};
