'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

test('accessibility menu exposes contrast, reading and speech controls', () => {
  const script = read('js/a11y.js');
  const styles = read('a11y.css');

  for (const choice of ['default', 'high', 'max']) {
    assert.match(script, new RegExp(`data-contrast-choice="${choice}"`));
  }
  for (const option of ['spacing', 'dyslexia', 'highlight', 'speech']) {
    assert.match(script, new RegExp(`data-a11y-toggle="${option}"`));
  }
  assert.match(script, /SpeechSynthesisUtterance/);
  assert.match(script, /velofox-spacing/);

  assert.match(styles, /html\[data-contrast="high"\]/);
  assert.match(styles, /html\.a11y-spacing/);
  assert.match(styles, /html\.a11y-dyslexia/);
  assert.match(styles, /html\.a11y-highlight/);
});

test('accessibility labels are translated in every language', () => {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(read('js/i18n.js'), context);

  const strings = context.window.VeloFoxStrings;
  const keys = Object.keys(strings.en).filter((key) => key.startsWith('a11y.'));

  assert(keys.length >= 20);
  for (const [lang, dictionary] of Object.entries(strings)) {
    for (const key of keys) {
      assert.equal(typeof dictionary[key], 'string', `${lang} missing ${key}`);
      assert(dictionary[key].length > 0, `${lang} has an empty ${key}`);
    }
  }
});
