'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const pricing = require('./lib/pricing');
const db = require('./lib/db');
const repo = require('./lib/repository');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const MAX_PASSENGERS = 16;
const MAX_TEXT_LENGTH = 200;
const MAX_DRIVER_ID_LENGTH = 50;
const MAX_LUGGAGE_NOTES_LENGTH = 500;
const MAX_BEVERAGE_REQUEST_LENGTH = 200;
const MAX_SPECIAL_REQUESTS_LENGTH = 1000;
const MAX_PHONE_LENGTH = 30;
const SESSION_COOKIE = 'velofox_session';
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_HOURS) || 12) * 60 * 60 * 1000;
const DISPATCHER_INVITE_CODE = process.env.DISPATCHER_INVITE_CODE || '';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const INVITE_CODE_HASH_KEY = 'dispatcher_invite_code_hash';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Optional allowlist: dispatcher emails that are always administrators.
const ADMIN_EMAILS = new Set(
  String(process.env.DISPATCHER_ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

const VEHICLE_TYPES = ['sedan', 'suv', 'sprinter', 'limousine'];
const VEHICLE_CAPACITIES = Object.freeze({ sedan: 3, suv: 6, sprinter: 15, limousine: 16 });
const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'assigned',
  'en_route',
  'arrived',
  'passenger_aboard',
  'completed',
  'cancelled',
];
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const ACTIVE_BOOKING_STATUSES = new Set(['assigned', 'en_route', 'arrived', 'passenger_aboard']);
const STATUS_TRANSITIONS = {
  pending: new Set(['confirmed', 'cancelled']),
  confirmed: new Set(['assigned', 'cancelled']),
  assigned: new Set(['en_route', 'cancelled']),
  en_route: new Set(['arrived', 'cancelled']),
  arrived: new Set(['passenger_aboard', 'cancelled']),
  passenger_aboard: new Set(['completed', 'cancelled']),
  completed: new Set(),
  cancelled: new Set(),
};
const DRIVER_REGISTRY = new Map([
  ['VF-1001', { id: 'VF-1001', name: 'Marcus Vance' }],
  ['VF-1002', { id: 'VF-1002', name: 'David Sterling' }],
  ['VF-1003', { id: 'VF-1003', name: 'Elena Marquez' }],
  ['VF-2004', { id: 'VF-2004', name: 'Naomi Laurent' }],
]);

// Rate-limit counters stay per instance; all durable state lives in PostgreSQL.
const authAttempts = new Map();

// Serverless platforms never hit `require.main`, so the schema is bootstrapped
// lazily on the first request instead. The promise is cached per instance.
let schemaReady = null;
function ensureDatabase() {
  if (!schemaReady) {
    schemaReady = db.ensureSchema().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

app.disable('x-powered-by');
app.use(express.json());
app.use(async (req, res, next) => {
  // Health must be able to report an outage instead of failing on the check.
  if (req.path === '/api/health') return next();
  try {
    await ensureDatabase();
    next();
  } catch (error) {
    next(error);
  }
});
app.get('/dashboard.html', requirePageRole('dispatcher', '/dispatcher-login.html'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/admin.html', requirePageAdmin(), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/client.html', requirePageRole('client', '/client-login.html'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------- helpers ------------------------------- */

function isNonEmptyString(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= maxLength;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

async function getAuthenticatedUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashResetToken(token);
  const user = await repo.findSessionUser(tokenHash);
  if (!user || user.disabledAt) {
    await repo.deleteSession(tokenHash);
    return null;
  }
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isAdmin: Boolean(user.isAdmin),
  };
}

async function createSession(res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await repo.createSession(hashResetToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
  );
}

async function clearSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await repo.deleteSession(hashResetToken(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function requireApiRole(role) {
  return async (req, res, next) => {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in is required.' });
    if (user.role !== role) return res.status(403).json({ error: 'This account cannot access that resource.' });
    req.authUser = user;
    next();
  };
}

function requirePageRole(role, loginPath) {
  return async (req, res, next) => {
    const user = await getAuthenticatedUser(req);
    if (!user || user.role !== role) {
      return res.redirect(303, `${loginPath}?next=${encodeURIComponent(req.originalUrl)}`);
    }
    req.authUser = user;
    next();
  };
}

function requireApiAdmin() {
  return async (req, res, next) => {
    const user = await getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in is required.' });
    if (user.role !== 'dispatcher' || !user.isAdmin) {
      return res.status(403).json({ error: 'Administrator access is required.' });
    }
    req.authUser = user;
    next();
  };
}

function requirePageAdmin() {
  return async (req, res, next) => {
    const user = await getAuthenticatedUser(req);
    if (!user || user.role !== 'dispatcher') {
      return res.redirect(303, `/dispatcher-login.html?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (!user.isAdmin) return res.redirect(303, '/dashboard.html');
    req.authUser = user;
    next();
  };
}

function authAttemptKey(req, role, email) {
  return `${req.ip || 'local'}:${role}:${email}`;
}

function isAuthRateLimited(key) {
  const state = authAttempts.get(key);
  if (!state || state.resetAt <= Date.now()) {
    authAttempts.delete(key);
    return false;
  }
  return state.count >= AUTH_MAX_ATTEMPTS;
}

function recordAuthFailure(key) {
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    authAttempts.set(key, { count: 1, resetAt: Date.now() + AUTH_WINDOW_MS });
  } else {
    current.count += 1;
  }
}

function hashLoginCode(salt, role, email, code) {
  return crypto.createHash('sha256').update(`${salt}:${role}:${email}:${code}`).digest('hex');
}

function generateLoginCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function normalizeLoginCode(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

/**
 * The dispatcher access code is either the hash an administrator rotated into
 * app_settings or, until the first rotation, DISPATCHER_INVITE_CODE from the
 * environment. Returns true/false, or null when no code is configured at all.
 */
async function inviteCodeMatches(submitted) {
  const storedHash = await repo.getSetting(INVITE_CODE_HASH_KEY);
  if (storedHash) return safeStringEqual(hashResetToken(String(submitted)), storedHash);
  if (DISPATCHER_INVITE_CODE) return safeStringEqual(String(submitted), DISPATCHER_INVITE_CODE);
  return null;
}

/**
 * Delivers a one-time sign-in code. Email goes through Resend when
 * RESEND_API_KEY and MAIL_FROM are configured; otherwise the code is printed to
 * the server console (the local terminal, or the deployment logs on Vercel).
 */
async function deliverLoginCode(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  const minutes = Math.round(LOGIN_CODE_TTL_MS / 60_000);

  if (apiKey && from) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Your VeloFox sign-in code',
          text: `Your VeloFox sign-in code is ${code}. It expires in ${minutes} minutes. If you did not request it, ignore this message.`,
        }),
      });
      if (!response.ok) throw new Error(`mail provider responded ${response.status}`);
      return 'email';
    } catch (error) {
      console.error('[VeloFox login code] email delivery failed:', error.message);
    }
  }

  console.log(`[VeloFox login code] ${email}: ${code} (expires in ${minutes} minutes)`);
  return 'console';
}

async function audit(req, action, target = null, detail = null) {
  await repo.recordAudit({
    actorId: req.authUser ? req.authUser.id : null,
    actorEmail: req.authUser ? req.authUser.email : null,
    action,
    target,
    detail,
  });
}

function validateAccountPayload(body, { requireInviteCode = false } = {}) {
  const errors = [];
  if (!isPlainObject(body)) return ['Request body must be a JSON object.'];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = normalizeEmail(body.email);
  const password = body.password;
  if (!isNonEmptyString(name, 120)) errors.push('Name is required and must not exceed 120 characters.');
  if (!isNonEmptyString(email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('A valid email address is required.');
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    errors.push('Password must be between 10 and 128 characters.');
  }
  if (requireInviteCode && !isNonEmptyString(body.inviteCode, 200)) {
    errors.push('A dispatcher access code is required.');
  }
  return errors;
}

function normalizeDriverId(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

function getDriver(driverId) {
  return DRIVER_REGISTRY.get(normalizeDriverId(driverId)) || null;
}

function validateDriverLocation(value) {
  const errors = [];

  if (!isPlainObject(value)) {
    return { errors: ['driverLocation must be a JSON object.'], value: null };
  }

  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const accuracy = value.accuracy == null ? null : Number(value.accuracy);
  const heading = value.heading == null ? null : Number(value.heading);
  const speed = value.speed == null ? null : Number(value.speed);
  const recordedAt = value.recordedAt == null ? new Date().toISOString() : value.recordedAt;

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    errors.push('driverLocation.latitude must be a number between -90 and 90.');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    errors.push('driverLocation.longitude must be a number between -180 and 180.');
  }
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0)) {
    errors.push('driverLocation.accuracy must be a non-negative number or null.');
  }
  if (heading !== null && (!Number.isFinite(heading) || heading < 0 || heading > 360)) {
    errors.push('driverLocation.heading must be a number between 0 and 360 or null.');
  }
  if (speed !== null && (!Number.isFinite(speed) || speed < 0)) {
    errors.push('driverLocation.speed must be a non-negative number or null.');
  }
  if (!isNonEmptyString(recordedAt, 100) || Number.isNaN(Date.parse(recordedAt))) {
    errors.push('driverLocation.recordedAt must be a valid date/time string.');
  }

  if (errors.length > 0) return { errors, value: null };

  return {
    errors,
    value: {
      latitude,
      longitude,
      accuracy,
      heading,
      speed,
      recordedAt: new Date(recordedAt).toISOString(),
    },
  };
}

/**
 * Validates a booking payload and returns { errors, value }.
 * `value` is the normalized record to persist; only known fields are kept.
 */
function validateBooking(body) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { errors: ['Request body must be a JSON object.'], value: null };
  }

  const pickupLocation = body.pickupLocation;
  if (!isNonEmptyString(pickupLocation)) {
    errors.push(`pickupLocation is required and must be a non-empty string (max ${MAX_TEXT_LENGTH} characters).`);
  }

  const dropoffLocation = body.dropoffLocation;
  if (!isNonEmptyString(dropoffLocation)) {
    errors.push(`dropoffLocation is required and must be a non-empty string (max ${MAX_TEXT_LENGTH} characters).`);
  }

  const pickupDateTime = body.pickupDateTime;
  let pickupTimestamp = NaN;
  if (!isNonEmptyString(pickupDateTime, 100)) {
    errors.push('pickupDateTime is required and must be a non-empty string.');
  } else {
    pickupTimestamp = Date.parse(pickupDateTime);
    if (Number.isNaN(pickupTimestamp)) {
      errors.push('pickupDateTime must be a valid date/time string (for example 2026-12-01T18:30:00Z).');
    } else if (pickupTimestamp <= Date.now()) {
      errors.push('pickupDateTime must be in the future.');
    }
  }

  const vehicleType = typeof body.vehicleType === 'string' ? body.vehicleType.trim().toLowerCase() : body.vehicleType;
  if (!VEHICLE_TYPES.includes(vehicleType)) {
    errors.push(`vehicleType must be one of: ${VEHICLE_TYPES.join(', ')}.`);
  }

  const passengerCount = body.passengerCount;
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > MAX_PASSENGERS) {
    errors.push(`passengerCount must be an integer between 1 and ${MAX_PASSENGERS}.`);
  } else if (VEHICLE_TYPES.includes(vehicleType) && passengerCount > VEHICLE_CAPACITIES[vehicleType]) {
    errors.push(`${vehicleType} supports up to ${VEHICLE_CAPACITIES[vehicleType]} passengers.`);
  }

  const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : body.clientName;
  if (!isNonEmptyString(clientName, 120)) {
    errors.push('clientName is required and must not exceed 120 characters.');
  }

  const clientEmail = normalizeEmail(body.clientEmail);
  if (!isNonEmptyString(clientEmail, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    errors.push('clientEmail must be a valid email address.');
  }

  if (errors.length > 0) {
    return { errors, value: null };
  }

  const driverId = normalizeDriverId(body.driverId);
  if (driverId != null && !isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
    errors.push(`driverId must be a non-empty string (max ${MAX_DRIVER_ID_LENGTH} characters) or null.`);
  } else if (driverId != null && !getDriver(driverId)) {
    errors.push(`driverId "${driverId}" is not registered.`);
  }

  const luggageNotes = body.luggageNotes;
  if (luggageNotes != null && typeof luggageNotes !== 'string') {
    errors.push('luggageNotes must be a string or null.');
  } else if (typeof luggageNotes === 'string' && luggageNotes.trim().length > MAX_LUGGAGE_NOTES_LENGTH) {
    errors.push(`luggageNotes must not exceed ${MAX_LUGGAGE_NOTES_LENGTH} characters.`);
  }

  const beverageRequest = body.beverageRequest;
  if (beverageRequest != null && typeof beverageRequest !== 'string') {
    errors.push('beverageRequest must be a string or null.');
  } else if (typeof beverageRequest === 'string' && beverageRequest.trim().length > MAX_BEVERAGE_REQUEST_LENGTH) {
    errors.push(`beverageRequest must not exceed ${MAX_BEVERAGE_REQUEST_LENGTH} characters.`);
  }

  const specialRequests = body.specialRequests;
  if (specialRequests != null && typeof specialRequests !== 'string') {
    errors.push('specialRequests must be a string or null.');
  } else if (typeof specialRequests === 'string' && specialRequests.trim().length > MAX_SPECIAL_REQUESTS_LENGTH) {
    errors.push(`specialRequests must not exceed ${MAX_SPECIAL_REQUESTS_LENGTH} characters.`);
  }

  const clientPhone = body.clientPhone;
  if (clientPhone != null && typeof clientPhone !== 'string') {
    errors.push('clientPhone must be a string or null.');
  } else if (typeof clientPhone === 'string' && clientPhone.trim().length > MAX_PHONE_LENGTH) {
    errors.push(`clientPhone must not exceed ${MAX_PHONE_LENGTH} characters.`);
  }

  const preferredDriverId = normalizeDriverId(body.preferredDriverId);
  if (preferredDriverId != null && !isNonEmptyString(preferredDriverId, MAX_DRIVER_ID_LENGTH)) {
    errors.push(`preferredDriverId must be a non-empty string (max ${MAX_DRIVER_ID_LENGTH} characters) or null.`);
  } else if (preferredDriverId != null && !getDriver(preferredDriverId)) {
    errors.push(`preferredDriverId "${preferredDriverId}" is not registered.`);
  }

  const assignedVehicle = body.assignedVehicle;
  if (assignedVehicle != null && !isNonEmptyString(assignedVehicle, 100)) {
    errors.push('assignedVehicle must be a non-empty string or null.');
  }

  let normalizedPricing = null;
  if (body.pricing !== undefined && body.pricing !== null) {
    const result = pricing.normalizePricing(body.pricing);
    errors.push(...result.errors);
    normalizedPricing = result.value;
  }

  if (errors.length > 0) {
    return { errors, value: null };
  }

  return {
    errors,
    value: {
      pickupLocation: pickupLocation.trim(),
      dropoffLocation: dropoffLocation.trim(),
      pickupDateTime: pickupDateTime.trim(),
      vehicleType,
      passengerCount,
      clientName,
      clientEmail,
      driverId: driverId == null ? null : driverId,
      luggageNotes: typeof luggageNotes === 'string' && luggageNotes.trim() ? luggageNotes.trim() : null,
      beverageRequest: typeof beverageRequest === 'string' && beverageRequest.trim() ? beverageRequest.trim() : null,
      specialRequests: typeof specialRequests === 'string' && specialRequests.trim() ? specialRequests.trim() : null,
      preferredDriverId: preferredDriverId == null ? null : preferredDriverId,
      clientPhone: typeof clientPhone === 'string' && clientPhone.trim() ? clientPhone.trim() : null,
      assignedVehicle: assignedVehicle == null ? null : assignedVehicle.trim(),
      pricing: normalizedPricing || pricing.defaultPricing(vehicleType),
    },
  };
}

function canTransitionStatus(currentStatus, nextStatus) {
  return currentStatus === nextStatus || Boolean(STATUS_TRANSITIONS[currentStatus]?.has(nextStatus));
}

/* ------------------------------ analytics ------------------------------ */

const ANALYTICS_RANGES = new Map([
  ['7d', 7],
  ['30d', 30],
  ['90d', 90],
  ['all', null],
]);

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Aggregates booking rows into the reporting payload.
 * Mirrors the future SQL view: revenue is recognized on completed rides only,
 * while non-terminal rides contribute to pipeline value.
 */
function buildAnalyticsSummary(rows, rangeKey, now = new Date()) {
  const rangeDays = ANALYTICS_RANGES.get(rangeKey);
  const sinceMs = rangeDays === null ? null : now.getTime() - rangeDays * 24 * 60 * 60 * 1000;

  const scoped = rows.filter((booking) => {
    if (sinceMs === null) return true;
    const pickupMs = Date.parse(booking.pickupDateTime);
    return Number.isFinite(pickupMs) && pickupMs >= sinceMs;
  });

  const byStatus = Object.fromEntries(BOOKING_STATUSES.map((status) => [status, 0]));
  const byMode = {
    point_to_point: { rides: 0, completed: 0, revenueCents: 0 },
    hourly: { rides: 0, completed: 0, revenueCents: 0 },
  };
  const driverTotals = new Map();
  const dailyTotals = new Map();

  let completed = 0;
  let cancelled = 0;
  let active = 0;
  let pending = 0;
  let revenueCents = 0;
  let pipelineCents = 0;
  let gratuityCents = 0;
  let depositCents = 0;

  for (const booking of scoped) {
    const quote = pricing.ensurePricing(booking);
    const mode = byMode[quote.mode] ? quote.mode : 'point_to_point';

    byStatus[booking.status] = (byStatus[booking.status] || 0) + 1;
    byMode[mode].rides += 1;
    if (!TERMINAL_STATUSES.has(booking.status)) pipelineCents += quote.totalCents;

    if (booking.status === 'completed') {
      completed += 1;
      revenueCents += quote.totalCents;
      gratuityCents += quote.gratuityCents;
      depositCents += quote.depositCents;
      byMode[mode].completed += 1;
      byMode[mode].revenueCents += quote.totalCents;

      const pickup = new Date(booking.pickupDateTime);
      if (!Number.isNaN(pickup.getTime())) {
        const key = dayKey(pickup);
        const day = dailyTotals.get(key) || { date: key, revenueCents: 0, rides: 0 };
        day.revenueCents += quote.totalCents;
        day.rides += 1;
        dailyTotals.set(key, day);
      }

      if (booking.driverId) {
        const entry = driverTotals.get(booking.driverId) || {
          driverId: booking.driverId,
          name: DRIVER_REGISTRY.get(booking.driverId)?.name || booking.driverId,
          completed: 0,
          revenueCents: 0,
        };
        entry.completed += 1;
        entry.revenueCents += quote.totalCents;
        driverTotals.set(booking.driverId, entry);
      }
    } else if (booking.status === 'cancelled') {
      cancelled += 1;
    } else if (ACTIVE_BOOKING_STATUSES.has(booking.status)) {
      active += 1;
    } else {
      pending += 1;
    }
  }

  // Fill the trend series so the chart never renders as a single floating bar.
  const trendDays = rangeDays === null ? 14 : Math.min(rangeDays, 14);
  const revenueByDay = [];
  for (let offset = trendDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const key = dayKey(date);
    const day = dailyTotals.get(key);
    revenueByDay.push({ date: key, revenueCents: day ? day.revenueCents : 0, rides: day ? day.rides : 0 });
  }

  const assignedDrivers = new Set(
    scoped.filter((booking) => booking.driverId && !TERMINAL_STATUSES.has(booking.status)).map((booking) => booking.driverId)
  ).size;
  const terminalCount = completed + cancelled;

  return {
    generatedAt: now.toISOString(),
    range: rangeKey,
    currency: 'USD',
    totals: {
      rides: scoped.length,
      completed,
      pending,
      active,
      cancelled,
      revenueCents,
      pipelineCents,
      gratuityCents,
      depositCents,
      averageFareCents: completed > 0 ? Math.round(revenueCents / completed) : 0,
    },
    byMode,
    byStatus,
    revenueByDay,
    drivers: [...driverTotals.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    utilization: {
      assignedDrivers,
      fleetDrivers: DRIVER_REGISTRY.size,
      activeTrips: active,
      completionRate: terminalCount > 0 ? Number((completed / terminalCount).toFixed(3)) : 0,
    },
  };
}

/* -------------------------------- routes -------------------------------- */

app.get('/api/health', async (req, res) => {
  try {
    await db.healthCheck();
    res.json({ status: 'ok', message: 'VeloFox Dispatch API is running', database: 'connected' });
  } catch (error) {
    console.error('[health] database check failed:', error.message);
    res.status(503).json({ status: 'error', message: 'VeloFox Dispatch API cannot reach its database.', database: 'unavailable' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const role = req.body && req.body.role;
  if (!['client', 'dispatcher'].includes(role)) {
    return res.status(400).json({ error: 'role must be client or dispatcher.' });
  }

  const inviteAttemptKey = authAttemptKey(req, 'dispatcher-registration', 'invite-code');
  if (role === 'dispatcher' && isAuthRateLimited(inviteAttemptKey)) {
    return res.status(429).json({ error: 'Too many access-code attempts. Try again in 15 minutes.' });
  }

  const errors = validateAccountPayload(req.body, { requireInviteCode: role === 'dispatcher' });
  if (role === 'dispatcher' && errors.length === 0) {
    const inviteMatches = await inviteCodeMatches(req.body.inviteCode);
    if (inviteMatches === null) {
      return res.status(503).json({
        error: 'Dispatcher registration is not configured. An administrator must set DISPATCHER_INVITE_CODE.',
      });
    }
    if (!inviteMatches) {
      recordAuthFailure(inviteAttemptKey);
      errors.push('The dispatcher access code is invalid.');
    }
  }
  if (errors.length > 0) return res.status(400).json({ error: 'Registration failed.', details: errors });

  const email = normalizeEmail(req.body.email);
  const password = hashPassword(req.body.password);

  let user;
  try {
    user = await repo.createAccount({
      role,
      name: req.body.name.trim(),
      email,
      passwordSalt: password.salt,
      passwordHash: password.hash,
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An account already exists for this email and role.' });
    }
    throw error;
  }

  if (role === 'dispatcher') {
    // The first dispatcher on a fresh database becomes the administrator, and
    // DISPATCHER_ADMIN_EMAILS can pre-authorise others. Without this nobody
    // could ever reach the console.
    const bootstrap = ADMIN_EMAILS.has(email) || (await repo.countActiveAdmins()) === 0;
    if (bootstrap) {
      await repo.setDispatcherAdmin(user.id, true);
      user.isAdmin = true;
      await repo.recordAudit({
        actorEmail: email,
        action: 'account.bootstrap_admin',
        target: email,
        detail: { reason: 'first dispatcher account' },
      });
    }
    authAttempts.delete(inviteAttemptKey);
  }

  await createSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  if (!isPlainObject(req.body)) return res.status(400).json({ error: 'Request body must be a JSON object.' });
  const role = req.body.role;
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;
  if (!['client', 'dispatcher'].includes(role) || !isNonEmptyString(email, 254) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Role, email, and password are required.' });
  }

  const attemptKey = authAttemptKey(req, role, email);
  if (isAuthRateLimited(attemptKey)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  const user = await repo.findUser(role, email);
  if (!user || !verifyPassword(password, user)) {
    recordAuthFailure(attemptKey);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }

  if (user.disabledAt) {
    return res.status(403).json({ error: 'This account has been suspended. Contact a VeloFox administrator.' });
  }

  authAttempts.delete(attemptKey);
  await createSession(res, user);
  res.json({ user: publicUser(user) });
});

app.get('/api/auth/session', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'No active session.' });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  await clearSession(req, res);
  res.status(204).end();
});

/**
 * Passwordless sign-in, step 1: issue a six-digit code for an existing account.
 * The response never reveals whether the address is registered.
 */
app.post('/api/auth/request-code', async (req, res) => {
  const role = req.body && req.body.role;
  const email = normalizeEmail(req.body && req.body.email);
  if (!['client', 'dispatcher'].includes(role) || !isNonEmptyString(email, 254)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid role and email address are required.' });
  }

  const attemptKey = authAttemptKey(req, `${role}-code-request`, email);
  const genericResponse = { message: 'If that email belongs to an account, a six-digit code is on its way.' };
  if (isAuthRateLimited(attemptKey)) return res.status(202).json(genericResponse);
  recordAuthFailure(attemptKey);

  const user = await repo.findUser(role, email);
  if (!user || user.disabledAt) return res.status(202).json(genericResponse);

  const code = generateLoginCode();
  const salt = crypto.randomBytes(16).toString('hex');
  await repo.replaceLoginCode({
    role,
    email,
    codeHash: hashLoginCode(salt, role, email, code),
    codeSalt: salt,
    expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS),
  });
  const channel = await deliverLoginCode(email, code);
  await repo.recordAudit({
    actorEmail: email,
    action: 'login.code_issued',
    target: email,
    detail: { role, channel },
  });

  res.status(202).json(genericResponse);
});

/** Passwordless sign-in, step 2: exchange the code for a session. */
app.post('/api/auth/verify-code', async (req, res) => {
  const role = req.body && req.body.role;
  const email = normalizeEmail(req.body && req.body.email);
  const code = normalizeLoginCode(req.body && req.body.code);
  if (!['client', 'dispatcher'].includes(role) || !isNonEmptyString(email, 254) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'A valid email address and six-digit code are required.' });
  }

  const attemptKey = authAttemptKey(req, `${role}-code-verify`, email);
  if (isAuthRateLimited(attemptKey)) {
    return res.status(429).json({ error: 'Too many code attempts. Request a new code later.' });
  }

  const record = await repo.findActiveLoginCode(role, email);
  if (!record || record.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
    recordAuthFailure(attemptKey);
    return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
  }
  if (!safeStringEqual(hashLoginCode(record.codeSalt, role, email, code), record.codeHash)) {
    await repo.incrementLoginCodeAttempts(record.id);
    recordAuthFailure(attemptKey);
    return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
  }

  const user = await repo.findUser(role, email);
  if (!user || user.disabledAt) {
    return res.status(403).json({ error: 'This account cannot sign in. Contact a VeloFox administrator.' });
  }

  await repo.consumeLoginCode(record.id);
  await repo.deleteLoginCodesFor(role, email);
  authAttempts.delete(attemptKey);
  await createSession(res, user);
  await repo.recordAudit({ actorEmail: email, action: 'login.code_used', target: email, detail: { role } });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  if (!isNonEmptyString(email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid dispatcher email address.' });
  }

  const attemptKey = authAttemptKey(req, 'dispatcher-password-reset', email);
  const genericResponse = {
    message: 'If a dispatcher account matches that email, a reset link has been prepared.',
  };
  if (isAuthRateLimited(attemptKey)) return res.status(202).json(genericResponse);

  const user = await repo.findUser('dispatcher', email);
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashResetToken(rawToken);
    await repo.setResetToken(user.id, tokenHash, new Date(Date.now() + RESET_TOKEN_TTL_MS));
    const resetLink = `${APP_BASE_URL}/reset-password.html?token=${encodeURIComponent(rawToken)}`;

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[VeloFox local password reset] ${email}: ${resetLink}`);
    } else {
      console.warn('Password reset requested, but production email delivery is not configured.');
    }
  }

  recordAuthFailure(attemptKey);
  res.status(202).json(genericResponse);
});

app.post('/api/auth/reset-password', async (req, res) => {
  const token = req.body && req.body.token;
  const newPassword = req.body && req.body.newPassword;
  const attemptKey = authAttemptKey(req, 'dispatcher-reset-token', 'token');

  if (isAuthRateLimited(attemptKey)) {
    return res.status(429).json({ error: 'Too many reset attempts. Request a new link later.' });
  }
  if (!isNonEmptyString(token, 200) || typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) {
    recordAuthFailure(attemptKey);
    return res.status(400).json({ error: 'A valid reset token and a password between 10 and 128 characters are required.' });
  }

  const tokenHash = hashResetToken(token);
  const user = await repo.findDispatcherByResetToken(tokenHash);
  if (!user || !user.resetToken || !safeStringEqual(user.resetToken, tokenHash)) {
    recordAuthFailure(attemptKey);
    return res.status(400).json({ error: 'This reset link is invalid or has already been used.' });
  }
  if (!user.resetTokenExpires || user.resetTokenExpires <= Date.now()) {
    await repo.clearResetToken(user.id);
    recordAuthFailure(attemptKey);
    return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
  }

  const password = hashPassword(newPassword);
  await db.withTransaction(async (client) => {
    await client.query(
      'UPDATE accounts SET password_salt = $2, password_hash = $3, updated_at = now() WHERE id = $1',
      [user.id, password.salt, password.hash]
    );
    await client.query(
      'UPDATE dispatchers SET reset_token = NULL, reset_token_expires = NULL WHERE account_id = $1',
      [user.id]
    );
    await client.query('DELETE FROM sessions WHERE account_id = $1', [user.id]);
  });
  authAttempts.delete(attemptKey);
  res.json({ message: 'Password updated. Sign in with your new password.' });
});

/* ---------------------------- administrator API ---------------------------- */

app.get('/api/admin/accounts', requireApiAdmin(), async (req, res) => {
  const accounts = await repo.listAccounts();
  res.json({
    accounts,
    counts: {
      dispatchers: accounts.filter((account) => account.role === 'dispatcher').length,
      clients: accounts.filter((account) => account.role === 'client').length,
      administrators: accounts.filter((account) => account.isAdmin).length,
      disabled: accounts.filter((account) => account.disabled).length,
    },
  });
});

app.post('/api/admin/accounts', requireApiAdmin(), async (req, res) => {
  const errors = validateAccountPayload(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Account could not be created.', details: errors });
  }

  const email = normalizeEmail(req.body.email);
  const password = hashPassword(req.body.password);

  let created;
  try {
    created = await repo.createAccount({
      role: 'dispatcher',
      name: req.body.name.trim(),
      email,
      passwordSalt: password.salt,
      passwordHash: password.hash,
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A dispatcher account already exists for this email.' });
    }
    throw error;
  }

  const isAdmin = req.body.isAdmin === true;
  if (isAdmin) await repo.setDispatcherAdmin(created.id, true);
  await audit(req, 'account.create', email, { isAdmin });
  res.status(201).json({ account: await repo.findAccountById(created.id) });
});

app.patch('/api/admin/accounts/:id', requireApiAdmin(), async (req, res) => {
  const target = await repo.findAccountById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });

  const body = isPlainObject(req.body) ? req.body : {};
  const isSelf = target.id === req.authUser.id;

  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be true or false.' });
    if (isSelf && body.disabled) {
      return res.status(400).json({ error: 'You cannot suspend your own account.' });
    }
  }
  if (body.isAdmin !== undefined) {
    if (typeof body.isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be true or false.' });
    if (target.role !== 'dispatcher') {
      return res.status(400).json({ error: 'Only dispatcher accounts can be administrators.' });
    }
    if (isSelf && !body.isAdmin) {
      return res.status(400).json({ error: 'You cannot remove your own administrator access.' });
    }
  }
  if (body.password !== undefined && (typeof body.password !== 'string'
    || body.password.length < 10 || body.password.length > 128)) {
    return res.status(400).json({ error: 'Password must be between 10 and 128 characters.' });
  }
  if (body.name !== undefined && !isNonEmptyString(body.name, 120)) {
    return res.status(400).json({ error: 'Name is required and must not exceed 120 characters.' });
  }

  let emailChange = null;
  if (body.email !== undefined) {
    const candidateEmail = normalizeEmail(body.email);
    if (typeof candidateEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail) || candidateEmail.length > 254) {
      return res.status(400).json({ error: 'A valid work email is required.' });
    }
    emailChange = String(target.email || '').toLowerCase() === candidateEmail
      ? null
      : candidateEmail;
    if (emailChange) {
      const clash = await db.query(
        'SELECT id FROM accounts WHERE role = $1 AND email = $2 AND id <> $3 LIMIT 1',
        [target.role, emailChange, target.id]
      );
      if (clash.rowCount > 0) {
        return res.status(409).json({ error: 'Another account already uses that email address.' });
      }
    }
  }

  const hasChange = body.disabled !== undefined || body.isAdmin !== undefined
    || body.password !== undefined || body.name !== undefined
    || (body.email !== undefined && emailChange !== null);
  if (!hasChange) return res.status(400).json({ error: 'Nothing to change.' });

  // Never leave the deployment without an active administrator.
  const removesAdmin = (body.isAdmin === false && target.isAdmin)
    || (body.disabled === true && target.isAdmin);
  if (removesAdmin && (await repo.countActiveAdmins()) <= 1) {
    return res.status(400).json({ error: 'At least one active administrator is required.' });
  }

  if (emailChange) await repo.updateEmail(target.id, emailChange);
  if (body.name !== undefined) await repo.renameAccount(target.id, body.name.trim());
  if (body.password !== undefined) {
    const password = hashPassword(body.password);
    await repo.updatePassword(target.id, password.salt, password.hash);
    await repo.deleteSessionsForAccount(target.id);
  }
  if (body.isAdmin !== undefined) await repo.setDispatcherAdmin(target.id, body.isAdmin);
  if (body.disabled !== undefined) {
    await repo.setAccountDisabled(target.id, body.disabled);
    if (body.disabled) await repo.deleteSessionsForAccount(target.id);
  }

  const action = body.disabled !== undefined
    ? (body.disabled ? 'account.disable' : 'account.enable')
    : body.isAdmin !== undefined
      ? (body.isAdmin ? 'account.promote' : 'account.demote')
      : body.password !== undefined
        ? 'account.password_reset'
        : body.name !== undefined
          ? 'account.rename'
          : 'account.email_update';
  await audit(req, action, emailChange || target.email, {
    emailChanged: emailChange !== null,
    passwordReset: body.password !== undefined,
    disabled: body.disabled,
    isAdmin: body.isAdmin,
    renamed: body.name !== undefined,
  });

  res.json({ account: await repo.findAccountById(target.id) });
});

app.delete('/api/admin/accounts/:id/sessions', requireApiAdmin(), async (req, res) => {
  const target = await repo.findAccountById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  await repo.deleteSessionsForAccount(target.id);
  await audit(req, 'session.revoke_all', target.email);
  res.status(204).end();
});

app.get('/api/admin/sessions', requireApiAdmin(), async (req, res) => {
  const sessions = await repo.listActiveSessions();
  const currentToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const currentHash = currentToken ? hashResetToken(currentToken) : null;
  res.json({
    sessions: sessions.map((session) => ({ ...session, current: session.id === currentHash })),
  });
});

app.delete('/api/admin/sessions/:id', requireApiAdmin(), async (req, res) => {
  const tokenHash = String(req.params.id || '');
  if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return res.status(400).json({ error: 'Unknown session.' });
  await repo.deleteSession(tokenHash);
  await audit(req, 'session.revoke', tokenHash.slice(0, 12));
  res.status(204).end();
});

/**
 * Rotates the dispatcher access code. The new code is returned exactly once and
 * only its SHA-256 hash is stored, so it cannot be recovered later.
 */
app.post('/api/admin/invite-code', requireApiAdmin(), async (req, res) => {
  const code = crypto.randomBytes(24).toString('base64url');
  await repo.setSetting(INVITE_CODE_HASH_KEY, hashResetToken(code));
  await audit(req, 'invite.rotate', 'dispatcher-access-code');
  res.json({
    code,
    message: 'Copy this code now. Only its hash is stored, so it cannot be shown again.',
  });
});

app.get('/api/admin/audit', requireApiAdmin(), async (req, res) => {
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.trunc(requested))) : 50;
  res.json({ entries: await repo.listAudit(limit) });
});

app.get('/api/bookings', requireApiRole('dispatcher'), async (req, res) => {
  res.json(await repo.listBookings());
});

app.get('/api/analytics/summary', requireApiRole('dispatcher'), async (req, res) => {
  const range = String(req.query.range || '30d').toLowerCase();
  if (!ANALYTICS_RANGES.has(range)) {
    return res.status(400).json({
      error: `range must be one of: ${[...ANALYTICS_RANGES.keys()].join(', ')}.`,
    });
  }

  const rangeDays = ANALYTICS_RANGES.get(range);
  const sinceIso = rangeDays === null
    ? null
    : new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await repo.listBookingsSince(sinceIso);
  res.json(buildAnalyticsSummary(rows, range));
});

/**
 * Demo-only historical rides so the reporting view has something to show.
 * Never available in production unless ALLOW_DEMO_SEED=1 is set explicitly.
 */
app.post('/api/demo/history', requireApiRole('dispatcher'), async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') {
    return res.status(403).json({ error: 'Demo history seeding is disabled in production.' });
  }

  const routes = [
    ['Newark Liberty International (EWR)', 'Hudson Yards, Manhattan', 'suv'],
    ['The Peninsula, Midtown', 'Teterboro Airport (TEB)', 'sedan'],
    ['Greenwich, CT', 'Wall Street, Manhattan', 'sedan'],
    ['Princeton, NJ', 'MetLife Stadium', 'sprinter'],
    ['SoHo, Manhattan', 'Westchester County Airport (HPN)', 'suv'],
    ['Jersey City, NJ', 'The Ned NoMad, Manhattan', 'sedan'],
    ['Teterboro Airport (TEB)', 'Scarsdale, NY', 'suv'],
    ['The Plaza, Midtown', 'Hamptons, NY', 'limousine'],
    ['Hoboken, NJ', 'Brooklyn Heights, NY', 'sedan'],
    ['Newark Liberty International (EWR)', 'Ritz-Carlton Central Park', 'limousine'],
    ['Madison, NJ', 'Philadelphia International (PHL)', 'suv'],
    ['Lower Manhattan, NY', 'Greenwich, CT', 'suv'],
  ];
  const driverIds = [...DRIVER_REGISTRY.keys()];
  const now = new Date();
  const created = [];

  routes.forEach(([pickupLocation, dropoffLocation, vehicleType], index) => {
    const pickup = new Date(now);
    pickup.setDate(pickup.getDate() - (index + 1));
    pickup.setHours(8 + (index % 10), index % 2 === 0 ? 0 : 30, 0, 0);

    const hourly = index % 3 === 0;
    const hours = hourly ? 2 + (index % 4) : null;
    const baseRateCents = hourly
      ? 16500 + (index % 3) * 1500
      : pricing.VEHICLE_BASE_RATES_CENTS[vehicleType];
    const fareCents = hourly ? Math.round(baseRateCents * hours) : baseRateCents;
    const quote = pricing.derive({
      mode: hourly ? 'hourly' : 'point_to_point',
      baseRateCents,
      hours,
      gratuityCents: Math.round(fareCents * 0.18),
      depositCents: index % 4 === 0 ? 10000 : 0,
    });

    created.push({
      pickupLocation,
      dropoffLocation,
      pickupDateTime: pickup.toISOString(),
      vehicleType,
      passengerCount: 1 + (index % 4),
      driverId: driverIds[index % driverIds.length],
      luggageNotes: null,
      assignedVehicle: `${vehicleType === 'sedan' ? 'Executive Sedan' : vehicleType === 'suv' ? 'Cadillac Escalade' : vehicleType === 'sprinter' ? 'Mercedes Sprinter' : 'Stretch Limousine'} 0${1 + (index % 2)}`,
      pricing: quote,
      status: 'completed',
      clientEmail: null,
      clientName: null,
      createdAt: pickup.toISOString(),
    });
  });

  const inserted = await repo.insertDemoBookings(created);
  res.status(201).json({ created: inserted.length, rides: inserted });
});

