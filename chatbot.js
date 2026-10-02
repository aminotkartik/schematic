(() => {
  'use strict';
  const cfg = window.ECOSWITCH_CONFIG || {};
  const MAX_INPUT = 500;
  const MAX_HISTORY = 8;
  const REQUEST_TIMEOUT_MS = 30000;
  const SUGGESTIONS = [
    'How does EcoSwitch decide to switch things off?',
    'Which sensors does it use?',
    'Why is a regulated power supply needed?'
  ];
  const history = [];
  let busy = false;

  const root = document.createElement('div');
  root.className = 'chat-widget';
  root.innerHTML = `
    <button class="chat-launcher" type="button" aria-expanded="false" aria-controls="chat-panel">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4Z"/><path d="M8 9.5h8M8 12.5h5"/></svg>
      <span>Ask EcoSwitch</span>
    </button>
    <section class="chat-panel" id="chat-panel" role="dialog" aria-label="EcoSwitch assistant" hidden>
      <header class="chat-header">
        <div><strong>ECOSWITCH ASSISTANT</strong><span><i class="status-dot"></i> AI · powered by Groq</span></div>
        <button class="icon-button chat-close" type="button" aria-label="Close assistant">×</button>
      </header>
      <div class="chat-log" role="log" aria-live="polite" aria-relevant="additions" tabindex="0"></div>
      <div class="chat-suggestions"></div>
      <form class="chat-form" autocomplete="off">
        <label class="chat-sr" for="chat-input">Your message</label>
        <textarea id="chat-input" rows="1" maxlength="${MAX_INPUT}" placeholder="Ask about EcoSwitch…"></textarea>
        <button class="chat-send" type="submit" aria-label="Send message">↑</button>
      </form>
      <p class="chat-note">AI can make mistakes. Verify hardware details before building.</p>
    </section>`;
  document.body.appendChild(root);

  const launcher = root.querySelector('.chat-launcher');
  const panel = root.querySelector('.chat-panel');
  const log = root.querySelector('.chat-log');
  const form = root.querySelector('.chat-form');
  const input = root.querySelector('#chat-input');
  const sendButton = root.querySelector('.chat-send');
  const suggestions = root.querySelector('.chat-suggestions');

  function addMessage(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `chat-msg chat-msg-${role}`;
    bubble.textContent = text; // textContent: model output is never parsed as HTML
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }
  function addTyping() {
    const bubble = document.createElement('div');
    bubble.className = 'chat-msg chat-msg-assistant chat-typing';
    bubble.setAttribute('aria-label', 'Assistant is typing');
    bubble.innerHTML = '<i></i><i></i><i></i>';
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function openPanel() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    if (!log.children.length) {
      addMessage('assistant', 'Hi! I can explain how EcoSwitch senses presence, warns, and switches zones off. What would you like to know?');
      SUGGESTIONS.forEach(text => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.textContent = text;
        chip.addEventListener('click', () => send(text));
        suggestions.appendChild(chip);
      });
    }
    input.focus();
  }
  function closePanel() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  launcher.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
  root.querySelector('.chat-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden && root.contains(document.activeElement)) closePanel();
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    send(input.value);
  });

  async function send(raw) {
    const text = raw.trim().slice(0, MAX_INPUT);
    if (!text || busy) return;
    suggestions.hidden = true;
    input.value = '';
    input.style.height = 'auto';
    addMessage('user', text);
    history.push({ role: 'user', content: text });

    if (!cfg.CHAT_API_URL) {
      addMessage('assistant', 'The assistant is not connected yet. Please check back soon.');
      history.pop();
      return;
    }

    busy = true;
    sendButton.disabled = true;
    const typing = addTyping();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(cfg.CHAT_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-MAX_HISTORY) }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error('rate');
      if (!response.ok || !data.reply) throw new Error('failed');
      typing.remove();
      addMessage('assistant', data.reply);
      history.push({ role: 'assistant', content: data.reply });
    } catch (error) {
      typing.remove();
      history.pop(); // drop the unanswered question so history stays alternating
      addMessage('assistant', error.message === 'rate'
        ? 'Lots of questions at once! Please wait a moment and try again.'
        : error.name === 'AbortError'
          ? 'That took too long. Please try again.'
          : 'Sorry, I could not reach the assistant. Please try again in a moment.');
    } finally {
      clearTimeout(timer);
      busy = false;
      sendButton.disabled = false;
      input.focus();
    }
  }
})();
