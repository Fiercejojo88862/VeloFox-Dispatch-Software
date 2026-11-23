'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canTransitionStatus, validateBooking } = require('../server').testables;

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

test('drop-off ends the driver trip and lets dispatch mark the job completed', () => {
  assert.equal(canTransitionStatus('passenger_aboard', 'dropped_off'), true);
  assert.equal(canTransitionStatus('passenger_aboard', 'completed'), false);
  assert.equal(canTransitionStatus('dropped_off', 'completed'), true);
  assert.equal(canTransitionStatus('dropped_off', 'cancelled'), false);
  assert.equal(canTransitionStatus('completed', 'pending'), false);
});

test('cancelled jobs can be reopened into any status', () => {
  const statuses = [
    'pending', 'confirmed', 'assigned', 'en_route', 'arrived',
    'passenger_aboard', 'dropped_off', 'completed',
  ];
  statuses.forEach((status) => {
    assert.equal(canTransitionStatus('cancelled', status), true, status);
  });
});

test('dispatcher dashboard shows on route, POB, dropped off and completed', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /en_route: 'On Route'/);
  assert.match(html, /passenger_aboard: 'POB'/);
  assert.match(html, /dropped_off: 'Dropped Off'/);
  assert.match(html, /completed: 'Completed'/);
  assert.match(html, /const TERMINAL_STATUSES = new Set\(\['dropped_off', 'completed', 'cancelled'\]\)/);
});

test('schema and driver portal accept the dropped-off status', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  assert.match(schema, /'passenger_aboard', 'dropped_off', 'completed', 'cancelled'/);
  const driver = fs.readFileSync(path.join(ROOT, 'public', 'driver.html'), 'utf8');
  assert.match(driver, /\{ status: 'dropped_off', label: 'Dropped Off' \}/);
});