app.get('/api/client/trips', requireApiRole('client'), async (req, res) => {
  const [rows, reviews] = await Promise.all([
    repo.listClientTrips(req.authUser.email),
    repo.listReviewsForClient(req.authUser.email),
  ]);

  const trips = rows.map((booking) => ({
    ...booking,
    driverName: booking.driverId ? getDriver(booking.driverId)?.name || null : null,
    review: reviews.get(booking.id) || null,
  }));
  res.json({ user: publicUser(req.authUser), trips });
});

app.post('/api/client/trips/:id/review', requireApiRole('client'), async (req, res) => {
  const booking = await repo.getBooking(req.params.id);
  if (!booking || booking.clientEmail !== req.authUser.email) {
    return res.status(404).json({ error: 'Trip was not found.' });
  }
  if (booking.status !== 'completed') return res.status(409).json({ error: 'A trip can be rated after it is completed.' });

  const rating = Number(req.body && req.body.rating);
  const feedback = req.body && typeof req.body.feedback === 'string' ? req.body.feedback.trim() : '';
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5.' });
  }
  if (feedback.length > 1000) return res.status(400).json({ error: 'feedback must not exceed 1000 characters.' });

  const review = await repo.upsertReview({
    bookingId: booking.id,
    clientEmail: req.authUser.email,
    driverId: booking.driverId,
    rating,
    feedback: feedback || null,
  });
  res.json(review);
});

