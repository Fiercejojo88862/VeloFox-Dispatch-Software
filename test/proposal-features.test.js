'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  canTransitionStatus,
  canViewPageDirectory,
  normalizeDriverFields,
  validateBooking,
} = require('../server').testables;

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

test('ride summary buttons open the matching rides list', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /document\.createElement\('button'\)/);
  assert.match(html, /data-tab="all"/);
  assert.match(html, /setBookingsTab\('all'\)/);
  assert.match(html, /applyFilter\(status\)/);
  assert.match(html, /statsEl\.addEventListener\('click'/);
  assert.match(html, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
});

test('page directory is limited to Joseph Shaker as a dispatcher administrator', () => {
  assert.equal(canViewPageDirectory({
    role: 'dispatcher', isAdmin: true, email: 'JosephShaker2020@aol.com',
  }), true);
  assert.equal(canViewPageDirectory({
    role: 'dispatcher', isAdmin: false, email: 'JosephShaker2020@aol.com',
  }), false);
  assert.equal(canViewPageDirectory({
    role: 'dispatcher', isAdmin: true, email: 'another-admin@example.com',
  }), false);

  const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /id="pages-panel"[^>]*hidden/);
  assert.match(html, /session\?\.user\?\.canViewPageDirectory/);
  assert.match(html, /pagesPanel\.remove\(\)/);
});

