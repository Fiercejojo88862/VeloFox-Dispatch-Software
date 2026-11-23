(function velofoxTextFilter() {
  'use strict';

  // Deliberate mirror of lib/text-filter.js for instant feedback only.
  // The server remains the enforcement point.
  const JOKE = new Set([
    'asdf', 'asdfgh', 'asdfghjkl', 'qwerty', 'qwertyuiop', 'zxcv', 'zxcvbnm',
    '123456', '1234567890', 'test', 'tester', 'testing', 'testtest', 'test123',
    'iamatest', 'xxx', 'xxxx', 'xxxxx', 'joemama', 'mickeymouse', 'johndoe',
    'janedoe', 'foobar', 'barfoo', 'loremipsum', 'dolorsitamet', 'anonymous',
    'noname', 'noone', 'nobody', 'dummy', 'sample', 'troll', 'hacker', 'lol', 'idk',
  ]);
  const STRONG = new Set([
    'asdf', 'asdfgh', 'asdfghjkl', 'qwerty', 'qwertyuiop', 'zxcv', 'zxcvbnm',
    '123456', '1234567890', 'xxx', 'xxxx', 'xxxxx',
  ]);
  const ABUSE = [
    'fuck', 'fucking', 'fucker', 'shit', 'bullshit', 'bitch', 'bastard',
    'asshole', 'dickhead', 'prick', 'piss', 'slut', 'whore', 'cunt',
    'faggot', 'retard', 'wtf', 'stfu', 'dumbass', 'jackass',
  ];
  const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i' };
  const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
  const SCRIPT = /<\s*\/?\s*(script|iframe|img|svg|style|object|embed|link|meta)\b|javascript:|vbscript:|on(?:error|load|click|focus|mouseover)\s*=/i;
  const URL = /(?:https?:\/\/|www\.)\S+/i;
  const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const PHONE = /\+?\d[\d\s().-]{7,}\d/;

  function fold(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[01345789@$!]/g, (char) => LEET[char] || char)
      .replace(/[^a-z0-9]+/g, '');
  }

  function walk(folded) {
    if (folded.length < 5) return false;
    return ROWS.some((row) => row.includes(folded) || [...row].reverse().join('').includes(folded));
  }

  function hasJokeToken(text, strongOnly) {
    return text.split(/[\s\-_/]+/).filter(Boolean).some((token) => {
      const folded = fold(token);
      return (strongOnly ? STRONG.has(folded) : JOKE.has(folded)) || walk(folded);
    });
  }

  function clean(value) {
    return String(value || '').replace(INVISIBLE, '').replace(/[ \t]+/g, ' ').trim();
  }

  function check(kind, value) {
    const text = clean(value);
    if (!text) return true;
    const folded = fold(text);
    const words = text.split(/\s+/).filter(Boolean);

    if (kind === 'name') {
      return !JOKE.has(folded)
        && !walk(folded)
        && !hasJokeToken(text, false)
        && /\p{L}/u.test(text)
        && !/(.)\1{3,}/.test(folded)
        && (folded.match(/\d/g) || []).length <= 2
        && !SCRIPT.test(text)
        && !URL.test(text)
        && !EMAIL.test(text)
        && !PHONE.test(text)
        && words.length >= 2
        && !words.some((word) => word.length > 30);
    }
    if (kind === 'location') {
      return folded.length >= 4
        && /\p{L}/u.test(text)
        && !JOKE.has(folded)
        && !walk(folded)
        && !hasJokeToken(text, false)
        && !/(.)\1{7,}/.test(folded)
        && !SCRIPT.test(text)
        && !URL.test(text)
        && !EMAIL.test(text);
    }
    return !SCRIPT.test(text)
      && !ABUSE.some((term) => folded.includes(term))
      && !URL.test(text)
      && !EMAIL.test(text)
      && !/(.)\1{7,}/i.test(text)
      && !walk(folded)
      && !hasJokeToken(text, true);
  }

  function message(kind) {
    const lang = document.documentElement.lang || 'en';
    const strings = window.VeloFoxStrings || {};
    const fallback = { name: 'Please enter a real first and last name.', text: 'Please remove links, offensive language, or repeated characters.', location: 'Please enter a valid pickup or drop-off location.' };
    return strings[lang]?.[`filter.${kind}`] || strings.en?.[`filter.${kind}`] || fallback[kind] || fallback.name;
  }

  function bind(input) {
    const kind = input.dataset.filter;
    if (!kind) return;

    const existing = input.id ? document.getElementById(`${input.id}-error`) : null;
    const hint = existing || document.createElement('p');
    if (!existing) {
      hint.className = 'filter-hint';
      hint.setAttribute('role', 'status');
      hint.style.cssText = 'color:var(--red,#e06c6c);font-size:12px;margin:6px 0 0;';
      input.insertAdjacentElement('afterend', hint);
      if (input.id) {
        hint.id = `filter-hint-${input.id}`;
        const describedBy = input.getAttribute('aria-describedby');
        input.setAttribute('aria-describedby', describedBy ? `${describedBy} ${hint.id}` : hint.id);
      }
    }
    hint.hidden = true;

    function update() {
      const valid = check(kind, input.value);
      hint.hidden = valid;
      hint.textContent = valid ? '' : message(kind);
      if (valid) input.removeAttribute('aria-invalid');
      else input.setAttribute('aria-invalid', 'true');
      return valid;
    }

    input.addEventListener('blur', update);
    input.addEventListener('input', () => { if (hint.textContent) update(); });

    const form = input.form;
    if (form && input.dataset.filterBlock !== 'false') {
      form.addEventListener('submit', (event) => {
        if (!update()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          input.focus();
        }
      }, true);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-filter]').forEach(bind);
  });

  window.VeloFoxFilter = { check, message };
}());