app.post('/api/client/feedback', requireApiRole('client'), async (req, res) => {
  const category = req.body && typeof req.body.category === 'string' ? req.body.category.trim() : '';
  const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!['experience', 'booking', 'portal', 'other'].includes(category)) {
    return res.status(400).json({ error: 'Choose a valid feedback category.' });
  }
  if (!message || message.length > 2000) {
    return res.status(400).json({ error: 'Feedback is required and must not exceed 2000 characters.' });
  }
  const entry = await repo.insertFeedback({ clientEmail: req.authUser.email, category, message });
  res.status(201).json(entry);
});

app.get('/api/telemetry', requireApiRole('dispatcher'), async (req, res) => {
  const [latestByDriver, activeTripRows, totalPings] = await Promise.all([
    repo.latestTelemetryByDriver(),
    repo.listActiveTrips(),
    repo.countTelemetry(),
  ]);

  const drivers = [...DRIVER_REGISTRY.values()].map((driver) => {
    const fix = latestByDriver.get(driver.id) || null;
    return {
      driverId: driver.id,
      name: driver.name,
      location: fix
        ? {
          latitude: fix.latitude,
          longitude: fix.longitude,
          accuracy: fix.accuracy,
          heading: fix.heading,
          speed: fix.speed,
          recordedAt: fix.recordedAt,
        }
        : null,
    };
  });

  const activeTrips = activeTripRows.map((booking) => ({
    id: booking.id,
    driverId: booking.driverId,
    status: booking.status,
    pickupLocation: booking.pickupLocation,
    dropoffLocation: booking.dropoffLocation,
    pickupDateTime: booking.pickupDateTime,
  }));

  res.json({
    generatedAt: new Date().toISOString(),
    drivers,
    activeTrips,
    totalPings,
  });
});

