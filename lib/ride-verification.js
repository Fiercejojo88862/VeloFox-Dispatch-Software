'use strict';

/**
 * Ride verification rules shared by the booking intake and the dispatcher
 * review queue. Keep this module free of database and request dependencies so
 * the signals and decision validation can be unit tested directly.
 */

const textFilter = require('./text-filter');

const VERIFICATION_STATUSES = ['unreviewed', 'verified', 'rejected'];

const REJECTION_REASONS = Object.freeze({
  fake_request: 'Suspected fake request',
  duplicate_request: 'Duplicate request',
  incorrect_details: 'Incorrect client or route details',
  test_request: 'Test request',
  other: 'Other',
});

const MAX_NOTE_LENGTH = 500;

// Free email providers are fine for clients, but throwaway inboxes are a
// common signature of bulk fake reservations.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', 'dispostable.com', 'emailondeck.com',
  'fakeinbox.com', 'guerrillamail.com', 'guerrillamail.net', 'mailinator.com',
  'mailinator.net', 'mailmeteor.com', 'mintemail.com', 'mytrashmail.com',
  'sharklasers.com', 'spam4.me', 'tempmail.com', 'tempmail.net', 'throwawaymail.com',
  'trashmail.com', 'yopmail.com',
]);

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizePhone(value) {
  return typeof value === 'string' ? value.replace(/[^\d]/g, '') : '';
}

function normalizePlace(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** True when a ride is still waiting for a dispatcher Accept/Reject decision. */
function isPendingReview(booking) {
  return Boolean(booking)
    && booking.status === 'pending'
    && (booking.verificationStatus || 'unreviewed') === 'unreviewed';
}

/**
 * Produces human-readable risk signals for the dispatcher. Signals are
 * advisory only: a dispatcher still makes every Accept/Reject decision.
 */
function assessRideRisk(booking, existingBookings = [], options = {}) {
  if (!booking || typeof booking !== 'object') return [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const flags = [];
  const add = (code, severity, label, detail) => {
    flags.push({ code, severity, label, detail });
  };

  const email = normalizeEmail(booking.clientEmail);
  const phone = normalizePhone(booking.clientPhone);
  const domain = email.split('@')[1] || '';
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    add('disposable_email', 'high', 'Throwaway email', `Email domain ${domain} is commonly used for fake requests.`);
  }

  if (!phone) {
    add('missing_phone', 'medium', 'No phone number', 'Dispatch cannot call the client to confirm this ride.');
  }

  if (!options.authenticated) {
    add('anonymous_request', 'low', 'Guest request', 'Submitted without a signed-in client account.');
  }

  const pickup = Date.parse(booking.pickupDateTime);
  if (!Number.isNaN(pickup) && pickup - now < 2 * 60 * 60 * 1000) {
    add('short_notice', 'medium', 'Short notice', 'Pickup is less than two hours away.');
  }

  const rows = Array.isArray(existingBookings) ? existingBookings : [];
  const pickupLocation = normalizePlace(booking.pickupLocation);
  const dropoffLocation = normalizePlace(booking.dropoffLocation);
  const duplicate = rows.find((row) => {
    if (!row || row.id === booking.id) return false;
    const sameContact = normalizeEmail(row.clientEmail) === email
      || (phone && normalizePhone(row.clientPhone) === phone);
    if (!sameContact) return false;
    const otherPickup = Date.parse(row.pickupDateTime);
    const sameTime = !Number.isNaN(otherPickup) && !Number.isNaN(pickup)
      && Math.abs(otherPickup - pickup) < 60 * 60 * 1000;
    const sameRoute = normalizePlace(row.pickupLocation) === pickupLocation
      && normalizePlace(row.dropoffLocation) === dropoffLocation;
    return sameTime || sameRoute;
  });
  if (duplicate) {
    add('duplicate_request', 'high', 'Possible duplicate', `Matches an existing ride #${String(duplicate.id).slice(0, 8)} from the same client.`);
  }

  return flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function validateVerificationDecision(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object.'], value: null };
  }

  const errors = [];
  const decision = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
  if (decision !== 'accept' && decision !== 'reject') {
    errors.push('decision must be either "accept" or "reject".');
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (decision === 'reject' && !Object.hasOwn(REJECTION_REASONS, reason)) {
    errors.push(`reason must be one of: ${Object.keys(REJECTION_REASONS).join(', ')}.`);
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_NOTE_LENGTH) {
    errors.push(`note must not exceed ${MAX_NOTE_LENGTH} characters.`);
  }
  errors.push(...textFilter.checkFreeText(note, 'note').errors);

  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: {
      decision,
      reason: decision === 'reject' ? reason : null,
      note: note || null,
    },
  };
}

module.exports = {
  VERIFICATION_STATUSES,
  REJECTION_REASONS,
  MAX_NOTE_LENGTH,
  assessRideRisk,
  isPendingReview,
  validateVerificationDecision,
};
