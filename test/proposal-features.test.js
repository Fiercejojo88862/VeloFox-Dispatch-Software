'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { validateBooking } = require('../server').testables;

const ROOT = path.join(__dirname, '..');

function validBooking(overrides = {}) {
  return {
    clientName: 'Joseph Shaker',
    clientEmail: 'joseph@example.com',
    clientPhone: '(201) 555-0142',
    pickupLocation: 'Newark Penn Station',
    dropoffLocation: 'Newark Liberty International Airport',
    pickupDateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    vehicleType: 'suv',
    passengerCount: 3,
    luggageNotes: 'Two heavy suitcases',
    beverageRequest: 'Sparkling water',
    specialRequests: 'Meet at the east entrance',
    preferredDriverId: 'VF-1002',
    ...overrides,
  };
}

test('booking validation preserves proposal request details', () => {
  const result = validateBooking(validBooking());
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.clientEmail, 'joseph@example.com');
  assert.equal(result.value.preferredDriverId, 'VF-1002');
  assert.equal(result.value.beverageRequest, 'Sparkling water');
  assert.equal(result.value.specialRequests, 'Meet at the east entrance');
});

test('booking validation rejects bad client and chauffeur data', () => {
  assert(validateBooking(validBooking({ clientEmail: 'invalid' })).errors.some((error) => error.includes('clientEmail')));
  assert(validateBooking(validBooking({ preferredDriverId: 'UNKNOWN' })).errors.some((error) => error.includes('preferredDriverId')));
});

test('fleet passenger capacities match the published vehicle limits', () => {
  assert.deepEqual(validateBooking(validBooking({ vehicleType: 'sprinter', passengerCount: 15 })).errors, []);
  assert.deepEqual(validateBooking(validBooking({ vehicleType: 'limousine', passengerCount: 16 })).errors, []);
  assert(validateBooking(validBooking({ vehicleType: 'sprinter', passengerCount: 16 })).errors.some((error) => error.includes('up to 15')));
  assert(validateBooking(validBooking({ vehicleType: 'suv', passengerCount: 7 })).errors.some((error) => error.includes('up to 6')));
});

test('every page loads the persistent theme controller', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((name) => name.endsWith('.html'));
  assert(pages.length > 0);
  pages.forEach((name) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
    assert.match(html, /href="\/theme\.css"/, name);
    assert.match(html, /src="\/js\/theme\.js"/, name);
  });
});

test('dispatcher dashboard uses Leaflet live telemetry map', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /leaflet@1\.9\.4/);
  assert.match(html, /id="telemetry-map"/);
  assert.match(html, /src="\/js\/telemetry-map\.js"/);
});