app.get('/api/drivers/:driverId', (req, res) => {
  const driverId = normalizeDriverId(req.params.driverId);

  if (!isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
    return res.status(400).json({ error: 'A valid Driver ID is required.' });
  }

  const driver = getDriver(driverId);
  if (!driver) {
    return res.status(404).json({ error: `Driver ID "${driverId}" was not recognized.` });
  }

  res.json(driver);
});

app.get('/api/drivers/:driverId/manifest', async (req, res) => {
  const driverId = normalizeDriverId(req.params.driverId);

  if (!isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
    return res.status(400).json({ error: 'A valid Driver ID is required.' });
  }

  const driver = getDriver(driverId);
  if (!driver) {
    return res.status(404).json({ error: `Driver ID "${driverId}" was not recognized.` });
  }

  const manifest = await repo.listManifest(driverId);

  res.json({ driver, driverId, trips: manifest, updatedAt: new Date().toISOString() });
});

app.post('/api/bookings', async (req, res) => {
  const { errors, value } = validateBooking(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed.', details: errors });
  }

  const authenticatedUser = await getAuthenticatedUser(req);
  const clientUser = authenticatedUser?.role === 'client' ? authenticatedUser : null;
  const booking = await repo.createBooking({
    ...value,
    status: 'pending',
    driverId: null,
    assignedVehicle: null,
    clientEmail: clientUser?.email || value.clientEmail,
    clientName: clientUser?.name || value.clientName,
  });

  res.status(201).json(booking);
});

