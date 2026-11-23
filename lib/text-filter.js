'use strict';

// Set to false if single-word names (e.g. "Xiao", "Adebayo") must be accepted.
const REQUIRE_TWO_PART_NAMES = true;

// Invisible characters trolls use to hide words from naive filters, minus
// normal whitespace (newlines/tabs are preserved).
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

const SCRIPT = /<\s*\/?\s*(script|iframe|img|svg|style|object|embed|link|meta)\b|javascript:|vbscript:|on(?:error|load|click|focus|mouseover)\s*=/i;
const URL_ANY = /(?:https?:\/\/|www\.)\S+/i;
const EMAIL_ANY = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_IN_NAME = /\+?\d[\d\s().-]{7,}\d/;

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i' };

// Folded (lowercase, de-accented, leet-normalised, punctuation-free) values
// that are never plausible as a person's name.
const JOKE_NAMES = new Set([
  'asdf', 'asdfgh', 'asdfghjkl', 'qwerty', 'qwertyuiop', 'zxcv', 'zxcvbnm',
  '123456', '1234567890', 'test', 'tester', 'testing', 'testtest', 'test123',
  'iamatest', 'xxx', 'xxxx', 'xxxxx', 'joemama', 'mickeymouse', 'johndoe',
  'janedoe', 'foobar', 'barfoo', 'loremipsum', 'dolorsitamet', 'anonymous',
  'noname', 'noone', 'nobody', 'dummy', 'sample', 'troll', 'hacker', 'lol', 'idk',
]);

// Tokens that are harmless inside a sentence but never part of a real name.
const STRONG_JOKE = new Set([
  'asdf', 'asdfgh', 'asdfghjkl', 'qwerty', 'qwertyuiop', 'zxcv', 'zxcvbnm',
  '123456', '1234567890', 'xxx', 'xxxx', 'xxxxx',
]);

const ABUSE_TERMS = [
  'fuck', 'fucking', 'fucker', 'shit', 'bullshit', 'bitch', 'bastard',
  'asshole', 'dickhead', 'prick', 'piss', 'slut', 'whore', 'cunt',
  'faggot', 'retard', 'wtf', 'stfu', 'dumbass', 'jackass',
];

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];
const SKIP_SANITIZE = new Set(['password', 'newPassword', 'confirmPassword', 'accessCode', 'inviteCode', 'code', 'token']);

function stripInvisible(value) {
  return String(value).replace(INVISIBLE, '');
}

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[01345789@$!]/g, (char) => LEET[char] || char)
    .replace(/[^a-z0-9]+/g, '');
}

function keyboardWalk(folded) {
  if (folded.length < 5) return false;
  return KEY_ROWS.some((row) => row.includes(folded) || [...row].reverse().join('').includes(folded));
}

function hasJokeToken(text, strongOnly = false) {
  return text.split(/[\s\-_/]+/).filter(Boolean).some((token) => {
    const folded = fold(token);
    return (strongOnly ? STRONG_JOKE.has(folded) : JOKE_NAMES.has(folded)) || keyboardWalk(folded);
  });
}

function oneLine(value) {
  return stripInvisible(value).replace(/[ \t]+/g, ' ').trim();
}

function unique(errors) {
  return [...new Set(errors)];
}

function checkPersonName(value, label = 'Name') {
  const cleaned = oneLine(value);
  if (!cleaned) return { errors: [], value: cleaned }; // required-field checks own this

  const errors = [];
  const folded = fold(cleaned);
  const words = cleaned.split(/\s+/).filter(Boolean);

  if (JOKE_NAMES.has(folded) || keyboardWalk(folded) || hasJokeToken(cleaned)) {
    errors.push(`${label} must be a real name.`);
  }
  if (!/\p{L}/u.test(cleaned)) {
    errors.push(`${label} must contain letters.`);
  }
  if (/(.)\1{3,}/.test(folded)) {
    errors.push(`${label} must not contain repeated characters.`);
  }
  if ((folded.match(/\d/g) || []).length > 2) {
    errors.push(`${label} must not contain numbers.`);
  }
  if (SCRIPT.test(cleaned) || URL_ANY.test(cleaned) || EMAIL_ANY.test(cleaned) || PHONE_IN_NAME.test(cleaned)) {
    errors.push(`${label} must be a name, not a link, email address, or phone number.`);
  }
  if (REQUIRE_TWO_PART_NAMES && words.length < 2) {
    errors.push(`${label} must include a first and last name.`);
  }
  if (words.some((word) => word.length > 30)) {
    errors.push(`${label} contains an unusually long word.`);
  }

  return { errors: unique(errors), value: cleaned };
}

function checkFreeText(value, label = 'Message') {
  const cleaned = stripInvisible(value).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return { errors: [], value: cleaned };

  const errors = [];
  const folded = fold(cleaned);

  if (SCRIPT.test(cleaned)) {
    errors.push(`${label} must not contain scripts or markup.`);
  }
  if (ABUSE_TERMS.some((term) => folded.includes(term))) {
    errors.push(`${label} must not contain offensive language.`);
  }
  if (URL_ANY.test(cleaned) || EMAIL_ANY.test(cleaned)) {
    errors.push(`${label} must not contain links or email addresses.`);
  }
  if (/(.)\1{7,}/i.test(cleaned) || keyboardWalk(folded) || hasJokeToken(cleaned, true)) {
    errors.push(`${label} must not contain repeated or random characters.`);
  }

  return { errors: unique(errors), value: cleaned };
}

function checkLocation(value, label = 'Location') {
  const cleaned = oneLine(value);
  if (!cleaned) return { errors: [], value: cleaned };

  const errors = [];
  const folded = fold(cleaned);

  if (folded.length < 4 || !/\p{L}/u.test(cleaned)) {
    errors.push(`${label} must be a valid address or place name.`);
  }
  if (JOKE_NAMES.has(folded) || keyboardWalk(folded) || hasJokeToken(cleaned) || /(.)\1{7,}/.test(folded)) {
    errors.push(`${label} must be a valid address or place name.`);
  }
  if (SCRIPT.test(cleaned) || URL_ANY.test(cleaned) || EMAIL_ANY.test(cleaned)) {
    errors.push(`${label} must not contain links or markup.`);
  }

  return { errors: unique(errors), value: cleaned };
}

function sanitizeValue(value) {
  if (typeof value === 'string') {
    return stripInvisible(value).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SKIP_SANITIZE.has(key)) continue;
      value[key] = sanitizeValue(child);
    }
  }
  return value;
}

function sanitizeBody(req, res, next) {
  if (req.body) sanitizeValue(req.body);
  next();
}

module.exports = {
  checkPersonName,
  checkFreeText,
  checkLocation,
  sanitizeBody,
  stripInvisible,
  fold,
};
