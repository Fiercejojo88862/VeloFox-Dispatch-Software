'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const pricing = require('./lib/pricing');
const dispatch = require('./lib/dispatch');
const db = require('./lib/db');
const repo = require('./lib/repository');
const textFilter = require('./lib/text-filter');

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
const DRIVER_SESSION_COOKIE = 'velofox_driver';
const DRIVER_SESSION_TTL_MS = Math.max(1, Number(process.env.DRIVER_SESSION_TTL_HOURS) || 12) * 60 * 60 * 1000;
const DRIVER_FALLBACK_ACCESS_CODE = process.env.DRIVER_FALLBACK_ACCESS_CODE || '';
const MAX_ACCESS_CODE_LENGTH = 64;
const DISPATCHER_INVITE_CODE = process.env.DISPATCHER_INVITE_CODE || '';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const INVITE_CODE_HASH_KEY = 'dispatcher_invite_code_hash';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PAGE_DIRECTORY_OWNER_EMAIL = 'josephshaker2020@aol.com';

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
  'dropped_off',
  'completed',
  'cancelled',
];
const TERMINAL_STATUSES = new Set(['dropped_off', 'completed', 'cancelled']);
const ACTIVE_BOOKING_STATUSES = new Set(['assigned', 'en_route', 'arrived', 'passenger_aboard']);
const STATUS_TRANSITIONS = {
  pending: new Set(['confirmed', 'cancelled']),
  confirmed: new Set(['assigned', 'cancelled']),
  assigned: new Set(['en_route', 'cancelled']),
  en_route: new Set(['arrived', 'cancelled']),
  arrived: new Set(['passenger_aboard', 'cancelled']),
  passenger_aboard: new Set(['dropped_off', 'cancelled']),
  dropped_off: new Set(['completed']),
  completed: new Set(),
  // A cancelled job can be reopened into any live or finished status.
  cancelled: new Set(BOOKING_STATUSES.filter((status) => status !== 'cancelled')),
};
// The database is authoritative; this map is a short-lived read cache so the
// synchronous booking validators can still use it. Admin edits refresh it.
const DRIVER_REGISTRY = new Map([
  ['VF-1001', { id: 'VF-1001', name: 'Marcus Vance', phone: '', status: 'available' }],
  ['VF-1002', { id: 'VF-1002', name: 'David Sterling', phone: '', status: 'available' }],
  ['VF-1003', { id: 'VF-1003', name: 'Elena Marquez', phone: '', status: 'available' }],
  ['VF-2004', { id: 'VF-2004', name: 'Naomi Laurent', phone: '', status: 'available' }],
]);
const DRIVER_STATUSES = new Set(['available', 'assigned', 'off_duty']);
const DRIVER_CACHE_TTL_MS = 10000;
let driversLoadedAt = 0;
let driverRefresh = null;

async function refreshDriverRegistry(force = false) {
  const now = Date.now();
  if (!force && driversLoadedAt > 0 && now - driversLoadedAt < DRIVER_CACHE_TTL_MS) return;
  if (driverRefresh) return driverRefresh;

  driverRefresh = (async () => {
    try {
      const drivers = await repo.listDrivers();
      DRIVER_REGISTRY.clear();
      drivers.filter((driver) => !driver.deletedAt).forEach((driver) => DRIVER_REGISTRY.set(driver.id, driver));
      driversLoadedAt = Date.now();
    } catch (error) {
      console.warn('[drivers] using cached registry:', error.message);
    } finally {
      driverRefresh = null;
    }
  })();
  return driverRefresh;
}

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
app.use((req, res, next) => {
  // Defense-in-depth headers. Vercel's legacy build/routes config does not
  // reliably apply vercel.json headers, so set them on every Express response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use(express.json());
app.use('/api', textFilter.sanitizeBody);
app.use('/api', (req, res, next) => {
  // API responses include account, driver, and booking data; never cache them.
  res.setHeader('Cache-Control', 'no-store, private');
  next();
});
app.use(async (req, res, next) => {
  // Health must be able to report an outage instead of failing on the check.
  if (req.path === '/api/health') return next();
  try {
    await ensureDatabase();
    await refreshDriverRegistry();
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
app.get('/drivers-admin.html', requirePageAdmin(), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'drivers-admin.html'));
});
app.get('/financial.html', requirePageRole('dispatcher', '/dispatcher-login.html'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'financial.html'));
});
app.get('/client.html', requirePageRole('client', '/client-login.html'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // Reset links carry a secret token in the query string; keep them out of
    // caches and out of outgoing Referer headers.
    if (path.basename(filePath) === 'reset-password.html') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
  },
}));

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
    canViewPageDirectory: canViewPageDirectory(user),
  };
}

