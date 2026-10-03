/* Public, non-secret settings. Safe to commit: these are just URLs.
   The Groq API key is NEVER placed here — it lives in Apps Script's Script Properties. */
window.ECOSWITCH_CONFIG = {
  // The same Apps Script Web App serves both the chatbot and the contact form.
  CHAT_API_URL: 'https://script.google.com/macros/s/AKfycbwOkQH6xjJq3LtOuzev6eJzUMpe5OL1Pbiyql6uxOBnbpwSyuBWUU4wR2Iu-akBkVJX/exec',
  // Your Google Apps Script Web App URL (ends with /exec)
  CONTACT_API_URL: 'https://script.google.com/macros/s/AKfycbwOkQH6xjJq3LtOuzev6eJzUMpe5OL1Pbiyql6uxOBnbpwSyuBWUU4wR2Iu-akBkVJX/exec'
};
