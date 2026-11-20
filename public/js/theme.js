(function themeController() {
  'use strict';

  const STORAGE_KEY = 'velofox-theme';
  const root = document.documentElement;

  function storedTheme() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;
    }
  }

  function preferredTheme() {
    return storedTheme()
      || (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }

  function apply(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f4efe5' : '#0b0b0b';
    const button = document.querySelector('.theme-toggle');
    if (button) {
      const next = theme === 'light' ? 'dark' : 'light';
      button.textContent = `${next === 'light' ? 'Light' : 'Dark'} mode`;
      button.setAttribute('aria-label', `Switch to ${next} mode`);
      button.setAttribute('aria-pressed', String(theme === 'light'));
    }
  }

  apply(preferredTheme());

  window.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.theme-toggle')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    button.addEventListener('click', () => {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
      apply(next);
    });
    document.body.append(button);
    apply(root.dataset.theme || preferredTheme());
  });
}());