function canViewPageDirectory(user) {
  return Boolean(
    user
    && user.role === 'dispatcher'
    && user.isAdmin
    && normalizeEmail(user.email) === PAGE_DIRECTORY_OWNER_EMAIL
  );
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

/* -------------------------- chauffeur sign-in ---------------------------- */

function hashDriverAccessCode(code, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(code, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyDriverAccessCode(code, driver) {
  if (!driver || !driver.accessCodeHash) return false;
  const candidate = crypto.scryptSync(code, driver.accessCodeSalt, 64);
  const expected = Buffer.from(driver.accessCodeHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function getAuthenticatedDriver(req) {
  const token = parseCookies(req.headers.cookie)[DRIVER_SESSION_COOKIE];
  if (!token) return null;
  const driver = await repo.findDriverSession(hashResetToken(token));
  if (!driver) {
    await repo.deleteDriverSession(hashResetToken(token));
    return null;
  }
  return driver;
}

async function createDriverSession(res, driver) {
  const token = crypto.randomBytes(32).toString('base64url');
  await repo.createDriverSession(
    hashResetToken(token),
    driver.id,
    new Date(Date.now() + DRIVER_SESSION_TTL_MS)
  );
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${DRIVER_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(DRIVER_SESSION_TTL_MS / 1000)}${secure}`
  );
}

async function clearDriverSession(req, res) {
  const token = parseCookies(req.headers.cookie)[DRIVER_SESSION_COOKIE];
  if (token) await repo.deleteDriverSession(hashResetToken(token));
  res.setHeader('Set-Cookie', `${DRIVER_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
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
async function sendEmail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!to || !apiKey || !from) {
    console.warn(`[email] skipped (no recipient or SMTP configured): ${to} | ${subject}`);
    return { sent: false, reason: 'not configured' };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to, subject, text }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error('[email] send failed:', response.status, data);
      return { sent: false, reason: `status ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.error('[email] send failed:', error.message);
    return { sent: false, reason: error.message };
  }
}

async function sendDriverJobEmail(booking) {
  if (!booking.driverId) return;
  const email = await repo.getDriverEmail(booking.driverId);
  if (!email) return;
  const when = booking.pickupDateTime
    ? `Pickup · ${new Date(booking.pickupDateTime).toLocaleString()}`
    : '';
  const text = [
    "You've been assigned a new job:",
    "",
    `Ride ${String(booking.id).slice(0, 8)}`,
    when,
    `${booking.pickupLocation} → ${booking.dropoffLocation}`,
    "",
    "Sign in to your driver portal to review and start.",
  ].filter(Boolean).join("\n");
  await sendEmail(email, 'New job dispatched — VeloFox', text);
}

const CLIENT_EMAIL_COPY = {
  booking_received: ['Ride request received', 'Thanks for booking with VeloFox. Dispatch is confirming your chauffeur.'],
  assigned: ['Your chauffeur is assigned', 'A VeloFox chauffeur has been assigned to your ride.'],
  en_route: ['Your chauffeur is en route', 'Your VeloFox chauffeur is on the way to your pickup.'],
  completed: ['Your ride is complete', 'Thanks for riding with VeloFox. We hope to see you again.'],
  cancelled: ['Your ride was cancelled', 'Your VeloFox ride has been cancelled. Contact dispatch with questions.'],
};

async function sendClientRideEmail(booking, event) {
  const copy = CLIENT_EMAIL_COPY[event];
  if (!copy || !booking?.clientEmail) return;
  const when = booking.pickupDateTime
    ? `Pickup · ${new Date(booking.pickupDateTime).toLocaleString()}`
    : '';
  const text = [
    copy[1],
    '',
    `Ride ${String(booking.id).slice(0, 8)}`,
    when,
    `${booking.pickupLocation} → ${booking.dropoffLocation}`,
    '',
    'VeloFox Dispatch',
  ].filter(Boolean).join('\n');
  await sendEmail(booking.clientEmail, `${copy[0]} — VeloFox`, text);
}

/**
 * Sends a one-line SMS to a driver via Unlimited Messaging when they are
 * assigned a job. The Free plan is permanent, needs no credit card, and sends
 * from your own Android phone on its carrier plan — a good fit for small
 * volumes; adding a UM_API_KEY also lifts the small "Sent with
 * UnlimitedMessaging.app" footer on the Free plan. See unlimitedmessaging.app.
 */
async function sendDriverSMS(booking) {
  if (!booking.driverId) return;
  const driver = await repo.getDriverRecord(booking.driverId);
  const to = driver && driver.phone;
  if (!to) return;
  const apiKey = process.env.UM_API_KEY;
  if (!apiKey) {
    console.warn(`[sms] skipped (no UM_API_KEY configured): ${booking.driverId}`);
    return;
  }
  const digits = String(to).replace(/\D/g, '');
  const recipient = digits.length === 10 ? `+1${digits}`
    : digits.length === 11 && digits.startsWith('1') ? `+${digits}`
    : `+${digits}`;
  if (!recipient) return;
  const message = [
    `VeloFox: New job assigned — Ride ${String(booking.id).slice(0, 8)}`,
    booking.pickupDateTime
      ? `Pickup · ${new Date(booking.pickupDateTime).toLocaleString()}`
      : '',
    `${booking.pickupLocation} → ${booking.dropoffLocation}`,
    'Sign in to the driver portal to review.',
  ].filter(Boolean).join('\n');
  try {
    const response = await fetch('https://api.unlimitedmessaging.app/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ recipient, text: message }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error('[sms] Unlimited Messaging rejected the message:', response.status, data);
      return;
    }
    console.log(`[sms] dispatched to ${recipient} for booking ${String(booking.id).slice(0, 8)}`);
  } catch (error) {
    console.error('[sms] Unlimited Messaging send failed:', error.message);
  }
}

async function sendSMS(to, text) {
  const apiKey = process.env.UM_API_KEY;
  if (!apiKey) return { sent: false, reason: 'not configured' };
  const digits = String(to || '').replace(/\D/g, '');
  if (!digits) return { sent: false, reason: 'no recipient' };
  const recipient = digits.length === 10 ? `+1${digits}`
    : digits.length === 11 && digits.startsWith('1') ? `+${digits}`
      : `+${digits}`;
  try {
    const response = await fetch('https://api.unlimitedmessaging.app/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ recipient, text }),
    });
    if (!response.ok) {
      console.error('[sms] client notification rejected:', response.status);
      return { sent: false, reason: `status ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.error('[sms] client notification failed:', error.message);
    return { sent: false, reason: error.message };
  }
}

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
  errors.push(...textFilter.checkPersonName(name, 'Name').errors);
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
  errors.push(...textFilter.checkLocation(pickupLocation, 'pickupLocation').errors);

  const dropoffLocation = body.dropoffLocation;
  if (!isNonEmptyString(dropoffLocation)) {
    errors.push(`dropoffLocation is required and must be a non-empty string (max ${MAX_TEXT_LENGTH} characters).`);
  }
  errors.push(...textFilter.checkLocation(dropoffLocation, 'dropoffLocation').errors);

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
  errors.push(...textFilter.checkPersonName(clientName, 'clientName').errors);

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
  errors.push(...textFilter.checkFreeText(luggageNotes, 'luggageNotes').errors);

  const beverageRequest = body.beverageRequest;
  if (beverageRequest != null && typeof beverageRequest !== 'string') {
    errors.push('beverageRequest must be a string or null.');
  } else if (typeof beverageRequest === 'string' && beverageRequest.trim().length > MAX_BEVERAGE_REQUEST_LENGTH) {
    errors.push(`beverageRequest must not exceed ${MAX_BEVERAGE_REQUEST_LENGTH} characters.`);
  }
  errors.push(...textFilter.checkFreeText(beverageRequest, 'beverageRequest').errors);

  const specialRequests = body.specialRequests;
  if (specialRequests != null && typeof specialRequests !== 'string') {
    errors.push('specialRequests must be a string or null.');
  } else if (typeof specialRequests === 'string' && specialRequests.trim().length > MAX_SPECIAL_REQUESTS_LENGTH) {
    errors.push(`specialRequests must not exceed ${MAX_SPECIAL_REQUESTS_LENGTH} characters.`);
  }
  errors.push(...textFilter.checkFreeText(specialRequests, 'specialRequests').errors);

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
  const terminalCount = completed + cancelled + byStatus.dropped_off;

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

function normalizeDriverFields(body, existing = null) {
  const errors = [];
  const source = isPlainObject(body) ? body : {};

  const id = source.id === undefined ? existing?.id : normalizeDriverId(source.id);
  if (!isNonEmptyString(id, MAX_DRIVER_ID_LENGTH) || !/^[A-Z0-9][A-Z0-9-]*$/.test(id)) {
    errors.push(`id must be 1-${MAX_DRIVER_ID_LENGTH} uppercase letters, digits or hyphens.`);
  }

  const name = source.name === undefined ? existing?.name : (typeof source.name === 'string' ? source.name.trim() : '');
  if (!isNonEmptyString(name, 120)) errors.push('name is required and must not exceed 120 characters.');
  errors.push(...textFilter.checkPersonName(name, 'name').errors);

  const rawPhone = source.phone === undefined ? existing?.phone : source.phone;
  if (rawPhone !== null && rawPhone !== undefined && typeof rawPhone !== 'string') {
    errors.push('phone must be a string or null.');
  } else if (typeof rawPhone === 'string' && rawPhone.trim().length > MAX_PHONE_LENGTH) {
    errors.push(`phone must not exceed ${MAX_PHONE_LENGTH} characters.`);
  }
  const phone = typeof rawPhone === 'string' && rawPhone.trim() ? rawPhone.trim() : null;

  const status = source.status === undefined ? (existing?.status || 'available')
    : (typeof source.status === 'string' ? source.status.trim().toLowerCase() : '');
  if (!DRIVER_STATUSES.has(status)) {
    errors.push(`status must be one of: ${[...DRIVER_STATUSES].join(', ')}.`);
  }

  const rawEmail = source.email === undefined ? existing?.email : source.email;
  let email = null;
  if (rawEmail !== null && rawEmail !== undefined) {
    if (typeof rawEmail !== 'string') {
      errors.push('email must be a string or null.');
    } else {
      const trimmedEmail = rawEmail.trim().toLowerCase();
      if (trimmedEmail === '') {
        email = null;
      } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        email = trimmedEmail;
      } else {
        errors.push('email must be a valid email address or blank.');
      }
    }
  }

  return { errors, value: { id, name, phone, email, status } };
}

app.get('/api/admin/drivers', requireApiAdmin(), async (req, res) => {
  res.json({ drivers: await repo.listDrivers() });
});

app.post('/api/admin/drivers', requireApiAdmin(), async (req, res) => {
  const { errors, value } = normalizeDriverFields(req.body);
  if (errors.length > 0) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const driver = await repo.createDriver(value);
    await refreshDriverRegistry(true);
    await audit(req, 'driver.create', driver.id, { name: driver.name });
    res.status(201).json({ driver });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: `Driver ID "${value.id}" already exists.` });
    throw error;
  }
});

app.patch('/api/admin/drivers/:id', requireApiAdmin(), async (req, res) => {
  const currentId = normalizeDriverId(req.params.id);
  const existing = await repo.getDriverRecord(currentId);
  if (!existing) return res.status(404).json({ error: 'Driver not found.' });

  const { errors, value } = normalizeDriverFields(req.body, existing);
  if (errors.length > 0) return res.status(400).json({ error: 'Validation failed.', details: errors });

  try {
    const driver = await repo.updateDriver(currentId, value);
    await refreshDriverRegistry(true);
    await audit(req, 'driver.update', driver.id, { name: driver.name, status: driver.status });
    res.json({ driver });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: `Driver ID "${value.id}" already exists.` });
    throw error;
  }
});

