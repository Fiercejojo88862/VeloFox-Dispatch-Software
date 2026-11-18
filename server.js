'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const pricing = require('./lib/pricing');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const MAX_PASSENGERS = 14;
const MAX_TEXT_LENGTH = 200;
const MAX_DRIVER_ID_LENGTH = 50;
const MAX_LUGGAGE_NOTES_LENGTH = 500;
const SESSION_COOKIE = 'velofox_session';
const SESSION_TTL_MS = Math.max(1, Number(process.env.SESSION_TTL_HOURS) || 12) * 60 * 60 * 1000;
const DISPATCHER_INVITE_CODE = process.env.DISPATCHER_INVITE_CODE || '';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const VEHICLE_TYPES = ['sedan', 'suv', 'sprinter', 'limousine'];
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

// Temporary storage until PostgreSQL is wired up. Lives only as long as the process.
const bookings = [];
const driverTelemetry = [];
const users = new Map();
const sessions = new Map();
const tripReviews = new Map();
const appFeedback = [];
const authAttempts = new Map();
const passwordResetTokens = new Map();

app.disable('x-powered-by');
app.use(express.json());
app.get('/dashboard.html', requirePageRole('dispatcher', '/dispatcher-login.html'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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

function userKey(role, email) {
  return `${role}:${email}`;
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

function clearPasswordReset(user) {
  if (user.resetToken) passwordResetTokens.delete(user.resetToken);
  user.resetToken = null;
  user.resetTokenExpires = null;
}

function revokeUserSessions(user) {
  const key = userKey(user.role, user.email);
  for (const [token, session] of sessions.entries()) {
    if (session.userKey === key) sessions.delete(token);
  }
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

function getAuthenticatedUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return users.get(session.userKey) || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function createSession(res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, {
    userKey: userKey(user.role, user.email),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
  );
}

function clearSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function requireApiRole(role) {
  return (req, res, next) => {
    const user = getAuthenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in is required.' });
    if (user.role !== role) return res.status(403).json({ error: 'This account cannot access that resource.' });
    req.authUser = user;
    next();
  };
}

function requirePageRole(role, loginPath) {
  return (req, res, next) => {
    const user = getAuthenticatedUser(req);
    if (!user || user.role !== role) {
      return res.redirect(303, `${loginPath}?next=${encodeURIComponent(req.originalUrl)}`);
    }
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
      driverId: driverId == null ? null : driverId,
      luggageNotes: typeof luggageNotes === 'string' && luggageNotes.trim() ? luggageNotes.trim() : null,
      assignedVehicle: assignedVehicle == null ? null : assignedVehicle.trim(),
      pricing: normalizedPricing || pricing.defaultPricing(vehicleType),
    },
  };
}

function findBookingIndex(id) {
  return bookings.findIndex((booking) => booking.id === id);
}

function getDriverManifest(driverId) {
  return bookings
    .filter((booking) => booking.driverId === driverId && !TERMINAL_STATUSES.has(booking.status))
    .sort((a, b) => Date.parse(a.pickupDateTime) - Date.parse(b.pickupDateTime));
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
 * Aggregates the in-memory booking table into the reporting payload.
 * Mirrors the future SQL view: revenue is recognized on completed rides only,
 * while non-terminal rides contribute to pipeline value.
 */
function buildAnalyticsSummary(rangeKey, now = new Date()) {
  const rangeDays = ANALYTICS_RANGES.get(rangeKey);
  const sinceMs = rangeDays === null ? null : now.getTime() - rangeDays * 24 * 60 * 60 * 1000;

  const scoped = bookings.filter((booking) => {
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

function recordDriverTelemetry(booking, location, createdAt = new Date().toISOString()) {
  const telemetry = {
    id: driverTelemetry.length + 1,
    driverId: booking.driverId,
    bookingId: booking.id,
    ...location,
    createdAt,
  };
  driverTelemetry.push(telemetry);
  return telemetry;
}

/* -------------------------------- routes -------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'VeloFox Dispatch API is running' });
});

app.post('/api/auth/register', (req, res) => {
  const role = req.body && req.body.role;
  if (!['client', 'dispatcher'].includes(role)) {
    return res.status(400).json({ error: 'role must be client or dispatcher.' });
  }

  if (role === 'dispatcher' && !DISPATCHER_INVITE_CODE) {
    return res.status(503).json({
      error: 'Dispatcher registration is not configured. An administrator must set DISPATCHER_INVITE_CODE.',
    });
  }

  const inviteAttemptKey = authAttemptKey(req, 'dispatcher-registration', 'invite-code');
  if (role === 'dispatcher' && isAuthRateLimited(inviteAttemptKey)) {
    return res.status(429).json({ error: 'Too many access-code attempts. Try again in 15 minutes.' });
  }

  const errors = validateAccountPayload(req.body, { requireInviteCode: role === 'dispatcher' });
  if (role === 'dispatcher' && errors.length === 0 && !safeStringEqual(req.body.inviteCode, DISPATCHER_INVITE_CODE)) {
    recordAuthFailure(inviteAttemptKey);
    errors.push('The dispatcher access code is invalid.');
  }
  if (errors.length > 0) return res.status(400).json({ error: 'Registration failed.', details: errors });

  const email = normalizeEmail(req.body.email);
  const key = userKey(role, email);
  if (users.has(key)) return res.status(409).json({ error: 'An account already exists for this email and role.' });

  const password = hashPassword(req.body.password);
  const user = {
    id: crypto.randomUUID(),
    role,
    name: req.body.name.trim(),
    email,
    passwordSalt: password.salt,
    passwordHash: password.hash,
    resetToken: null,
    resetTokenExpires: null,
    createdAt: new Date().toISOString(),
  };
  users.set(key, user);
  if (role === 'dispatcher') authAttempts.delete(inviteAttemptKey);
  createSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
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

  const user = users.get(userKey(role, email));
  if (!user || !verifyPassword(password, user)) {
    recordAuthFailure(attemptKey);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }

  authAttempts.delete(attemptKey);
  createSession(res, user);
  res.json({ user: publicUser(user) });
});

app.get('/api/auth/session', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'No active session.' });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(req, res);
  res.status(204).end();
});

app.post('/api/auth/forgot-password', (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  if (!isNonEmptyString(email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid dispatcher email address.' });
  }

  const attemptKey = authAttemptKey(req, 'dispatcher-password-reset', email);
  const genericResponse = {
    message: 'If a dispatcher account matches that email, a reset link has been prepared.',
  };
  if (isAuthRateLimited(attemptKey)) return res.status(202).json(genericResponse);

  const user = users.get(userKey('dispatcher', email));
  if (user) {
    clearPasswordReset(user);
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashResetToken(rawToken);
    user.resetToken = tokenHash;
    user.resetTokenExpires = Date.now() + RESET_TOKEN_TTL_MS;
    passwordResetTokens.set(tokenHash, userKey(user.role, user.email));
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

app.post('/api/auth/reset-password', (req, res) => {
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
  const resetUserKey = passwordResetTokens.get(tokenHash);
  const user = resetUserKey ? users.get(resetUserKey) : null;
  if (!user || user.role !== 'dispatcher' || !user.resetToken || !safeStringEqual(user.resetToken, tokenHash)) {
    recordAuthFailure(attemptKey);
    return res.status(400).json({ error: 'This reset link is invalid or has already been used.' });
  }
  if (!user.resetTokenExpires || user.resetTokenExpires <= Date.now()) {
    clearPasswordReset(user);
    recordAuthFailure(attemptKey);
    return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
  }

  const password = hashPassword(newPassword);
  user.passwordSalt = password.salt;
  user.passwordHash = password.hash;
  clearPasswordReset(user);
  revokeUserSessions(user);
  authAttempts.delete(attemptKey);
  res.json({ message: 'Password updated. Sign in with your new password.' });
});

app.get('/api/bookings', requireApiRole('dispatcher'), (req, res) => {
  res.json(bookings);
});

app.get('/api/analytics/summary', requireApiRole('dispatcher'), (req, res) => {
  const range = String(req.query.range || '30d').toLowerCase();
  if (!ANALYTICS_RANGES.has(range)) {
    return res.status(400).json({
      error: `range must be one of: ${[...ANALYTICS_RANGES.keys()].join(', ')}.`,
    });
  }
  res.json(buildAnalyticsSummary(range));
});

/**
 * Demo-only historical rides so the reporting view has something to show.
 * Never available in production unless ALLOW_DEMO_SEED=1 is set explicitly.
 */
app.post('/api/demo/history', requireApiRole('dispatcher'), (req, res) => {
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
      id: crypto.randomUUID(),
      pickupLocation,
      dropoffLocation,
      pickupDateTime: pickup.toISOString(),
      vehicleType,
      passengerCount: 1 + (index % 4),
      driverId: driverIds[index % driverIds.length],
      luggageNotes: null,
      assignedVehicle: `${vehicleType === 'sedan' ? 'Executive Sedan' : vehicleType === 'suv' ? 'Luxury SUV' : vehicleType === 'sprinter' ? 'Sprinter Van' : 'Limousine'} 0${1 + (index % 2)}`,
      pricing: quote,
      status: 'completed',
      clientEmail: null,
      clientName: null,
      driverLocation: null,
      createdAt: pickup.toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  bookings.push(...created);
  res.status(201).json({ created: created.length, rides: created });
});

app.get('/api/client/trips', requireApiRole('client'), (req, res) => {
  const trips = bookings
    .filter((booking) => booking.clientEmail === req.authUser.email)
    .sort((a, b) => Date.parse(b.pickupDateTime) - Date.parse(a.pickupDateTime))
    .map((booking) => ({
      ...booking,
      driverName: booking.driverId ? getDriver(booking.driverId)?.name || null : null,
      review: tripReviews.get(booking.id) || null,
    }));
  res.json({ user: publicUser(req.authUser), trips });
});

app.post('/api/client/trips/:id/review', requireApiRole('client'), (req, res) => {
  const booking = bookings.find((item) => item.id === req.params.id && item.clientEmail === req.authUser.email);
  if (!booking) return res.status(404).json({ error: 'Trip was not found.' });
  if (booking.status !== 'completed') return res.status(409).json({ error: 'A trip can be rated after it is completed.' });

  const rating = Number(req.body && req.body.rating);
  const feedback = req.body && typeof req.body.feedback === 'string' ? req.body.feedback.trim() : '';
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5.' });
  }
  if (feedback.length > 1000) return res.status(400).json({ error: 'feedback must not exceed 1000 characters.' });

  const review = {
    bookingId: booking.id,
    clientEmail: req.authUser.email,
    driverId: booking.driverId,
    rating,
    feedback: feedback || null,
    updatedAt: new Date().toISOString(),
  };
  tripReviews.set(booking.id, review);
  res.json(review);
});

app.post('/api/client/feedback', requireApiRole('client'), (req, res) => {
  const category = req.body && typeof req.body.category === 'string' ? req.body.category.trim() : '';
  const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!['experience', 'booking', 'portal', 'other'].includes(category)) {
    return res.status(400).json({ error: 'Choose a valid feedback category.' });
  }
  if (!message || message.length > 2000) {
    return res.status(400).json({ error: 'Feedback is required and must not exceed 2000 characters.' });
  }
  const entry = {
    id: crypto.randomUUID(),
    clientEmail: req.authUser.email,
    category,
    message,
    createdAt: new Date().toISOString(),
  };
  appFeedback.push(entry);
  res.status(201).json({ id: entry.id, createdAt: entry.createdAt });
});

app.get('/api/telemetry', requireApiRole('dispatcher'), (req, res) => {
  const latestByDriver = new Map();
  for (const point of driverTelemetry) latestByDriver.set(point.driverId, point);

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

  const activeTrips = bookings
    .filter((booking) => booking.driverId && !TERMINAL_STATUSES.has(booking.status))
    .map((booking) => ({
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
    totalPings: driverTelemetry.length,
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

app.get('/api/drivers/:driverId/manifest', (req, res) => {
  const driverId = normalizeDriverId(req.params.driverId);

  if (!isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
    return res.status(400).json({ error: 'A valid Driver ID is required.' });
  }

  const driver = getDriver(driverId);
  if (!driver) {
    return res.status(404).json({ error: `Driver ID "${driverId}" was not recognized.` });
  }

  const manifest = getDriverManifest(driverId);

  res.json({ driver, driverId, trips: manifest, updatedAt: new Date().toISOString() });
});

app.post('/api/bookings', (req, res) => {
  const { errors, value } = validateBooking(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed.', details: errors });
  }

  const now = new Date().toISOString();
  const authenticatedUser = getAuthenticatedUser(req);
  const clientUser = authenticatedUser?.role === 'client' ? authenticatedUser : null;
  const booking = {
    id: crypto.randomUUID(),
    ...value,
    status: 'pending',
    driverId: null,
    assignedVehicle: null,
    clientEmail: clientUser?.email || null,
    clientName: clientUser?.name || null,
    driverLocation: null,
    createdAt: now,
    updatedAt: now,
  };

  bookings.push(booking);
  res.status(201).json(booking);
});

app.patch('/api/bookings/:id', (req, res) => {
  const index = findBookingIndex(req.params.id);

  if (index === -1) {
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
    const authenticatedUser = getAuthenticatedUser(req);
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
    } else if (!canTransitionStatus(bookings[index].status, status)) {
      errors.push(`status cannot transition from ${bookings[index].status} to ${status}.`);
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

    const telemetryDriverId = changes.driverId ?? bookings[index].driverId;
    if (!telemetryDriverId) {
      errors.push('A driver must be assigned before telemetry can be recorded.');
    }
    if (TERMINAL_STATUSES.has(bookings[index].status)) {
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

  const now = new Date().toISOString();
  const updated = { ...bookings[index], ...changes, updatedAt: now };
  bookings[index] = updated;

  if (changes.driverLocation) {
    recordDriverTelemetry(updated, changes.driverLocation, now);
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

  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

/* -------------------------------- start --------------------------------- */

if (require.main === module) {
  if (!DISPATCHER_INVITE_CODE) {
    console.warn('Dispatcher registration is disabled: set DISPATCHER_INVITE_CODE in .env.');
  }
  app.listen(PORT, () => {
    console.log(`VeloFox Dispatch API listening on http://localhost:${PORT}`);
  });
}

// @vercel/node invokes the exported function directly, while local runs use
// `app.listen` above. Expose the app itself and attach internals for tests.
module.exports = app;
module.exports.app = app;
module.exports.testables = {
  bookings,
  appFeedback,
  canTransitionStatus,
  driverTelemetry,
  getDriver,
  getDriverManifest,
  hashPassword,
  hashResetToken,
  normalizeDriverId,
  recordDriverTelemetry,
  safeStringEqual,
  sessions,
  passwordResetTokens,
  tripReviews,
  users,
  validateAccountPayload,
  verifyPassword,
  validateBooking,
  validateDriverLocation,
};
