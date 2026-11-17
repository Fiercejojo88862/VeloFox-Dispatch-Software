'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const MAX_PASSENGERS = 14;
const MAX_TEXT_LENGTH = 200;
const MAX_DRIVER_ID_LENGTH = 50;
const MAX_LUGGAGE_NOTES_LENGTH = 500;

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

app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------- helpers ------------------------------- */

function isNonEmptyString(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= maxLength;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

app.get('/api/bookings', (req, res) => {
  res.json(bookings);
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
  const booking = {
    id: crypto.randomUUID(),
    ...value,
    status: 'pending',
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

  const allowedFields = ['status', 'assignedVehicle', 'driverId', 'luggageNotes', 'driverLocation'];
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
  app.listen(PORT, () => {
    console.log(`VeloFox Dispatch API listening on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  testables: {
    bookings,
    canTransitionStatus,
    driverTelemetry,
    getDriver,
    getDriverManifest,
    normalizeDriverId,
    recordDriverTelemetry,
    validateBooking,
    validateDriverLocation,
  },
};
