(() => {
  'use strict';
  const form = document.getElementById('contact-form');
  if (!form) return;

  const cfg = window.ECOSWITCH_CONFIG || {};
  const field = id => document.getElementById(id);
  const nameInput = field('contact-name');
  const emailInput = field('contact-email');
  const mobileInput = field('contact-mobile');
  const messageInput = field('contact-message');
  const honeypot = field('contact-website');
  const statusEl = field('contact-status');
  const counter = field('message-count');
  const submitButton = form.querySelector('button[type="submit"]');
  const submitLabel = form.querySelector('[data-submit-label]');
  const COOLDOWN_MS = 30000;
  let lastSent = 0;

  const setStatus = (message, kind = '') => {
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
  };
  const markInvalid = (input, invalid) => input.setAttribute('aria-invalid', invalid ? 'true' : 'false');

  messageInput.addEventListener('input', () => {
    counter.textContent = `${messageInput.value.length} / 1000`;
  });
  [nameInput, emailInput, mobileInput, messageInput].forEach(input =>
    input.addEventListener('input', () => markInvalid(input, false)));

  function validate() {
    const problems = [];
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const mobile = mobileInput.value.trim();
    const message = messageInput.value.trim();
    const digits = mobile.replace(/\D/g, '');

    const checks = [
      [nameInput, name.length >= 2, 'Please enter your name.'],
      [emailInput, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email), 'Please enter a valid email address.'],
      [mobileInput, /^\+?[0-9\s\-().]+$/.test(mobile) && digits.length >= 7 && digits.length <= 15, 'Please enter a valid mobile number (7–15 digits).'],
      [messageInput, message.length >= 10, 'Please write a message of at least 10 characters.']
    ];
    checks.forEach(([input, ok, text]) => {
      markInvalid(input, !ok);
      if (!ok) problems.push({ input, text });
    });
    return { problems, data: { name, email, mobile, message } };
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (honeypot.value) return; // bots fill hidden fields; silently drop

    const { problems, data } = validate();
    if (problems.length) {
      setStatus(problems[0].text, 'error');
      problems[0].input.focus();
      return;
    }
    if (!cfg.CONTACT_API_URL) {
      setStatus('The contact form is not connected yet. Please try again later.', 'error');
      return;
    }
    const wait = COOLDOWN_MS - (Date.now() - lastSent);
    if (wait > 0) {
      setStatus(`Please wait ${Math.ceil(wait / 1000)} s before sending another message.`, 'error');
      return;
    }

    submitButton.disabled = true;
    submitLabel.textContent = 'Sending…';
    setStatus('');

    try {
      // Apps Script web apps don't answer CORS preflights. A URL-encoded POST is a "simple"
      // request, and no-cors lets it through. The response is opaque, so a resolved fetch
      // means the request was delivered (it cannot confirm the sheet write).
      await fetch(cfg.CONTACT_API_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: new URLSearchParams({ ...data, website: '' })
      });
      lastSent = Date.now();
      form.reset();
      counter.textContent = '0 / 1000';
      setStatus('Thank you! Your message has been sent. We will get back to you soon.', 'success');
    } catch (_) {
      setStatus('Could not send your message. Check your connection and try again.', 'error');
    } finally {
      submitButton.disabled = false;
      submitLabel.textContent = 'Send message';
    }
  });
})();