test('new dispatchers receive a replayable tour and can save a custom dashboard order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(html, /id="tour-replay"/);
  assert.match(html, /id="customize-dashboard"/);
  assert.match(html, /id="dashboard-tour"/);
  assert.match(html, /const TOUR_STEPS = \[/);
  assert.match(html, /title: 'See live jobs each day on this calendar'/);
  assert.match(html, /localStorage\.getItem\(dashboardTourKey\) === 'complete'/);
  assert.match(html, /localStorage\.setItem\(dashboardTourKey, 'complete'\)/);
  assert.match(html, /data-dashboard-section="summary"/);
  assert.match(html, /data-dashboard-section="calendar"/);
  assert.match(html, /data-dashboard-section="telemetry"/);
  assert.match(html, /data-dashboard-section="bookings"/);
  assert.match(html, /localStorage\.setItem\(dashboardLayoutKey, JSON\.stringify\(order\)\)/);
  assert.match(html, /handle\.addEventListener\('dragstart'/);
  assert.match(html, /moveDashboardSection\(section, -1\)/);
  assert.match(html, /moveDashboardSection\(section, 1\)/);
  assert.match(html, /if \(layoutTools\) statsEl\.append\(layoutTools\)/);
});

test('dispatcher theme toggle sits beside the VeloFox brand and remains interactive', () => {
  const dashboard = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  const themeController = fs.readFileSync(path.join(ROOT, 'public', 'js', 'theme.js'), 'utf8');
  const brandStart = dashboard.indexOf('<div class="brand-cluster">');
  const actionsStart = dashboard.indexOf('<div class="topbar-actions">');
  assert.ok(brandStart > 0 && brandStart < actionsStart);
  assert.match(dashboard, /class="theme-toggle theme-toggle--header"/);
  assert.match(dashboard, /\.theme-toggle\.theme-toggle--header \{\s*position: static;/);
  assert.match(themeController, /let button = document\.querySelector\('\.theme-toggle'\)/);
  assert.match(themeController, /button\.dataset\.themeBound = 'true'/);
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
  assert.match(map, /return \{ start, stop, refresh, clear, resume, setTrafficMode, destroy \}/);
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
  assert.deepEqual(created.value, { id: 'VF-3005', name: 'Ada Driver', phone: '555', email: null, status: 'available' });

  const emailSet = normalizeDriverFields({ id: 'VF-3005', name: 'Ada Driver', phone: '555', email: '  ada@example.com ', status: 'available' });
  assert.deepEqual(emailSet.errors, []);
  assert.deepEqual(emailSet.value.email, 'ada@example.com');

  const emailCleared = normalizeDriverFields({ id: 'VF-3005', name: 'Ada Driver', phone: '555', email: '', status: 'available' });
  assert.deepEqual(emailCleared.errors, []);
  assert.deepEqual(emailCleared.value.email, null);

  const emailInvalid = normalizeDriverFields({ id: 'VF-3005', name: 'Ada Driver', phone: '555', email: 'not-an-email', status: 'available' });
  assert.ok(emailInvalid.errors.length >= 1);

  const updated = normalizeDriverFields({ status: 'off_duty' }, { id: 'VF-1001', name: 'Marcus Vance', phone: '', email: 'm@v.fox', status: 'available' });
  assert.deepEqual(updated.value, { id: 'VF-1001', name: 'Marcus Vance', phone: null, email: 'm@v.fox', status: 'off_duty' });
  assert.deepEqual(updated.errors, []);
  assert.deepEqual(updated.value, { id: 'VF-1001', name: 'Marcus Vance', phone: null, email: 'm@v.fox', status: 'off_duty' });

  const invalid = normalizeDriverFields({ id: 'bad id', name: '', phone: 12, status: 'retired' });
  assert.equal(invalid.errors.length, 4);
});

test('dashboard assign form offers class-matched vehicles and shows the driver name inline', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(page, /const FLEET_BY_CLASS = \{/);
  assert.match(page, /sedan: \['Executive Sedan 01', 'Executive Sedan 02'\]/);
  assert.match(page, /suv: \['Cadillac Escalade 01', 'Cadillac Escalade 02'\]/);
  assert.match(page, /const vehicleSelect = document\.createElement\('select'\);/);
  assert.match(page, /FLEET_BY_CLASS\[vehicleKey\]/);
  assert.match(page, /const driverField = document\.createElement\('span'\);/);
  assert.match(page, /driverField\.className = 'driver-field';/);
  assert.match(page, /const driverNameEl = document\.createElement\('span'\);/);
  assert.match(page, /driverNameEl\.className = 'driver-name';/);
  assert.match(page, /DRIVER_ACTIVE_STATUSES = new Set\(\['assigned', 'en_route', 'arrived', 'passenger_aboard'\]\)/);
  assert.match(page, /\/api\/drivers\/\$\{encodeURIComponent\(typedReference\)\}/);
  assert.match(page, /\/api\/drivers\/\$\{encodeURIComponent\(driverId\)\}\/manifest/);
  assert.match(page, /suggestVehicleFor\(driver\.id\);/);
  assert.match(page, /vehicleSelect\.value = activeTrip\.assignedVehicle;/);
  assert.match(page, /FLEET_BY_CLASS\[vehicleKey\]\?\.includes\(activeTrip\.assignedVehicle\)/);
  assert.doesNotMatch(page, /id="fleet"/);
  assert.doesNotMatch(page, /const vehicleInput = document\.createElement/);
});

test('driver assignment accepts an ID or name without a default-name menu', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.doesNotMatch(page, /<datalist id="drivers">/);
  assert.doesNotMatch(page, /setAttribute\('list', 'drivers'\)/);
  assert.match(page, /driverInput\.placeholder = 'Driver ID or name'/);
  assert.match(page, /function findKnownDriver\(reference\)/);
  assert.match(page, /async function resolveDriverReference\(reference\)/);
  assert.match(page, /driver\.name\.toLowerCase\(\) === needle/);
  assert.match(page, /driverId: driver\.id/);
  assert.match(page, /No driver matches that ID or name\./);
});

test('driver assignment uses a filtered VeloFox combobox instead of Firefox autocomplete', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(page, /driverInput\.autocomplete = 'off'/);
  assert.match(page, /driverInput\.setAttribute\('role', 'combobox'\)/);
  assert.match(page, /driverSuggestions\.setAttribute\('role', 'listbox'\)/);
  assert.match(page, /label\.textContent = 'VeloFox drivers'/);
  assert.match(page, /function matchingDrivers\(reference = ''\)/);
  assert.match(page, /driver\.name\.toLowerCase\(\)\.includes\(needle\)/);
  assert.match(page, /driver\.id\.toLowerCase\(\)\.includes\(needle\)/);
  assert.match(page, /event\.key === 'ArrowDown'/);
  assert.match(page, /chooseDriverSuggestion\(visibleDriverSuggestions\[activeDriverSuggestion\]\)/);
  assert.match(page, /document\.body\.append\(driverSuggestions\)/);
  assert.match(page, /driverSuggestions\.style\.left/);
});