app.get('/api/admin/driver-submissions', requireApiAdmin(), async (req, res) => {
  res.json({ submissions: await repo.listDriverSubmissions() });
});

/* ------------------------ driver self-service ------------------------ */

app.post('/api/driver/profile', async (req, res) => {
  const { errors, value } = normalizeDriverFields({ ...(req.body || {}), status: 'available' });
  if (errors.length > 0) return res.status(400).json({ error: 'Validation failed.', details: errors });

  const existing = await repo.getDriverRecord(value.id);
  if (existing && !existing.deletedAt) {
    return res.status(409).json({ error: `Driver ID "${value.id}" is already registered. Sign in instead.` });
  }

  try {
    const driver = existing
      ? await repo.reactivateDriver(value.id, value)
      : await repo.createDriver(value);
    const action = existing ? 'reactivated' : 'created';
    await repo.recordDriverSubmission({
      driverId: driver.id, name: driver.name, phone: driver.phone, action,
    });
    await refreshDriverRegistry(true);
    await audit(req, `driver.self_${action}`, driver.id, { name: driver.name });

    // New chauffeurs automatically receive a private access code so they can
    // open their manifest without waiting for dispatch to issue one manually.
    let accessCode = '';
    if (!driver.hasAccessCode) {
      accessCode = crypto.randomBytes(9).toString('base64url').slice(0, 12);
      const { salt, hash } = hashDriverAccessCode(accessCode);
      await repo.setDriverAccessCode(driver.id, salt, hash);
    }
    res.status(201).json({ driver, action, accessCode });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: `Driver ID "${value.id}" is already registered.` });
    throw error;
  }
});

