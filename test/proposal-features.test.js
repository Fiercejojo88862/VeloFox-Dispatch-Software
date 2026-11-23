'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canTransitionStatus, normalizeDriverFields, validateBooking } = require('../server').testables;

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

test('live telemetry has a session-scoped clear toggle', () => {
  const dashboard = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dashboard, /id="telemetry-clear"[^>]*>Clear locations<\/button>/);
  assert.match(dashboard, /radar\.clear\(\)/);
  assert.match(dashboard, /radar\.resume\(\)/);
  const map = fs.readFileSync(path.join(ROOT, 'public', 'js', 'telemetry-map.js'), 'utf8');
  assert.match(map, /function clear\(\)/);
  assert.match(map, /function resume\(\)/);
  assert.match(map, /return \{ start, stop, refresh, clear, resume, destroy \}/);
});

test('ping fleet notifies drivers through their manifest', () => {
  const dashboard = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dashboard, /request\('\/api\/fleet\/ping', \{ method: 'POST' \}\)/);
  const driver = fs.readFileSync(path.join(ROOT, 'public', 'driver.html'), 'utf8');
  assert.match(driver, /data\.dispatchPingAt/);
  assert.match(driver, /Dispatch pinged you — check your manifest\./);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/fleet\/ping'/);
  assert.match(server, /dispatchPingAt/);
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS dispatch_pings/);
});

test('driver administration normalizes and validates driver fields', () => {
  const created = normalizeDriverFields({ id: 'vf-3005', name: '  Ada Driver  ', phone: ' 555 ', status: 'AVAILABLE' });
  assert.deepEqual(created.errors, []);
  assert.deepEqual(created.value, { id: 'VF-3005', name: 'Ada Driver', phone: '555', status: 'available' });

  const updated = normalizeDriverFields({ status: 'off_duty' }, { id: 'VF-1001', name: 'Marcus Vance', phone: '', status: 'available' });
  assert.deepEqual(updated.errors, []);
  assert.deepEqual(updated.value, { id: 'VF-1001', name: 'Marcus Vance', phone: null, status: 'off_duty' });

  const invalid = normalizeDriverFields({ id: 'bad id', name: '', phone: 12, status: 'retired' });
  assert.equal(invalid.errors.length, 4);
});

test('administrators have a driver dashboard backed by the database', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'drivers-admin.html'), 'utf8');
  assert.match(page, /href="\/theme\.css"/);
  assert.match(page, /src="\/js\/theme\.js"/);
  assert.match(page, /id="create-form"/);
  assert.match(page, /api\/admin\/drivers/);
  assert.match(page, /method: 'PATCH'/);

  const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  assert.match(admin, /href="\/drivers-admin\.html"/);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/drivers-admin\.html', requirePageAdmin\(\)/);
  assert.match(server, /app\.get\('\/api\/admin\/drivers', requireApiAdmin\(\)/);
  assert.match(server, /app\.post\('\/api\/admin\/drivers', requireApiAdmin\(\)/);
  assert.match(server, /app\.patch\('\/api\/admin\/drivers\/:id', requireApiAdmin\(\)/);

  const repo = fs.readFileSync(path.join(ROOT, 'lib', 'repository.js'), 'utf8');
  assert.match(repo, /async function listDrivers/);
  assert.match(repo, /async function createDriver/);
  assert.match(repo, /async function updateDriver/);
});

test('drivers can register themselves and keep a permanent submission history', () => {
  const portal = fs.readFileSync(path.join(ROOT, 'public', 'driver.html'), 'utf8');
  assert.match(portal, /id="register-form"/);
  assert.match(portal, /id="profile-form"/);
  assert.match(portal, /Delete my profile/);
  assert.match(portal, /\/api\/driver\/profile/);
  assert.match(portal, /your submissions remain with dispatch/i);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/driver\/profile'/);
  assert.match(server, /app\.patch\('\/api\/driver\/profile\/:id'/);
  assert.match(server, /app\.delete\('\/api\/driver\/profile\/:id'/);
  assert.match(server, /app\.get\('\/api\/admin\/driver-submissions', requireApiAdmin\(\)/);

  const repo = fs.readFileSync(path.join(ROOT, 'lib', 'repository.js'), 'utf8');
  assert.match(repo, /async function recordDriverSubmission/);
  assert.match(repo, /async function listDriverSubmissions/);
  assert.match(repo, /async function softDeleteDriver/);

  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  assert.match(schema, /deleted_at\s+timestamptz/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS driver_submissions/);
});

test('admin dashboard shows driver submissions even after deletion', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'drivers-admin.html'), 'utf8');
  assert.match(page, /id="submissions-body"/);
  assert.match(page, /api\/admin\/driver-submissions/);
  assert.match(page, /including profiles drivers later delete/);
  assert.match(page, /driver\.deletedAt \? 'deleted'/);
});
