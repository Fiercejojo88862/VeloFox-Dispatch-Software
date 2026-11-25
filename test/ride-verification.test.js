'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const verification = require('../lib/ride-verification');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function bookingFixture(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    clientName: 'Jordan Hayes',
    clientEmail: 'jordan@example.com',
    clientPhone: '+1 212 555 0100',
    pickupLocation: '30 West 60th Street, New York',
    dropoffLocation: 'Newark Liberty International Airport',
    pickupDateTime: '2026-12-15T18:00:00Z',
    status: 'pending',
    verificationStatus: 'unreviewed',
    ...overrides,
  };
}

const NOW = Date.parse('2026-11-24T12:00:00Z');

test('clean authenticated request has no risk signals', () => {
  const flags = verification.assessRideRisk(bookingFixture(), [], { now: NOW, authenticated: true });
  assert.deepEqual(flags, []);
});

test('guest request with a throwaway email, no phone and short notice is flagged', () => {
  const flags = verification.assessRideRisk(bookingFixture({
    clientEmail: 'ride123@mailinator.com',
    clientPhone: null,
    pickupDateTime: '2026-11-24T13:00:00Z',
  }), [], { now: NOW, authenticated: false });
  const codes = flags.map((flag) => flag.code);
  assert.ok(codes.includes('disposable_email'));
  assert.ok(codes.includes('missing_phone'));
  assert.ok(codes.includes('short_notice'));
  assert.ok(codes.includes('anonymous_request'));
  assert.equal(flags[0].severity, 'high');
  assert.ok(flags.every((flag) => flag.label && flag.detail));
});

test('same client and route at the same time is flagged as a duplicate', () => {
  const current = bookingFixture({ clientEmail: 'DUPLICATE@example.com ' });
  const previous = bookingFixture({
    id: '22222222-2222-4222-8222-222222222222',
    clientEmail: 'duplicate@example.com',
  });
  const flags = verification.assessRideRisk(current, [previous], { now: NOW, authenticated: true });
  assert.ok(flags.some((flag) => flag.code === 'duplicate_request' && flag.severity === 'high'));
});

test('isPendingReview only matches unreviewed pending rides', () => {
  assert.equal(verification.isPendingReview(bookingFixture()), true);
  assert.equal(verification.isPendingReview(bookingFixture({ verificationStatus: 'verified' })), false);
  assert.equal(verification.isPendingReview(bookingFixture({ status: 'confirmed' })), false);
});

test('decision validation accepts, rejects and explains why', () => {
  const accepted = verification.validateVerificationDecision({ decision: ' ACCEPT ' });
  assert.deepEqual(accepted.value, { decision: 'accept', reason: null, note: null });
  assert.deepEqual(accepted.errors, []);

  const rejected = verification.validateVerificationDecision({
    decision: 'reject',
    reason: 'fake_request',
    note: 'Client asked for a ride to nowhere.',
  });
  assert.equal(rejected.value.reason, 'fake_request');
  assert.equal(rejected.value.note, 'Client asked for a ride to nowhere.');

  assert.match(
    verification.validateVerificationDecision({ decision: 'reject' }).errors.join(' '),
    /reason must be one of/
  );
  assert.match(
    verification.validateVerificationDecision({ decision: 'maybe' }).errors.join(' '),
    /decision must be either/
  );
  assert.match(
    verification.validateVerificationDecision({ decision: 'reject', reason: 'other', note: 'x'.repeat(501) }).errors.join(' '),
    /note must not exceed/
  );
  assert.match(
    verification.validateVerificationDecision({ decision: 'reject', reason: 'other', note: 'contact me@example.com' }).errors.join(' '),
    /note must not contain/
  );
});

test('database persists verification decisions and a fake-ride cancellation reason', () => {
  const schema = read('schema.sql');
  assert.match(schema, /verification_status text NOT NULL DEFAULT 'unreviewed'/);
  assert.match(schema, /verified_by varchar\(254\)/);
  assert.match(schema, /verified_at timestamptz/);
  assert.match(schema, /verification_note text/);
  assert.match(schema, /risk_flags jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(schema, /'unreviewed', 'verified', 'rejected'/);
  assert.match(schema, /'no_show', 'suspected_fake'/);
  assert.match(schema, /bookings_verification_status_idx/);

  assert.match(read('lib', 'db.js'), /schema-v9-ride-verification/);

  const repo = read('lib', 'repository.js');
  assert.match(repo, /verification_status, verified_by, verified_at, verification_note, risk_flags/);
  assert.match(repo, /verificationStatus: row\.verification_status/);
  assert.match(repo, /riskFlags: parseRiskFlags\(row\.risk_flags\)/);
  assert.match(repo, /push\('verification_status', changes\.verificationStatus\)/);
});

test('server gates pending rides behind a dispatcher-only review endpoint', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/lib\/ride-verification'\)/);
  assert.match(server, /app\.post\('\/api\/bookings\/:id\/verification', requireApiRole\('dispatcher'\)/);
  assert.match(server, /booking\.verificationStatus !== 'unreviewed'/);
  assert.match(server, /booking\.status !== 'pending'/);
  assert.match(server, /cancellationReason = 'suspected_fake'/);
  assert.match(server, /audit\(req, accepted \? 'booking\.verified' : 'booking\.rejected'/);
  assert.match(server, /sendClientRideEmail\(updated, accepted \? 'verified' : 'verification_rejected'\)/);
  assert.match(server, /Review this ride before dispatching it/);
  assert.match(server, /riskFlags = rideVerification\.assessRideRisk/);
});

test('dashboard exposes a review queue with Accept and Reject actions', () => {
  const dash = read('public', 'dashboard.html');
  assert.match(dash, /data-tab="review"/);
  assert.match(dash, /id="review-count"/);
  assert.match(dash, /id="review-reject-modal"/);
  assert.match(dash, /id="review-reject-reason"/);
  assert.match(dash, /Accept ride \$\{booking\.id\.slice\(0, 8\)\} as legitimate/);
  assert.match(dash, /Reject ride \$\{booking\.id\.slice\(0, 8\)\} as a fake request/);
  assert.match(dash, /\$\{API_URL\}\/\$\{encodeURIComponent\(id\)\}\/verification/);
  assert.match(dash, /function makeVerificationBadge\(booking\)/);
  assert.match(dash, /bookingsTab === 'review'/);
  assert.match(dash, /Ride needs verification/);
  assert.match(dash, /Verification', 'Verified by', 'Risk signals'/);
});
