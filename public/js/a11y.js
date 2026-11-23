(function accessibilityMenu() {
  'use strict';

  const LANG_KEY = 'velofox-lang';
  const CONTRAST_KEY = 'velofox-contrast';
  const SUPPORTED = ['en', 'es', 'fr', 'de', 'zh-CN'];
  const CONTRASTS = ['default', 'high', 'max'];
  const TOGGLES = [
    { name: 'spacing', storage: 'velofox-spacing', className: 'a11y-spacing' },
    { name: 'dyslexia', storage: 'velofox-dyslexia', className: 'a11y-dyslexia' },
    { name: 'highlight', storage: 'velofox-highlight', className: 'a11y-highlight' },
  ];
  const root = document.documentElement;
  let speaking = false;
  let speechToken = 0;

  function read(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }

  function dictionary() {
    return window.VeloFoxStrings || { en: {} };
  }

  function storedLanguage() {
    const value = read(LANG_KEY, 'en');
    return SUPPORTED.includes(value) ? value : 'en';
  }

  function text(lang, key) {
    const strings = dictionary();
    return strings[lang]?.[key] ?? strings.en?.[key] ?? '';
  }

  function syncOptions(menu, lang) {
    if (!menu) return;

    const contrast = root.dataset.contrast || 'default';
    menu.querySelectorAll('[data-contrast-choice]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.contrastChoice === contrast));
    });

    TOGGLES.forEach((option) => {
      const button = menu.querySelector(`[data-a11y-toggle="${option.name}"]`);
      if (!button) return;
      const on = root.classList.contains(option.className);
      button.setAttribute('aria-pressed', String(on));
      const state = button.querySelector('.a11y-menu__toggle-state');
      if (state) state.textContent = text(lang, on ? 'a11y.on' : 'a11y.off');
    });

    const speech = menu.querySelector('[data-a11y-toggle="speech"]');
    if (speech) {
      speech.setAttribute('aria-pressed', String(speaking));
      const label = speech.querySelector('.a11y-menu__toggle-label');
      if (label) label.textContent = text(lang, speaking ? 'a11y.speech.stop' : 'a11y.speech');
      const state = speech.querySelector('.a11y-menu__toggle-state');
      if (state) state.textContent = text(lang, speaking ? 'a11y.on' : 'a11y.off');
    }
  }

  function applyLanguage(lang) {
    const safeLang = SUPPORTED.includes(lang) ? lang : 'en';
    const strings = dictionary()[safeLang] || {};

    root.lang = safeLang;

    document.querySelectorAll('[data-i18n]').forEach((node) => {
      const value = strings[node.getAttribute('data-i18n')];
      if (value != null) node.textContent = value;
    });

    document.querySelectorAll('[data-i18n-html]').forEach((node) => {
      const value = strings[node.getAttribute('data-i18n-html')];
      if (value != null) node.innerHTML = value;
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      const value = strings[node.getAttribute('data-i18n-placeholder')];
      if (value != null) node.setAttribute('placeholder', value);
    });

    document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
      const value = strings[node.getAttribute('data-i18n-aria-label')];
      if (value != null) node.setAttribute('aria-label', value);
    });

    document.querySelectorAll('[data-i18n-alt]').forEach((node) => {
      const value = strings[node.getAttribute('data-i18n-alt')];
      if (value != null) node.setAttribute('alt', value);
    });

    const menu = document.querySelector('.a11y-menu');
    if (menu) {
      const set = (selector, key) => {
        const node = menu.querySelector(selector);
        if (node) node.textContent = text(safeLang, key);
      };

      set('[data-a11y-title]', 'a11y.title');
      set('[data-a11y-theme]', 'a11y.theme');
      set('[data-a11y-language]', 'a11y.language');
      set('[data-a11y-contrast]', 'a11y.contrast');
      set('[data-a11y-reading]', 'a11y.reading');
      set('[data-theme-choice="light"]', 'a11y.light');
      set('[data-theme-choice="dark"]', 'a11y.dark');
      set('[data-contrast-choice="default"]', 'a11y.contrast.default');
      set('[data-contrast-choice="high"]', 'a11y.contrast.high');
      set('[data-contrast-choice="max"]', 'a11y.contrast.max');
      set('[data-a11y-toggle="spacing"] .a11y-menu__toggle-label', 'a11y.spacing');
      set('[data-a11y-toggle="dyslexia"] .a11y-menu__toggle-label', 'a11y.dyslexia');
      set('[data-a11y-toggle="highlight"] .a11y-menu__toggle-label', 'a11y.highlight');

      const themeGroup = menu.querySelector('.a11y-menu__segments');
      if (themeGroup) themeGroup.setAttribute('aria-label', text(safeLang, 'a11y.theme'));

      const contrastGroup = menu.querySelector('.a11y-menu__segments--contrast');
      if (contrastGroup) contrastGroup.setAttribute('aria-label', text(safeLang, 'a11y.contrast'));

      const toggle = menu.querySelector('.a11y-menu__button');
      if (toggle) toggle.setAttribute('aria-label', text(safeLang, 'a11y.open'));

      syncOptions(menu, safeLang);
    }
  }

  function syncThemeButtons(menu) {
    const theme = window.VeloFoxTheme ? window.VeloFoxTheme.get() : (root.dataset.theme || 'dark');
    menu.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
    });
  }

  function applyContrast(value) {
    const mode = CONTRASTS.includes(value) ? value : 'default';
    if (mode === 'default') root.removeAttribute('data-contrast');
    else root.dataset.contrast = mode;
    write(CONTRAST_KEY, mode);
  }

  function applyToggle(option, on) {
    root.classList.toggle(option.className, Boolean(on));
    write(option.storage, on ? '1' : '0');
  }

  function setStatus(menu, message) {
    if (!menu) return;
    const status = menu.querySelector('[data-a11y-status]');
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !message;
  }

  function speechBlocks() {
    const selector = [
      'main :is(h1, h2, h3, h4, p, li, blockquote, figcaption)',
      'body > section :is(h1, h2, h3, h4, p, li, blockquote, figcaption)',
      'body > div > section :is(h1, h2, h3, h4, p, li, blockquote, figcaption)',
    ].join(', ');

    return Array.from(document.querySelectorAll(selector))
      .filter((node) => !node.closest('.a11y-menu, nav, .topbar, .site-footer, [aria-hidden="true"]'))
      .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function chunkText(value, max = 240) {
    const sentences = value.match(/[^.!?。！？]+[.!?。！？]?/g) || [value];
    const chunks = [];
    let current = '';

    sentences.forEach((sentence) => {
      let piece = sentence.trim();
      if (!piece) return;

      if (current && current.length + piece.length + 1 > max) {
        chunks.push(current);
        current = '';
      }

      while (piece.length > max) {
        const cut = piece.lastIndexOf(' ', max);
        chunks.push(piece.slice(0, cut > 0 ? cut : max).trim());
        piece = piece.slice(cut > 0 ? cut : max).trim();
      }

      current = current ? `${current} ${piece}` : piece;
    });

    if (current) chunks.push(current);
    return chunks;
  }

  function stopSpeech(menu) {
    speechToken += 1;
    speaking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    syncOptions(menu, storedLanguage());
  }

  function startSpeech(menu) {
    const synth = window.speechSynthesis;
    const lang = storedLanguage();

    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      setStatus(menu, text(lang, 'a11y.speech.unsupported'));
      return;
    }

    const chunks = speechBlocks().reduce((all, block) => all.concat(chunkText(block)), []);
    if (!chunks.length) {
      setStatus(menu, text(lang, 'a11y.speech.empty'));
      return;
    }

    setStatus(menu, '');
    const token = ++speechToken;
    speaking = true;
    syncOptions(menu, lang);

    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = root.lang || 'en';
      utterance.rate = 0.95;

      if (index === chunks.length - 1) {
        const finish = () => {
          if (token !== speechToken) return;
          speaking = false;
          syncOptions(menu, lang);
        };
        utterance.onend = finish;
        utterance.onerror = finish;
      }

      synth.speak(utterance);
    });
  }

  function buildMenu() {
    const wrap = document.createElement('div');
    wrap.className = 'a11y-menu';
    wrap.innerHTML = `
      <div class="a11y-menu__panel" id="a11y-panel" hidden>
        <p class="a11y-menu__title" data-a11y-title>Accessibility</p>
        <div class="a11y-menu__row">
          <span class="a11y-menu__label" data-a11y-theme>Theme</span>
          <div class="a11y-menu__segments" role="group" aria-label="Theme">
            <button type="button" class="a11y-menu__segment" data-theme-choice="light" aria-pressed="false">Light</button>
            <button type="button" class="a11y-menu__segment" data-theme-choice="dark" aria-pressed="false">Dark</button>
          </div>
        </div>
        <div class="a11y-menu__row">
          <span class="a11y-menu__label" data-a11y-contrast>Contrast</span>
          <div class="a11y-menu__segments a11y-menu__segments--contrast" role="group" aria-label="Contrast">
            <button type="button" class="a11y-menu__segment" data-contrast-choice="default" aria-pressed="true">Default</button>
            <button type="button" class="a11y-menu__segment" data-contrast-choice="high" aria-pressed="false">High</button>
            <button type="button" class="a11y-menu__segment" data-contrast-choice="max" aria-pressed="false">Max</button>
          </div>
        </div>
        <div class="a11y-menu__row">
          <label class="a11y-menu__label" for="a11y-language" data-a11y-language>Language</label>
          <select class="a11y-menu__select" id="a11y-language">
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </div>
        <div class="a11y-menu__row">
          <span class="a11y-menu__label" data-a11y-reading>Reading</span>
          <div class="a11y-menu__toggles">
            <button type="button" class="a11y-menu__toggle" data-a11y-toggle="spacing" aria-pressed="false">
              <span class="a11y-menu__toggle-label">Text spacing</span>
              <span class="a11y-menu__toggle-state" aria-hidden="true">Off</span>
            </button>
            <button type="button" class="a11y-menu__toggle" data-a11y-toggle="dyslexia" aria-pressed="false">
              <span class="a11y-menu__toggle-label">Dyslexia friendly</span>
              <span class="a11y-menu__toggle-state" aria-hidden="true">Off</span>
            </button>
            <button type="button" class="a11y-menu__toggle" data-a11y-toggle="highlight" aria-pressed="false">
              <span class="a11y-menu__toggle-label">Highlight links</span>
              <span class="a11y-menu__toggle-state" aria-hidden="true">Off</span>
            </button>
            <button type="button" class="a11y-menu__toggle" data-a11y-toggle="speech" aria-pressed="false">
              <span class="a11y-menu__toggle-label">Read page aloud</span>
              <span class="a11y-menu__toggle-state" aria-hidden="true">Off</span>
            </button>
          </div>
        </div>
        <p class="a11y-menu__status" data-a11y-status role="status" aria-live="polite" hidden></p>
      </div>
      <button type="button" class="a11y-menu__button" aria-expanded="false" aria-controls="a11y-panel" aria-label="Accessibility and language options">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="4.4" r="1.9" fill="currentColor" stroke="none"/>
          <path d="M4.6 8.4h14.8"/>
          <path d="M12 8.4v5.6"/>
          <path d="M12 14l-3.6 5.6"/>
          <path d="M12 14l3.6 5.6"/>
        </svg>
      </button>
    `;

    document.body.append(wrap);

    const toggle = wrap.querySelector('.a11y-menu__button');
    const panel = wrap.querySelector('.a11y-menu__panel');
    const select = wrap.querySelector('#a11y-language');

    const close = (restoreFocus) => {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    };

    applyContrast(read(CONTRAST_KEY, 'default'));
    TOGGLES.forEach((option) => applyToggle(option, read(option.storage, '0') === '1'));

    toggle.addEventListener('click', () => {
      if (panel.hidden) {
        panel.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        syncThemeButtons(wrap);
      } else {
        close(false);
      }
    });

    wrap.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        window.VeloFoxTheme?.set(button.dataset.themeChoice);
        syncThemeButtons(wrap);
      });
    });

    wrap.querySelectorAll('[data-contrast-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        applyContrast(button.dataset.contrastChoice);
        syncOptions(wrap, select.value);
      });
    });

    TOGGLES.forEach((option) => {
      const button = wrap.querySelector(`[data-a11y-toggle="${option.name}"]`);
      button?.addEventListener('click', () => {
        applyToggle(option, !root.classList.contains(option.className));
        syncOptions(wrap, select.value);
      });
    });

    wrap.querySelector('[data-a11y-toggle="speech"]')?.addEventListener('click', () => {
      if (speaking) stopSpeech(wrap);
      else startSpeech(wrap);
    });

    select.addEventListener('change', () => {
      if (speaking) stopSpeech(wrap);
      setStatus(wrap, '');
      write(LANG_KEY, select.value);
      applyLanguage(select.value);
      document.dispatchEvent(new CustomEvent('velofox:language', { detail: { lang: select.value } }));
    });

    document.addEventListener('click', (event) => {
      if (!panel.hidden && !wrap.contains(event.target)) close(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) close(true);
    });

    root.addEventListener('velofox:theme', () => syncThemeButtons(wrap));

    select.value = storedLanguage();
    applyLanguage(select.value);
    syncThemeButtons(wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildMenu, { once: true });
  } else {
    buildMenu();
  }
}());
