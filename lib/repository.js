'use strict';

/**
 * PostgreSQL repository: every query and row mapping the app needs.
 * The API keeps returning the same camelCase shapes the frontend already uses.
 */

const crypto = require('node:crypto');
const db = require('./db');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BOOKING_COLUMNS = `
  id, pickup_location, dropoff_location, pickup_datetime, vehicle_type,
  passenger_count, status, driver_id, assigned_vehicle, luggage_notes,
  beverage_request, special_requests, preferred_driver_id,
  client_email, client_name, client_phone, billing_mode, base_rate_cents, charter_hours,
  gratuity_cents, deposit_cents, fare_cents, total_cents, created_at, updated_at
`;

const ACCOUNT_SELECT = `
  SELECT a.id, a.role, a.display_name, a.email, a.password_salt, a.password_hash,
         a.created_at, a.disabled_at, d.reset_token, d.reset_token_expires, d.is_admin
  FROM accounts a
  LEFT JOIN dispatchers d ON d.account_id = a.id
`;

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    name: row.display_name,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    resetToken: row.reset_token || null,
    resetTokenExpires: row.reset_token_expires ? new Date(row.reset_token_expires).getTime() : null,
    isAdmin: Boolean(row.is_admin),
    disabledAt: iso(row.disabled_at),
    createdAt: iso(row.created_at),
  };
}

function rowToBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    pickupLocation: row.pickup_location,
    dropoffLocation: row.dropoff_location,
    pickupDateTime: iso(row.pickup_datetime),
    vehicleType: row.vehicle_type,
    passengerCount: row.passenger_count,
    status: row.status,
    driverId: row.driver_id,
    assignedVehicle: row.assigned_vehicle,
    luggageNotes: row.luggage_notes,
    beverageRequest: row.beverage_request,
    specialRequests: row.special_requests,
    preferredDriverId: row.preferred_driver_id,
    clientEmail: row.client_email,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    pricing: {
      mode: row.billing_mode,
      baseRateCents: row.base_rate_cents,
      hours: row.charter_hours == null ? null : Number(row.charter_hours),
      gratuityCents: row.gratuity_cents,
      depositCents: row.deposit_cents,
      fareCents: row.fare_cents,
      totalCents: row.total_cents,
    },
    driverLocation: null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToReview(row) {
  if (!row) return null;
  return {
    bookingId: row.booking_id,
    clientEmail: row.client_email,
    driverId: row.driver_id,
    rating: row.rating,
    feedback: row.feedback,
    updatedAt: iso(row.updated_at),
  };
}

/* ------------------------------- accounts ------------------------------- */

async function createAccount({ role, name, email, passwordSalt, passwordHash }) {
  return db.withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO accounts (role, display_name, email, password_salt, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [role, name, email, passwordSalt, passwordHash]
    );
    const accountId = inserted.rows[0].id;

    if (role === 'dispatcher') {
      await client.query('INSERT INTO dispatchers (account_id) VALUES ($1)', [accountId]);
    }

    const user = await client.query(`${ACCOUNT_SELECT} WHERE a.id = $1`, [accountId]);
    return rowToUser(user.rows[0]);
  });
}

async function findUser(role, email) {
  const result = await db.query(`${ACCOUNT_SELECT} WHERE a.role = $1 AND a.email = $2`, [role, email]);
  return rowToUser(result.rows[0]);
}

async function updatePassword(accountId, passwordSalt, passwordHash) {
  await db.query(
    'UPDATE accounts SET password_salt = $2, password_hash = $3, updated_at = now() WHERE id = $1',
    [accountId, passwordSalt, passwordHash]
  );
}

async function setResetToken(accountId, tokenHash, expiresAt) {
  await db.query(
    'UPDATE dispatchers SET reset_token = $2, reset_token_expires = $3 WHERE account_id = $1',
    [accountId, tokenHash, expiresAt]
  );
}

async function clearResetToken(accountId) {
  await db.query(
    'UPDATE dispatchers SET reset_token = NULL, reset_token_expires = NULL WHERE account_id = $1',
    [accountId]
  );
}

