'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const MAX_PASSENGERS = 14;
const MAX_TEXT_LENGTH = 200;

const VEHICLE_TYPES = ['sedan', 'suv', 'sprinter', 'limousine'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'assigned', 'completed', 'cancelled'];

// Temporary storage until PostgreSQL is wired up. Lives only as long as the process.
const bookings = [];

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

  return {
    errors,
    value: {
      pickupLocation: pickupLocation.trim(),
      dropoffLocation: dropoffLocation.trim(),
      pickupDateTime: pickupDateTime.trim(),
      vehicleType,
      passengerCount,
    },
  };
}

function findBookingIndex(id) {
  return bookings.findIndex((booking) => booking.id === id);
}

/* -------------------------------- routes -------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'VeloFox Dispatch API is running' });
});

app.get('/api/bookings', (req, res) => {
  res.json(bookings);
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
    assignedVehicle: null,
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

  const allowedFields = ['status', 'assignedVehicle'];
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
    } else {
      changes.status = status;
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

  const updated = { ...bookings[index], ...changes, updatedAt: new Date().toISOString() };
  bookings[index] = updated;

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

app.listen(PORT, () => {
  console.log(`VeloFox Dispatch API listening on http://localhost:${PORT}`);
});