app.patch('/api/driver/profile/:id', async (req, res) => {
  const driverId = normalizeDriverId(req.params.id);
  const existing = await repo.getDriverRecord(driverId);
  if (!existing || existing.deletedAt) return res.status(404).json({ error: 'Driver profile not found.' });

  const { errors, value } = normalizeDriverFields({
    id: existing.id,
    name: req.body?.name,
    phone: req.body?.phone,
    status: existing.status,
  }, existing);
  if (errors.length > 0) return res.status(400).json({ error: 'Validation failed.', details: errors });

  const driver = await repo.updateDriverProfile(driverId, value);
  await repo.recordDriverSubmission({
    driverId: driver.id, name: driver.name, phone: driver.phone, action: 'updated',
  });
  await refreshDriverRegistry(true);
  await audit(req, 'driver.self_update', driver.id, { name: driver.name });
  res.json({ driver });
});

app.delete('/api/driver/profile/:id', async (req, res) => {
  const driverId = normalizeDriverId(req.params.id);
  const existing = await repo.getDriverRecord(driverId);
  if (!existing || existing.deletedAt) return res.status(404).json({ error: 'Driver profile not found.' });

  const driver = await repo.softDeleteDriver(driverId);
  await repo.recordDriverSubmission({
    driverId: existing.id, name: existing.name, phone: existing.phone, action: 'deleted',
  });
  await refreshDriverRegistry(true);
  await audit(req, 'driver.self_delete', driverId, { name: existing.name });
  res.json({ driver });
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

/**
 * Seeds demo telemetry for the dispatcher dashboard's live map: creates three
 * in-flight rentals with drivers assigned, then records GPS fixes near the
 * pickups so the map shows moving Chauffeurs.
 * Never available in production unless ALLOW_DEMO_SEED=1 is set explicitly.
 */
app.post('/api/demo/telemetry', requireApiRole('dispatcher'), async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') {
    return res.status(403).json({ error: 'Demo telemetry seeding is disabled in production.' });
  }

  const legs = [
    {
      driverId: 'VF-1001',
      vehicleType: 'suv',
      pickupLocation: 'JFK Airport',
      dropoffLocation: 'The Plaza, Midtown, Manhattan',
      latitude: 40.6399,
      longitude: -73.7816,
      heading: 140,
      speed: 38,
    },
    {
      driverId: 'VF-1002',
      vehicleType: 'sedan',
      pickupLocation: 'Newark Liberty International (EWR)',
      dropoffLocation: 'The Plaza, Midtown, Manhattan',
      latitude: 40.7141,
      longitude: -74.1072,
      heading: 90,
      speed: 25,
    },
    {
      driverId: 'VF-1003',
      vehicleType: 'sedan',
      pickupLocation: 'The Plaza, Midtown, Manhattan',
      dropoffLocation: 'Lincoln Center, Upper West Side',
      latitude: 40.7549,
      longitude: -73.9840,
      heading: 180,
      speed: 32,
    },
  ];

  const pickupAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const created = await repo.insertDemoBookings(legs.map((leg) => ({
    pickupLocation: leg.pickupLocation,
    dropoffLocation: leg.dropoffLocation,
    pickupDateTime: pickupAt,
    vehicleType: leg.vehicleType,
    passengerCount: 2,
    driverId: leg.driverId,
    assignedVehicle: 'Demo Chauffeur Fleet',
    status: 'en_route',
    pricing: pricing.derive({
      mode: 'point_to_point',
      baseRateCents: pricing.VEHICLE_BASE_RATES_CENTS[leg.vehicleType],
      gratuityCents: 0,
      depositCents: 0,
    }),
    clientName: null,
    clientEmail: null,
    createdAt: new Date().toISOString(),
  })));

  const telemetry = [];
  for (const [index, leg] of legs.entries()) {
    telemetry.push(await repo.recordTelemetry({
      driverId: leg.driverId,
      bookingId: created[index].id,
      latitude: leg.latitude,
      longitude: leg.longitude,
      accuracy: 5,
      heading: leg.heading,
      speed: leg.speed,
      recordedAt: new Date().toISOString(),
    }));
  }

  res.status(201).json({ created: created.length, telemetry });
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
  const feedbackFilter = textFilter.checkFreeText(feedback, 'feedback');
  if (feedbackFilter.errors.length > 0) return res.status(400).json({ error: feedbackFilter.errors[0] });

  const review = await repo.upsertReview({
    bookingId: booking.id,
    clientEmail: req.authUser.email,
    driverId: booking.driverId,
    rating,
    feedback: feedbackFilter.value || null,
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
  const messageFilter = textFilter.checkFreeText(message, 'message');
  if (messageFilter.errors.length > 0) return res.status(400).json({ error: messageFilter.errors[0] });
  const entry = await repo.insertFeedback({ clientEmail: req.authUser.email, category, message: messageFilter.value });
  res.status(201).json(entry);
});

app.post('/api/fleet/ping', requireApiRole('dispatcher'), async (req, res) => {
  const driverIds = [...DRIVER_REGISTRY.keys()];
  const pinged = await repo.recordDispatchPings(driverIds);
  await audit(req, 'fleet.ping', 'all-drivers', { pinged });
  res.status(201).json({ pinged, at: new Date().toISOString() });
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

app.get('/api/fleet/roster', requireApiRole('dispatcher'), async (req, res) => {
  const [drivers, bookings, latestByDriver] = await Promise.all([
    repo.listDrivers(),
    repo.listBookings(),
    repo.latestTelemetryByDriver(),
  ]);

  const rosterDrivers = drivers.filter((driver) => !driver.deletedAt).map((driver) => {
    const trips = bookings.filter(
      (booking) => booking.driverId === driver.id && booking.status !== 'cancelled' && booking.status !== 'completed'
    );
    const current = trips.find((booking) => ACTIVE_BOOKING_STATUSES.has(booking.status)) || null;
    const lastPickup = trips.reduce((latest, booking) => Math.max(latest, Date.parse(booking.pickupDateTime) || 0), 0);
    let status = 'available';
    if (driver.status === 'off_duty') status = 'offline';
    else if (current) status = 'on_trip';
    return {
      id: driver.id,
      name: driver.name || driver.id,
      phone: driver.phone || '',
      status,
      vehicle: current?.assignedVehicle || null,
      vehicleClass: current?.vehicleType || null,
      shiftEnd: lastPickup ? new Date(lastPickup + 60 * 60 * 1000).toISOString() : null,
      reporting: Boolean(latestByDriver.get(driver.id)),
      tripId: current?.id || null,
    };
  });

  const vehicles = new Map();
  bookings.forEach((booking) => {
    if (!booking.assignedVehicle) return;
    const assigned = ACTIVE_BOOKING_STATUSES.has(booking.status);
    const current = vehicles.get(booking.assignedVehicle);
    if (current && !assigned) return;
    vehicles.set(booking.assignedVehicle, {
      name: booking.assignedVehicle,
      vehicleClass: booking.vehicleType || current?.vehicleClass || null,
      status: assigned ? 'assigned' : 'available',
      driverId: assigned ? booking.driverId || null : null,
    });
  });

  res.json({
    generatedAt: new Date().toISOString(),
    drivers: rosterDrivers,
    vehicles: [...vehicles.values()].sort((a, b) => a.name.localeCompare(b.name)),
  });
});

app.post('/api/bookings/:id/notify', requireApiRole('dispatcher'), async (req, res) => {
  const booking = await repo.getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Ride not found.' });
  const kind = req.body && req.body.kind === 'pob' ? 'pob' : 'en_route';
  if (!booking.clientPhone) return res.status(400).json({ error: 'This ride has no client phone number.' });
  const ride = String(booking.id).slice(0, 8);
  const message = kind === 'pob'
    ? `VeloFox: Your chauffeur has picked you up (ride ${ride}). Have a great trip!`
    : `VeloFox: Your chauffeur is en route to ${booking.pickupLocation} (ride ${ride}).`;
  const result = await sendSMS(booking.clientPhone, message);
  await audit(req, 'booking.notify', booking.id, { kind, sent: result.sent });
  res.json({ kind, sent: result.sent, reason: result.reason || null });
});

app.post('/api/drivers/:driverId/email', requireApiRole('dispatcher'), async (req, res) => {
  const driverId = normalizeDriverId(req.params.driverId);
  if (!isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
    return res.status(400).json({ error: 'A valid Driver ID is required.' });
  }
  const driver = getDriver(driverId);
  if (!driver) {
    return res.status(404).json({ error: `Driver ID "${driverId}" was not recognized.` });
  }
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const result = await repo.setDriverEmail(driverId, email);
  if (result.error) return res.status(400).json({ error: result.error });
  return res.json({ driver: { ...driver, email: result.email } });
});

/* ------------------------ chauffeur access API ------------------------- */

app.post('/api/driver/login', async (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {};
  const driverId = normalizeDriverId(body.driverId ?? body.id);
  const accessCode = typeof body.accessCode === 'string' ? body.accessCode.trim() : '';
  const attemptKey = authAttemptKey(req, 'driver', driverId || 'unknown');

  if (!isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
    return res.status(400).json({ error: 'A Driver ID is required.' });
  }
  if (isAuthRateLimited(attemptKey)) {
    return res.status(429).json({ error: 'Too many access-code attempts. Try again in 15 minutes.' });
  }

  const driver = await repo.getDriverAuthRecord(driverId);
  const codeRequired = Boolean(driver?.hasAccessCode || DRIVER_FALLBACK_ACCESS_CODE);
  if (codeRequired && !isNonEmptyString(accessCode, MAX_ACCESS_CODE_LENGTH)) {
    return res.status(400).json({ error: 'A Driver ID and access code are required.' });
  }

  const valid = driver
    ? (driver.hasAccessCode
      ? verifyDriverAccessCode(accessCode, driver)
      : (DRIVER_FALLBACK_ACCESS_CODE ? safeStringEqual(accessCode, DRIVER_FALLBACK_ACCESS_CODE) : true))
    : false;

  if (!valid) {
    if (driver) await repo.recordDriverAuthFailure(driver.id);
    recordAuthFailure(attemptKey);
    if (isAuthRateLimited(attemptKey)) {
      return res.status(429).json({ error: 'Too many access-code attempts. Try again in 15 minutes.' });
    }
    return res.status(401).json({ error: 'The Driver ID or access code is incorrect.' });
  }

  authAttempts.delete(attemptKey);
  await repo.resetDriverAuthFailures(driver.id);
  await repo.recordDriverLogin(driver.id);
  await createDriverSession(res, driver);
  res.json({ driver: { id: driver.id, name: driver.name, lastLoginAt: driver.lastLoginAt } });
});

app.get('/api/driver/session', async (req, res) => {
  const driver = await getAuthenticatedDriver(req);
  if (!driver) return res.status(401).json({ error: 'Chauffeur sign in is required.' });
  res.json({ driver: { id: driver.id, name: driver.name, lastLoginAt: driver.lastLoginAt } });
});

app.post('/api/driver/logout', async (req, res) => {
  await clearDriverSession(req, res);
  res.json({ ok: true });
});

app.post('/api/admin/drivers/:id/access-code', requireApiAdmin(), async (req, res) => {
  const driverId = normalizeDriverId(req.params.id);
  const driver = await repo.getDriverRecord(driverId);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });

  const supplied = isPlainObject(req.body) ? req.body.accessCode : undefined;
  if (supplied !== undefined && !isNonEmptyString(supplied, MAX_ACCESS_CODE_LENGTH)) {
    return res.status(400).json({ error: 'An access code must be 1 to 64 characters.' });
  }
  const accessCode = supplied || crypto.randomBytes(9).toString('base64url').slice(0, 12);
  const { salt, hash } = hashDriverAccessCode(accessCode);
  await repo.setDriverAccessCode(driverId, salt, hash);
  await repo.deleteDriverSessionsFor(driverId);
  await audit(req, 'driver.access_code_issued', driverId);
  res.json({ driverId, accessCode });
});

app.post('/api/admin/drivers/:id/revoke-access', requireApiAdmin(), async (req, res) => {
  const driverId = normalizeDriverId(req.params.id);
  const driver = await repo.getDriverRecord(driverId);
  if (!driver) return res.status(404).json({ error: 'Driver not found.' });
  await repo.clearDriverAccessCode(driverId);
  await repo.deleteDriverSessionsFor(driverId);
  await audit(req, 'driver.access_code_revoked', driverId);
  res.json({ ok: true });
});

app.get('/api/drivers/:driverId', async (req, res) => {
  const driverId = normalizeDriverId(req.params.driverId);

  if (!isNonEmptyString(driverId, MAX_DRIVER_ID_LENGTH)) {
    return res.status(400).json({ error: 'A valid Driver ID is required.' });
  }

  let driver = getDriver(driverId);
  if (!driver) {
    await refreshDriverRegistry(true).catch(() => {});
    driver = getDriver(driverId);
  }
  if (!driver) {
    const record = await repo.getDriverRecord(driverId).catch(() => null);
    if (record && !record.deletedAt) {
      driver = { id: record.id, name: record.name, phone: record.phone || '', status: record.status || 'available' };
      DRIVER_REGISTRY.set(driver.id, driver);
    }
  }
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

  const driverSession = await getAuthenticatedDriver(req);
  if (driverSession) {
    if (driverSession.id !== driverId) {
      return res.status(403).json({ error: 'This chauffeur session cannot view that manifest.' });
    }
  } else {
    const dispatcher = await getAuthenticatedUser(req);
    if (!dispatcher || dispatcher.role !== 'dispatcher') {
      return res.status(401).json({ error: 'Chauffeur sign in is required.' });
    }
  }

  let driver = getDriver(driverId);
  if (!driver) {
    await refreshDriverRegistry(true).catch(() => {});
    driver = getDriver(driverId);
  }
  if (!driver) {
    const record = await repo.getDriverRecord(driverId).catch(() => null);
    if (record && !record.deletedAt) {
      driver = { id: record.id, name: record.name, phone: record.phone || '', status: record.status || 'available' };
      DRIVER_REGISTRY.set(driver.id, driver);
    }
  }
  if (!driver) {
    return res.status(404).json({ error: `Driver ID "${driverId}" was not recognized.` });
  }

  const [manifest, dispatchPingAt, completedToday] = await Promise.all([
    repo.listManifest(driverId),
    repo.latestDispatchPing(driverId),
    repo.countDriverCompletions(driverId),
  ]);

  res.json({ driver, driverId, trips: manifest, completedToday, dispatchPingAt, updatedAt: new Date().toISOString() });
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

  await sendClientRideEmail(booking, 'booking_received');
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

  const allowedFields = ['status', 'assignedVehicle', 'driverId', 'luggageNotes', 'driverLocation', 'pricing', 'cancellationReason', 'force'];
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
  const driverProgressStatuses = ['en_route', 'arrived', 'passenger_aboard', 'dropped_off', 'completed'];
  const dispatcherOnlyUpdate = receivedFields.some((field) => ['assignedVehicle', 'driverId', 'luggageNotes', 'pricing', 'cancellationReason', 'force'].includes(field))
    || (requestedStatus !== null && !driverProgressStatuses.includes(requestedStatus));
  if (dispatcherOnlyUpdate) {
    const authenticatedUser = await getAuthenticatedUser(req);
    if (!authenticatedUser) return res.status(401).json({ error: 'Dispatcher sign in is required for this update.' });
    if (authenticatedUser.role !== 'dispatcher') {
      return res.status(403).json({ error: 'Only dispatcher accounts can make this update.' });
    }
  } else {
    const driverSession = await getAuthenticatedDriver(req);
    if (driverSession) {
      if (booking.driverId !== driverSession.id) {
        return res.status(403).json({ error: 'This chauffeur session cannot update that ride.' });
      }
    } else {
      const authenticatedUser = await getAuthenticatedUser(req);
      if (!authenticatedUser) return res.status(401).json({ error: 'Sign in is required for this update.' });
      if (authenticatedUser.role !== 'dispatcher') {
        return res.status(403).json({ error: 'Only dispatcher accounts can make this update.' });
      }
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

  if (Object.hasOwn(req.body, 'force') && typeof req.body.force !== 'boolean') {
    errors.push('force must be a boolean when provided.');
  }

  if (Object.hasOwn(req.body, 'cancellationReason')) {
    const reason = req.body.cancellationReason;
    if (reason !== null && !['test_demo', 'client_cancelled', 'no_show'].includes(reason)) {
      errors.push('cancellationReason must be one of: test_demo, client_cancelled, no_show, or null.');
    } else {
      changes.cancellationReason = reason;
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

  // Assigning a driver puts the trip into the dispatch-ready state so the
  // driver lifecycle can begin — the driver's manifest shows the trip and
  // the driver gets the En Route action instead of the "wait for dispatch" note.
  if (
    changes.driverId !== null
    && changes.status === undefined
    && (booking.status === 'pending' || booking.status === 'confirmed')
  ) {
    changes.status = 'assigned';
  }

  if (booking.status === 'cancelled' && changes.status && changes.status !== 'cancelled'
    && !Object.hasOwn(changes, 'cancellationReason')) {
    changes.cancellationReason = null;
  }

  // A chauffeur or vehicle cannot be double-booked across overlapping service
  // windows. Dispatchers can still force an override from the board.
  if ((Object.hasOwn(changes, 'driverId') || Object.hasOwn(changes, 'assignedVehicle')) && req.body.force !== true) {
    const allBookings = await repo.listBookings();
    const conflicts = dispatch.findConflicts(allBookings, booking, {
      driverId: Object.hasOwn(changes, 'driverId') ? changes.driverId : undefined,
      assignedVehicle: Object.hasOwn(changes, 'assignedVehicle') ? changes.assignedVehicle : undefined,
      excludeId: booking.id,
    });
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: `This assignment overlaps ${conflicts.length} open ride${conflicts.length === 1 ? '' : 's'}.`,
        conflicts: conflicts.map((ride) => ({
          id: ride.id,
          clientName: ride.clientName,
          pickupDateTime: ride.pickupDateTime,
          driverId: ride.driverId,
          assignedVehicle: ride.assignedVehicle,
          status: ride.status,
        })),
      });
    }
  }

  const updated = await repo.updateBooking(booking.id, changes);

  if (changes.driverId !== null) {
    await sendDriverJobEmail(updated);
    await sendDriverSMS(updated);
  }

  const clientEvent = {
    assigned: 'assigned',
    en_route: 'en_route',
    completed: 'completed',
    cancelled: 'cancelled',
  }[changes.status];
  if (clientEvent) await sendClientRideEmail(updated, clientEvent);

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
      await refreshDriverRegistry(true);
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
  canViewPageDirectory,
  canTransitionStatus,
  getDriver,
  normalizeDriverFields,
  generateLoginCode,
  hashDriverAccessCode,
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
  verifyDriverAccessCode,
};