async function findDispatcherByResetToken(tokenHash) {
  const result = await db.query(
    `${ACCOUNT_SELECT} WHERE d.reset_token = $1 AND a.role = 'dispatcher'`,
    [tokenHash]
  );
  return rowToUser(result.rows[0]);
}

/* --------------------------- account administration --------------------------- */

const ADMIN_ACCOUNT_COLUMNS = `
  a.id, a.role, a.display_name, a.email, a.created_at, a.disabled_at, d.is_admin,
  (SELECT count(*)::int FROM sessions s WHERE s.account_id = a.id AND s.expires_at > now()) AS active_sessions
`;

function rowToAdminAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    name: row.display_name,
    email: row.email,
    isAdmin: Boolean(row.is_admin),
    disabled: Boolean(row.disabled_at),
    disabledAt: iso(row.disabled_at),
    activeSessions: Number(row.active_sessions || 0),
    createdAt: iso(row.created_at),
  };
}

async function listAccounts() {
  const result = await db.query(
    `SELECT ${ADMIN_ACCOUNT_COLUMNS}
     FROM accounts a
     LEFT JOIN dispatchers d ON d.account_id = a.id
     ORDER BY a.role ASC, a.created_at ASC`
  );
  return result.rows.map(rowToAdminAccount);
}

async function findAccountById(accountId) {
  if (!UUID_PATTERN.test(String(accountId || ''))) return null;
  const result = await db.query(
    `SELECT ${ADMIN_ACCOUNT_COLUMNS}
     FROM accounts a
     LEFT JOIN dispatchers d ON d.account_id = a.id
     WHERE a.id = $1`,
    [accountId]
  );
  return rowToAdminAccount(result.rows[0]);
}

async function setAccountDisabled(accountId, disabled) {
  await db.query(
    `UPDATE accounts
        SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
      WHERE id = $1`,
    [accountId, Boolean(disabled)]
  );
}

async function setDispatcherAdmin(accountId, isAdmin) {
  await db.query(
    `INSERT INTO dispatchers (account_id, is_admin) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET is_admin = EXCLUDED.is_admin`,
    [accountId, Boolean(isAdmin)]
  );
}

async function countActiveAdmins() {
  const result = await db.query(
    `SELECT count(*)::int AS n
       FROM dispatchers d
       JOIN accounts a ON a.id = d.account_id
      WHERE d.is_admin AND a.disabled_at IS NULL`
  );
  return result.rows[0].n;
}

async function renameAccount(accountId, name) {
  await db.query('UPDATE accounts SET display_name = $2, updated_at = now() WHERE id = $1', [accountId, name]);
}

async function updateEmail(accountId, email) {
  await db.query('UPDATE accounts SET email = $2, updated_at = now() WHERE id = $1', [accountId, email]);
}

/* ------------------------------- app settings ------------------------------- */

async function getSetting(key) {
  const result = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return result.rows[0] ? result.rows[0].value : null;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

/* --------------------------------- audit log -------------------------------- */

async function recordAudit({ actorId = null, actorEmail = null, action, target = null, detail = null }) {
  await db.query(
    `INSERT INTO audit_log (actor_account_id, actor_email, action, target, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, actorEmail, action, target, detail ? JSON.stringify(detail) : null]
  );
}

async function listAudit(limit = 50) {
  const result = await db.query(
    `SELECT id, actor_email, action, target, detail, created_at
       FROM audit_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    actorEmail: row.actor_email,
    action: row.action,
    target: row.target,
    detail: row.detail,
    createdAt: iso(row.created_at),
  }));
}

/* ------------------------------ sign-in codes ------------------------------ */

