'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkPersonName,
  checkFreeText,
  checkLocation,
  sanitizeBody,
} = require('../lib/text-filter');

test('real names with accents, hyphens and particles pass', () => {
  for (const name of ['Joseph Shaker', 'Ana-María López', 'Sean O’Neill', 'Wei Chen', 'Ada van der Berg']) {
    assert.deepEqual(checkPersonName(name, 'Name').errors, [], name);
  }
});

test('obvious joke and keyboard-walk names are rejected', () => {
  for (const name of ['asdf', 'qwerty', 'test', 'xxx', 'joe mama', '123456', 'aaaa', '4sdf', 'Xiao']) {
    assert.ok(checkPersonName(name, 'Name').errors.length > 0, name);
  }
});

test('names containing links, phones or invisible characters are handled', () => {
  assert.deepEqual(checkPersonName('Jo\u200bhn Doe', 'Name').value, 'John Doe');
  assert.match(checkPersonName('John Doe https://troll.example', 'Name').errors.join(' '), /link/);
  assert.match(checkPersonName('John Doe 2015550123', 'Name').errors.join(' '), /phone/);
});

test('free text allows normal notes but blocks abuse and payloads', () => {
  assert.deepEqual(checkFreeText('Meet at the east entrance, 2 suitcases + car seat.', 'Notes').errors, []);
  assert.match(checkFreeText('<script>alert(1)</script>', 'Notes').errors.join(' '), /script/);
  assert.match(checkFreeText('what the fuck', 'Notes').errors.join(' '), /offensive/);
  assert.match(checkFreeText('https://troll.example', 'Notes').errors.join(' '), /links/);
  assert.match(checkFreeText('aaaaaaaaaaaaaaaaaaaa', 'Notes').errors.join(' '), /repeated/);
});

test('locations accept addresses but reject joke values', () => {
  assert.deepEqual(checkLocation('Newark Penn Station', 'pickupLocation').errors, []);
  assert.deepEqual(checkLocation('100 Main St, Suite 2', 'pickupLocation').errors, []);
  assert.ok(checkLocation('asdf', 'pickupLocation').errors.length > 0);
  assert.ok(checkLocation('123', 'pickupLocation').errors.length > 0);
  assert.ok(checkLocation('<img src=x onerror=alert(1)>', 'pickupLocation').errors.length > 0);
});

test('body sanitizer strips invisible characters but leaves credentials alone', () => {
  const body = { clientName: 'Jo\u200bhn Doe', specialRequests: 'hi\u2060there', password: 'a\u200bb' };
  const req = { body };
  let called = false;
  sanitizeBody(req, {}, () => { called = true; });
  assert.equal(called, true);
  assert.equal(body.clientName, 'John Doe');
  assert.equal(body.specialRequests, 'hithere');
  assert.equal(body.password, 'a\u200bb');
});
