(function accessibilityMenu() {
  'use strict';

  const LANG_KEY = 'velofox-lang';
  const SUPPORTED = ['en', 'es', 'fr', 'de', 'zh-CN'];
  const root = document.documentElement;

  function dictionary() {
    return window.VeloFoxStrings || { en: {} };
  }

  function storedLanguage() {
    try {
      const value = localStorage.getItem(LANG_KEY);
      return SUPPORTED.includes(value) ? value : 'en';
    } catch {
      return 'en';
    }
  }

  function text(lang, key) {
    const strings = dictionary();
    return strings[lang]?.[key] ?? strings.en?.[key] ?? '';
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
      set('[data-theme-choice="light"]', 'a11y.light');
      set('[data-theme-choice="dark"]', 'a11y.dark');

      const group = menu.querySelector('.a11y-menu__segments');
      if (group) group.setAttribute('aria-label', text(safeLang, 'a11y.theme'));

      const toggle = menu.querySelector('.a11y-menu__button');
      if (toggle) toggle.setAttribute('aria-label', text(safeLang, 'a11y.open'));
    }
  }

  function syncThemeButtons(menu) {
    const theme = window.VeloFoxTheme ? window.VeloFoxTheme.get() : (root.dataset.theme || 'dark');
    menu.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
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
          <label class="a11y-menu__label" for="a11y-language" data-a11y-language>Language</label>
          <select class="a11y-menu__select" id="a11y-language">
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </div>
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

    select.addEventListener('change', () => {
      try { localStorage.setItem(LANG_KEY, select.value); } catch { /* storage unavailable */ }
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
