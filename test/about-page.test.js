'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');

test('about page is linked from the public site and loads shared controllers', () => {
  const about = read('about.html');

  assert.match(about, /<link rel="stylesheet" href="\/theme\.css">/);
  assert.match(about, /<script src="\/js\/theme\.js"><\/script>/);
  assert.match(about, /<script src="\/js\/i18n\.js"><\/script>/);
  assert.match(about, /<script src="\/js\/a11y\.js"><\/script>/);
  assert.match(about, /<a class="nav-link" href="\/about\.html" aria-current="page"/);
  assert.match(about, /src="\/assets\/about\/Mercedes\.webp"/);
  assert.match(about, /2004 Mercedes S-Class/);
  assert.doesNotMatch(about, /about-figure__credit/);

  for (const page of ['index.html', 'booking.html', 'fleet.html']) {
    assert.match(read(page), /href="\/about\.html"/, `${page} should link to About us`);
  }
});

test('about story is translated in all five languages', () => {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(read('js/i18n.js'), context);

  const strings = context.window.VeloFoxStrings;
  const languages = ['en', 'es', 'fr', 'de', 'zh-CN'];
  const keys = Object.keys(strings.en).filter((key) => key.startsWith('about.') || key === 'nav.about' || key === 'doc.title.about');

  assert.deepEqual(Object.keys(strings), languages);
  assert(keys.length >= 30);

  for (const lang of languages) {
    for (const key of keys) {
      assert.equal(typeof strings[lang][key], 'string', `${lang} missing ${key}`);
      assert(strings[lang][key].length > 0, `${lang} has an empty ${key}`);
    }
  }

  const about = read('about.html');
  for (const key of keys) {
    assert(about.includes(`data-i18n="${key}"`) || about.includes(`data-i18n-alt="${key}"`) || ['nav.about', 'doc.title.about'].includes(key), `about.html does not use ${key}`);
  }
});

test('fleet cards use a simple hover state without drive animations', () => {
  const fleet = read('fleet.html');

  for (const vehicle of ['sedan', 'suv', 'sprinter', 'limousine']) {
    assert.match(fleet, new RegExp(`data-vehicle="${vehicle}"`));
  }

  assert.match(fleet, /\.fleet-card:hover \.fleet-card__media img \{\s*transform: scale\(1\.05\);/);
  assert.doesNotMatch(fleet, /fleet-drive-up|fleet-drive-light|--drive-time/);
  assert.doesNotMatch(fleet, /fleet-card:hover \.fleet-card__media::before/);
});