async function replaceLoginCode({ role, email, codeHash, codeSalt, expiresAt }) {
  return db.withTransaction(async (client) => {
    await client.query(
      `DELETE FROM login_codes
        WHERE expires_at <= now()
           OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day')`
    );
    await client.query('DELETE FROM login_codes WHERE role = $1 AND email = $2', [role, email]);
    const inserted = await client.query(
      `INSERT INTO login_codes (role, email, code_hash, code_salt, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [role, email, codeHash, codeSalt, expiresAt]
    );
    return inserted.rows[0].id;
  });
}

async function findActiveLoginCode(role, email) {
  const result = await db.query(
    `SELECT id, code_hash, code_salt, attempts, expires_at
       FROM login_codes
      WHERE role = $1 AND email = $2 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [role, email]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    codeHash: row.code_hash,
    codeSalt: row.code_salt,
    attempts: row.attempts,
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

async function incrementLoginCodeAttempts(codeId) {
  await db.query('UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1', [codeId]);
}

async function consumeLoginCode(codeId) {
  await db.query('UPDATE login_codes SET consumed_at = now() WHERE id = $1', [codeId]);
}

async function deleteLoginCodesFor(role, email) {
  await db.query('DELETE FROM login_codes WHERE role = $1 AND email = $2', [role, email]);
}

/* -------------------------------- sessions (admin) ------------------------------- */

async function listActiveSessions() {
  const result = await db.query(
    `SELECT s.token_hash, s.account_id, s.created_at, s.expires_at,
            a.email, a.role, a.display_name
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.expires_at > now()
      ORDER BY s.created_at DESC`
  );
  return result.rows.map((row) => ({
    id: row.token_hash,
    accountId: row.account_id,
    email: row.email,
    role: row.role,
    name: row.display_name,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  }));
}

/* ------------------------------- sessions ------------------------------- */

async function createSession(tokenHash, accountId, expiresAt) {
  // Opportunistic cleanup keeps the table small without a cron job.
  await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  await db.query(
    'INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash, accountId, expiresAt]
  );
}

async function findSessionUser(tokenHash) {
  const result = await db.query(
    `${ACCOUNT_SELECT}
     JOIN sessions s ON s.account_id = a.id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash]
  );
  return rowToUser(result.rows[0]);
}

async function deleteSession(tokenHash) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

async function deleteSessionsForAccount(accountId) {
  await db.query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
}

/* ------------------------------- bookings ------------------------------- */

async function listBookings() {
  const result = await db.query(`SELECT ${BOOKING_COLUMNS} FROM bookings ORDER BY created_at ASC`);
  return result.rows.map(rowToBooking);
}

async function listBookingsSince(sinceIso) {
  const result = sinceIso
    ? await db.query(
      `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE pickup_datetime >= $1 ORDER BY created_at ASC`,
      [sinceIso]
    )
    : await db.query(`SELECT ${BOOKING_COLUMNS} FROM bookings ORDER BY created_at ASC`);
  return result.rows.map(rowToBooking);
}

async function getBooking(id) {
  if (!UUID_PATTERN.test(String(id || ''))) return null;
  const result = await db.query(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [id]);
  return rowToBooking(result.rows[0]);
}

async function createBooking(booking) {
  const result = await db.query(
    `INSERT INTO bookings (
       pickup_location, dropoff_location, pickup_datetime, vehicle_type,
       passenger_count, status, driver_id, assigned_vehicle, luggage_notes,
       beverage_request, special_requests, preferred_driver_id,
       client_email, client_name, client_phone, billing_mode, base_rate_cents, charter_hours,
       gratuity_cents, deposit_cents, fare_cents, total_cents
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING ${BOOKING_COLUMNS}`,
    [
      booking.pickupLocation,
      booking.dropoffLocation,
      booking.pickupDateTime,
      booking.vehicleType,
      booking.passengerCount,
      booking.status || 'pending',
      booking.driverId || null,
      booking.assignedVehicle || null,
      booking.luggageNotes || null,
      booking.beverageRequest || null,
      booking.specialRequests || null,
      booking.preferredDriverId || null,
      booking.clientEmail || null,
      booking.clientName || null,
      booking.clientPhone || null,
      booking.pricing.mode,
      booking.pricing.baseRateCents,
      booking.pricing.hours,
      booking.pricing.gratuityCents,
      booking.pricing.depositCents,
      booking.pricing.fareCents,
      booking.pricing.totalCents,
    ]
  );
  return rowToBooking(result.rows[0]);
}

async function insertDemoBookings(rows) {
  return db.withTransaction(async (client) => {
    const inserted = [];
    for (const booking of rows) {
      const result = await client.query(
        `INSERT INTO bookings (
           pickup_location, dropoff_location, pickup_datetime, vehicle_type,
           passenger_count, status, driver_id, assigned_vehicle, luggage_notes,
           beverage_request, special_requests, preferred_driver_id,
           client_email, client_name, client_phone, billing_mode, base_rate_cents, charter_hours,
           gratuity_cents, deposit_cents, fare_cents, total_cents, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING ${BOOKING_COLUMNS}`,
        [
          booking.pickupLocation,
          booking.dropoffLocation,
          booking.pickupDateTime,
          booking.vehicleType,
          booking.passengerCount,
          booking.status,
          booking.driverId,
          booking.assignedVehicle,
          booking.luggageNotes,
          booking.beverageRequest || null,
          booking.specialRequests || null,
          booking.preferredDriverId || null,
          booking.clientEmail,
          booking.clientName,
          booking.clientPhone || null,
          booking.pricing.mode,
          booking.pricing.baseRateCents,
          booking.pricing.hours,
          booking.pricing.gratuityCents,
          booking.pricing.depositCents,
          booking.pricing.fareCents,
          booking.pricing.totalCents,
          booking.createdAt,
        ]
      );
      inserted.push(rowToBooking(result.rows[0]));
    }
    return inserted;
  });
}

async function updateBooking(id, changes) {
  if (!UUID_PATTERN.test(String(id || ''))) return null;

  const assignments = [];
  const values = [];
  const push = (column, value) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };

  if (Object.hasOwn(changes, 'status')) push('status', changes.status);
  if (Object.hasOwn(changes, 'driverId')) push('driver_id', changes.driverId);
  if (Object.hasOwn(changes, 'assignedVehicle')) push('assigned_vehicle', changes.assignedVehicle);
  if (Object.hasOwn(changes, 'luggageNotes')) push('luggage_notes', changes.luggageNotes);

  if (Object.hasOwn(changes, 'pricing')) {
    const quote = changes.pricing;
    push('billing_mode', quote.mode);
    push('base_rate_cents', quote.baseRateCents);
    push('charter_hours', quote.hours);
    push('gratuity_cents', quote.gratuityCents);
    push('deposit_cents', quote.depositCents);
    push('fare_cents', quote.fareCents);
    push('total_cents', quote.totalCents);
  }

  if (assignments.length === 0) return getBooking(id);

  values.push(id);
  const result = await db.query(
    `UPDATE bookings SET ${assignments.join(', ')}, updated_at = now()
     WHERE id = $${values.length}
     RETURNING ${BOOKING_COLUMNS}`,
    values
  );
  return rowToBooking(result.rows[0]);
}

async function listClientTrips(clientEmail) {
  const result = await db.query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings
     WHERE client_email = $1 ORDER BY pickup_datetime DESC`,
    [clientEmail]
  );
  return result.rows.map(rowToBooking);
}

async function listManifest(driverId) {
  const result = await db.query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings
     WHERE driver_id = $1 AND status NOT IN ('dropped_off', 'completed', 'cancelled')
     ORDER BY pickup_datetime ASC`,
    [driverId]
  );
  return result.rows.map(rowToBooking);
}

async function listActiveTrips() {
  const result = await db.query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings
     WHERE driver_id IS NOT NULL AND status NOT IN ('dropped_off', 'completed', 'cancelled')
     ORDER BY pickup_datetime ASC`
  );
  return result.rows.map(rowToBooking);
}

/* ------------------------------ telemetry ------------------------------ */

async function recordTelemetry({ driverId, bookingId, latitude, longitude, accuracy, heading, speed, recordedAt }) {
  const result = await db.query(
    `INSERT INTO driver_telemetry
       (driver_id, booking_id, latitude, longitude, accuracy, heading, speed, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [driverId, bookingId, latitude, longitude, accuracy, heading, speed, recordedAt]
  );
  return result.rows[0].id;
}

async function latestTelemetryByDriver() {
  const result = await db.query(
    `SELECT DISTINCT ON (driver_id)
       driver_id, booking_id, latitude, longitude, accuracy, heading, speed, recorded_at
     FROM driver_telemetry
     ORDER BY driver_id, recorded_at DESC, id DESC`
  );

  const map = new Map();
  result.rows.forEach((row) => {
    map.set(row.driver_id, {
      driverId: row.driver_id,
      bookingId: row.booking_id,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
      heading: row.heading == null ? null : Number(row.heading),
      speed: row.speed == null ? null : Number(row.speed),
      recordedAt: iso(row.recorded_at),
    });
  });
  return map;
}

async function countTelemetry() {
  const result = await db.query('SELECT count(*)::int AS total FROM driver_telemetry');
  return result.rows[0].total;
}

/* --------------------------- dispatch pings --------------------------- */

async function recordDispatchPings(driverIds) {
  if (!Array.isArray(driverIds) || driverIds.length === 0) return 0;
  const result = await db.query(
    'INSERT INTO dispatch_pings (driver_id) SELECT unnest($1::varchar[]) RETURNING id',
    [driverIds]
  );
  return result.rowCount;
}

async function latestDispatchPing(driverId) {
  const result = await db.query(
    `SELECT created_at FROM dispatch_pings
      WHERE driver_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [driverId]
  );
  return result.rows[0]?.created_at ? iso(result.rows[0].created_at) : null;
}

/* --------------------------- reviews / feedback --------------------------- */

async function upsertReview({ bookingId, clientEmail, driverId, rating, feedback }) {
  const result = await db.query(
    `INSERT INTO trip_reviews (booking_id, client_email, driver_id, rating, feedback)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (booking_id) DO UPDATE
       SET rating = EXCLUDED.rating,
           feedback = EXCLUDED.feedback,
           driver_id = EXCLUDED.driver_id,
           updated_at = now()
     RETURNING booking_id, client_email, driver_id, rating, feedback, updated_at`,
    [bookingId, clientEmail, driverId, rating, feedback]
  );
  return rowToReview(result.rows[0]);
}

async function listReviewsForClient(clientEmail) {
  const result = await db.query(
    'SELECT booking_id, client_email, driver_id, rating, feedback, updated_at FROM trip_reviews WHERE client_email = $1',
    [clientEmail]
  );
  const map = new Map();
  result.rows.forEach((row) => map.set(row.booking_id, rowToReview(row)));
  return map;
}

async function insertFeedback({ clientEmail, category, message }) {
  const result = await db.query(
    `INSERT INTO app_feedback (client_email, category, message)
     VALUES ($1,$2,$3) RETURNING id, created_at`,
    [clientEmail, category, message]
  );
  return { id: result.rows[0].id, createdAt: iso(result.rows[0].created_at) };
}

module.exports = {
  UUID_PATTERN,
  rowToUser,
  rowToBooking,
  createAccount,
  findUser,
  updatePassword,
  setResetToken,
  clearResetToken,
  findDispatcherByResetToken,
  listAccounts,
  findAccountById,
  setAccountDisabled,
  setDispatcherAdmin,
  countActiveAdmins,
  renameAccount,
  updateEmail,
  getSetting,
  setSetting,
  recordAudit,
  listAudit,
  replaceLoginCode,
  findActiveLoginCode,
  incrementLoginCodeAttempts,
  consumeLoginCode,
  deleteLoginCodesFor,
  listActiveSessions,
  createSession,
  findSessionUser,
  deleteSession,
  deleteSessionsForAccount,
  listBookings,
  listBookingsSince,
  getBooking,
  createBooking,
  insertDemoBookings,
  updateBooking,
  listClientTrips,
  listManifest,
  listActiveTrips,
  recordTelemetry,
  latestTelemetryByDriver,
  countTelemetry,
  recordDispatchPings,
  latestDispatchPing,
  upsertReview,
  listReviewsForClient,
  insertFeedback,
  hashToken: (token) => crypto.createHash('sha256').update(token).digest('hex'),
};