app.patch('/api/bookings/:id', async (req, res) => {
  const booking = await repo.getBooking(req.params.id);

  if (!booking) {
    return res.status(404).json({ error: `Booking with id "${req.params.id}" was not found.` });
  }

  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object.' });
  }

  const allowedFields = ['status', 'assignedVehicle', 'driverId', 'luggageNotes', 'driverLocation', 'pricing'];
  const receivedFields = Object.keys(req.body);
  const unknownFields = receivedFields.filter((field) => !allowedFields.includes(field));

  if (unknownFields.length > 0) {
    return res.status(400).json({
      error: `Only ${allowedFields.join(' and ')} can be updated.`,
      details: [`Unknown field(s): ${unknownFields.join(', ')}.`],
    });
  }

  if (receivedFields.length === 0) {
    return res.status(400).json({
      error: 'Nothing to update.',
      details: [`Provide at least one of: ${allowedFields.join(', ')}.`],
    });
  }

  const requestedStatus = typeof req.body.status === 'string' ? req.body.status.trim().toLowerCase() : null;
  const dispatcherOnlyUpdate = receivedFields.some((field) => ['assignedVehicle', 'driverId', 'luggageNotes', 'pricing'].includes(field))
    || (requestedStatus !== null && !['en_route', 'arrived', 'passenger_aboard', 'completed'].includes(requestedStatus));
  if (dispatcherOnlyUpdate) {
    const authenticatedUser = await getAuthenticatedUser(req);
    if (!authenticatedUser) return res.status(401).json({ error: 'Dispatcher sign in is required for this update.' });
    if (authenticatedUser.role !== 'dispatcher') {
      return res.status(403).json({ error: 'Only dispatcher accounts can make this update.' });
    }
  }

  const changes = {};
  const errors = [];

  if (Object.hasOwn(req.body, 'status')) {
    const status = typeof req.body.status === 'string' ? req.body.status.trim().toLowerCase() : req.body.status;
    if (!BOOKING_STATUSES.includes(status)) {
      errors.push(`status must be one of: ${BOOKING_STATUSES.join(', ')}.`);
    } else if (!canTransitionStatus(booking.status, status)) {
      errors.push(`status cannot transition from ${booking.status} to ${status}.`);
    } else {
      changes.status = status;
    }
  }

  if (Object.hasOwn(req.body, 'driverId')) {
    const driverId = normalizeDriverId(req.body.driverId);
    if (driverId !== null && !isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
      errors.push(`driverId must be a non-empty string (max ${MAX_DRIVER_ID_LENGTH} characters) or null.`);
    } else if (driverId !== null && !getDriver(driverId)) {
      errors.push(`driverId "${driverId}" is not registered.`);
    } else {
      changes.driverId = driverId;
    }
  }

  if (Object.hasOwn(req.body, 'luggageNotes')) {
    const luggageNotes = req.body.luggageNotes;
    if (luggageNotes !== null && typeof luggageNotes !== 'string') {
      errors.push('luggageNotes must be a string or null.');
    } else if (typeof luggageNotes === 'string' && luggageNotes.trim().length > MAX_LUGGAGE_NOTES_LENGTH) {
      errors.push(`luggageNotes must not exceed ${MAX_LUGGAGE_NOTES_LENGTH} characters.`);
    } else {
      changes.luggageNotes = typeof luggageNotes === 'string' && luggageNotes.trim() ? luggageNotes.trim() : null;
    }
  }

  if (Object.hasOwn(req.body, 'driverLocation')) {
    const locationResult = validateDriverLocation(req.body.driverLocation);
    errors.push(...locationResult.errors);
    if (locationResult.value) changes.driverLocation = locationResult.value;

    const telemetryDriverId = changes.driverId ?? booking.driverId;
    if (!telemetryDriverId) {
      errors.push('A driver must be assigned before telemetry can be recorded.');
    }
    if (TERMINAL_STATUSES.has(booking.status)) {
      errors.push('Telemetry cannot be recorded for a completed or cancelled booking.');
    }
  }

  if (Object.hasOwn(req.body, 'assignedVehicle')) {
    const assignedVehicle = req.body.assignedVehicle;
    if (assignedVehicle !== null && !isNonEmptyString(assignedVehicle, 100)) {
      errors.push('assignedVehicle must be a non-empty string or null.');
    } else {
      changes.assignedVehicle = assignedVehicle === null ? null : assignedVehicle.trim();
    }
  }

  if (Object.hasOwn(req.body, 'pricing')) {
    const result = pricing.normalizePricing(req.body.pricing);
    errors.push(...result.errors);
    if (result.value) changes.pricing = result.value;
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed.', details: errors });
  }

  const updated = await repo.updateBooking(booking.id, changes);

  if (changes.driverLocation) {
    await repo.recordTelemetry({
      driverId: updated.driverId ?? changes.driverId ?? booking.driverId,
      bookingId: booking.id,
      ...changes.driverLocation,
    });
    updated.driverLocation = changes.driverLocation;
  }

  res.json(updated);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No API route matches ${req.method} ${req.originalUrl}.` });
});

app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

/* ---------------------------- error handling ---------------------------- */

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }

  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || /DATABASE_URL/.test(err.message || '')) {
    console.error('[db] unavailable:', err.message);
    return res.status(503).json({ error: 'The database is unavailable. Verify DATABASE_URL.' });
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

/* -------------------------------- start --------------------------------- */

if (require.main === module) {
  db.ensureSchema()
    .then(async () => {
      const rotatedCode = await repo.getSetting(INVITE_CODE_HASH_KEY);
      if (!DISPATCHER_INVITE_CODE && !rotatedCode) {
        console.warn('Dispatcher registration is disabled: set DISPATCHER_INVITE_CODE in .env, or rotate a code from /admin.html.');
      }
      app.listen(PORT, () => {
        console.log(`VeloFox Dispatch API listening on http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error('Failed to initialise the database:', error.message);
      console.error('Check DATABASE_URL and that PostgreSQL is reachable.');
      process.exit(1);
    });
}

// @vercel/node invokes the exported function directly, while local runs use
// `app.listen` above. Expose the app itself and attach internals for tests.
module.exports = app;
module.exports.app = app;
module.exports.testables = {
  buildAnalyticsSummary,
  canTransitionStatus,
  getDriver,
  generateLoginCode,
  hashLoginCode,
  hashPassword,
  hashResetToken,
  normalizeDriverId,
  normalizeLoginCode,
  safeStringEqual,
  validateAccountPayload,
  verifyPassword,
  validateBooking,
  validateDriverLocation,
};