test('driver portal shows a day-grouped calendar and dispatcher shows a compact month grid at the top', () => {
  const driver = fs.readFileSync(path.join(ROOT, 'public', 'driver.html'), 'utf8');
  assert.match(driver, /id="calendar"/);
  assert.match(driver, /id="calendar-empty"/);
  assert.match(driver, /function renderCalendar\(\)/);
  assert.match(driver, /const byDay = new Map\(\);/);
  assert.match(driver, /renderCalendar\(\);/);

  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  const mainStart = dash.indexOf('<main>');
  const statsStart = dash.indexOf('id="stats"', mainStart);
  const calendarStart = dash.indexOf('class="panel calendar-panel"', mainStart);
  assert.ok(statsStart > mainStart);
  assert.ok(calendarStart > mainStart);
  assert.ok(statsStart < calendarStart);
  assert.match(dash, /<div class="calendar-weekdays" aria-hidden="true">/);
  assert.match(dash, /id="calendar" class="calendar-month"/);
  assert.match(dash, /id="calendar-prev"/);
  assert.match(dash, /id="calendar-today"/);
  assert.match(dash, /id="calendar-next"/);
  assert.match(dash, /function renderCalendar\(\)/);
  assert.match(dash, /const cellCount = isWeek \? 7 : 42;/);
  assert.match(dash, /for \(let index = 0; index < cellCount; index \+= 1\)/);
  assert.match(dash, /dayBookings\.slice\(0, 3\)/);
  assert.match(dash, /getDriverName\(booking\.driverId\)/);
  assert.match(dash, /row\.dataset\.bookingId = booking\.id;/);
  assert.match(dash, /tbody\.querySelector\(\`tr\[data-booking-id=/);
  assert.doesNotMatch(dash, /getDriver\(booking\.driverId\)/);
  assert.match(dash, /renderCalendar\(\);/);
});

test('dispatcher calendar offers compact month and week views', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /id="calendar-view-month" class="btn btn-sm is-active" type="button" aria-pressed="true">Month/);
  assert.match(dash, /id="calendar-view-week" class="btn btn-sm" type="button" aria-pressed="false">Week/);
  assert.match(dash, /let calendarView = 'month';/);
  assert.match(dash, /const gridStart = isWeek \? weekStart : /);
  assert.match(dash, /container\.classList\.toggle\('is-week', isWeek\)/);
  assert.match(dash, /calendarDate\.setDate\(calendarDate\.getDate\(\) \+ direction \* 7\)/);
  assert.match(dash, /calendarDate\.setMonth\(calendarDate\.getMonth\(\) \+ direction, 1\)/);
  assert.match(dash, /calendarMonthBtn\?\.addEventListener\('click', \(\) => setCalendarView\('month'\)\)/);
  assert.match(dash, /calendarWeekBtn\?\.addEventListener\('click', \(\) => setCalendarView\('week'\)\)/);
  assert.match(dash, /min-height: 82px/);
  assert.doesNotMatch(dash, /min-height: 106px/);
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

test('dispatcher roster shows fleet status and supports drag-to-assign', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.get\('\/api\/fleet\/roster', requireApiRole\('dispatcher'\)/);
  assert.match(server, /status = 'on_trip'/);
  assert.match(server, /shiftEnd: lastPickup \? /);
  assert.match(server, /reporting: Boolean\(latestByDriver\.get\(driver\.id\)\)/);

  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /id="roster" class="roster-strip"/);
  assert.match(dash, /id="roster-summary"/);
  assert.match(dash, /const ROSTER_STATUS_LABELS = \{/);
  assert.match(dash, /async function loadRoster\(\)/);
  assert.match(dash, /card\.draggable = true/);
  assert.match(dash, /function wireAssignmentDrop\(element, bookingId\)/);
  assert.match(dash, /wireAssignmentDrop\(row, booking\.id\)/);
  assert.match(dash, /wireAssignmentDrop\(event, booking\.id\)/);
  assert.match(dash, /if \(!payload \|\| !payload\.driverId\) return;/);
});

test('dispatcher has a new-booking modal and one-click client and chauffeur comms', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /id="new-booking-btn" class="btn btn-primary btn-sm" type="button">\+ New Booking/);
  assert.match(dash, /id="booking-modal" class="modal-overlay" hidden/);
  assert.match(dash, /id="new-booking-form" class="modal" novalidate/);
  assert.match(dash, /name="flightNumber"/);
  assert.match(dash, /await request\('\/api\/bookings', \{ method: 'POST'/);
  assert.match(dash, /function makeCommLink\(phone, label, kind/);
  assert.match(dash, /makeCommLink\(booking\.clientPhone, 'Call', 'tel'\)/);
  assert.match(dash, /makeCommLink\(booking\.clientPhone, 'Text', 'sms'/);
  assert.match(dash, /makeCommLink\(rosterDriver\.phone, 'Call', 'tel'\)/);
  assert.match(dash, /sendEnRouteText\(booking, 'en_route', enRoute\)/);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/bookings\/:id\/notify', requireApiRole\('dispatcher'\)/);
  assert.match(server, /async function sendSMS\(to, text\)/);
  assert.match(server, /Your chauffeur is en route/);
});

test('dispatcher exception center surfaces unassigned, late and cancelled rides', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /id="alerts-bell" class="btn btn-sm alerts-bell"/);
  assert.match(dash, /id="alerts-panel" class="alerts-panel" hidden/);
  assert.match(dash, /id="alerts-count" class="alerts-count" hidden/);
  assert.match(dash, /function buildAlerts\(\)/);
  assert.match(dash, /Unassigned ride · \$\{ride\}/);
  assert.match(dash, /Chauffeur behind schedule · \$\{ride\}/);
  assert.match(dash, /Cancelled ride · \$\{ride\}/);
  assert.match(dash, /Last-minute change · \$\{ride\}/);
  assert.match(dash, /renderAlerts\(\);/);
});

test('dispatcher layout widens the board with full-width telemetry', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /max-width: 1600px/);
  assert.match(dash, /main > \[data-dashboard-section\] \{ grid-column: 1 \/ -1; \}/);
  assert.doesNotMatch(dash, /grid-template-columns: minmax\(360px, 0\.8fr\)/);
  assert.doesNotMatch(dash, /main > #telemetry-panel \{ grid-column: 1; \}/);
  assert.doesNotMatch(dash, /max-width: 1400px/);
});

test('cancelled KPI shows reason breakdown and filters by reason', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  assert.match(schema, /cancellation_reason text/);
  assert.match(schema, /'test_demo', 'client_cancelled', 'no_show'/);

  const dbFile = fs.readFileSync(path.join(ROOT, 'lib', 'db.js'), 'utf8');
  assert.match(dbFile, /schema-v7-cancellation-reasons/);

  const repo = fs.readFileSync(path.join(ROOT, 'lib', 'repository.js'), 'utf8');
  assert.match(repo, /cancellationReason: row\.cancellation_reason/);
  assert.match(repo, /push\('cancellation_reason', changes\.cancellationReason\)/);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /'pricing', 'cancellationReason'/);
  assert.match(server, /test_demo, client_cancelled, no_show, or null/);

  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /const CANCEL_REASONS = \{/);
  assert.match(dash, /Test\/Demo/);
  assert.match(dash, /Client Cancelled/);
  assert.match(dash, /No-Show/);
  assert.match(dash, /id="reason-popover" class="reason-popover" hidden/);
  assert.match(dash, /function openReasonPopover\(anchor\)/);
  assert.match(dash, /function applyReasonFilter\(reason\)/);
  assert.match(dash, /function pickCancellationReason\(booking\)/);
  assert.match(dash, /card\.dataset\.status === 'cancelled'\) openReasonPopover\(card\)/);
});

test('live map draws active routes and a fleet traffic toggle', () => {
  const map = fs.readFileSync(path.join(ROOT, 'public', 'js', 'telemetry-map.js'), 'utf8');
  assert.match(map, /async function drawRoutes\(drivers, activeTrips\)/);
  assert.match(map, /L\.polyline\(points, options\)/);
  assert.match(map, /function trafficColor\(speedMetersPerSecond\)/);
  assert.match(map, /function geocode\(address\)/);
  assert.match(map, /nominatim\.openstreetmap\.org/);
  assert.match(map, /function setTrafficMode\(enabled\)/);
  assert.match(map, /return \{ start, stop, refresh, clear, resume, setTrafficMode, destroy \}/);

  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /id="telemetry-traffic" class="btn btn-sm" type="button" aria-pressed="false">Traffic: off/);
  assert.match(dash, /id="traffic-legend" class="traffic-legend" hidden/);
  assert.match(dash, /radar\.setTrafficMode\(enabled\)/);
  assert.match(dash, /trafficMode \? 'fleet traffic view' : null/);
});

test('airport pickups link to live FlightAware tracking', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.match(dash, /const AIRPORT_HINTS = /);
  assert.match(dash, /const FLIGHT_RE = /);
  assert.match(dash, /function extractFlightNumber\(booking\)/);
  assert.match(dash, /flight\.href = `https:\/\/www\.flightaware\.com\/live\/flight\//);
  assert.match(dash, /flight\.className = 'flight-badge'/);
});

test('dispatch command console understands plain-English actions', () => {
  const parser = fs.readFileSync(path.join(ROOT, 'public', 'js', 'voice-command.js'), 'utf8');
  assert.match(parser, /VeloFox Dispatch Command Console/);
  assert.match(parser, /type: 'reason_filter', reason/);
  assert.match(parser, /type: 'send_text', rideRef, kind, target/);
  assert.match(parser, /type: 'ping_fleet'/);
  assert.match(parser, /type: 'traffic', enabled/);
  assert.match(parser, /type: 'new_booking'/);
  assert.match(parser, /rideRefFrom\(text, context\)/);
  assert.match(parser, /global\.VeloFoxCommands/);
  assert.doesNotMatch(parser, /\bAI\b|artificial intelligence|LLM|model call/i);
  assert.doesNotMatch(parser, /SpeechRecognition|speechSynthesis|speak\(/);

  const dash = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.doesNotMatch(dash, /id="voice-toggle"|VeloFoxVoice|Speech recognition/);
  assert.match(dash, /window\.VeloFoxCommands/);
  assert.match(dash, /aria-label="Dispatch command console"/);
  assert.match(dash, /Describe an action in plain english and Velofox will execute it for you/);
  assert.match(dash, /id="command-log" class="command-log" hidden/);
  assert.match(dash, /function logCommand\(request, response, isError/);
  assert.match(dash, /context: \{ get rides\(\) \{ return bookings; \} \}/);
  assert.match(dash, /intent\.type === 'send_text'/);
  assert.match(dash, /intent\.type === 'ping_fleet'/);
  assert.match(dash, /intent\.type === 'reason_filter'/);
});
