'use strict';

/**
 * VeloFox pricing model.
 *
 * Money is stored in integer cents so revenue aggregation never drifts on
 * floating point. The canonical booking shape is:
 *
 *   pricing: {
 *     mode: 'point_to_point' | 'hourly',
 *     baseRateCents: number,   // flat fare, or per-hour rate
 *     hours: number | null,    // required for hourly
 *     gratuityCents: number,
 *     depositCents: number,
 *     fareCents: number,       // derived: base or base * hours
 *     totalCents: number,      // derived: fare + gratuity
 *   }
 *
 * Derived fields are always recomputed server-side; client input is ignored.
 */

const BILLING_MODES = ['point_to_point', 'hourly'];

// Default point-to-point fares used when a booking arrives without a quote.
const VEHICLE_BASE_RATES_CENTS = {
  sedan: 9500,
  suv: 12500,
  sprinter: 15500,
  limousine: 21000,
};
const DEFAULT_GRATUITY_RATE = 0.18;
const DEFAULT_HOURLY_RATE_CENTS = 18500;
const DEFAULT_HOURLY_MINIMUM = 2;

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function derive(pricing) {
  const hours = pricing.mode === 'hourly' ? pricing.hours : null;
  const fareCents = pricing.mode === 'hourly'
    ? Math.round(pricing.baseRateCents * (hours || 0))
    : pricing.baseRateCents;

  return {
    ...pricing,
    hours,
    fareCents,
    totalCents: fareCents + pricing.gratuityCents,
  };
}

function defaultPricing(vehicleType) {
  const baseRateCents = VEHICLE_BASE_RATES_CENTS[vehicleType] ?? VEHICLE_BASE_RATES_CENTS.sedan;
  return derive({
    mode: 'point_to_point',
    baseRateCents,
    hours: null,
    gratuityCents: Math.round(baseRateCents * DEFAULT_GRATUITY_RATE),
    depositCents: 0,
  });
}

function defaultHourlyPricing(hours = DEFAULT_HOURLY_MINIMUM) {
  const baseRateCents = DEFAULT_HOURLY_RATE_CENTS;
  return derive({
    mode: 'hourly',
    baseRateCents,
    hours,
    gratuityCents: Math.round(baseRateCents * hours * DEFAULT_GRATUITY_RATE),
    depositCents: 0,
  });
}

/**
 * Validates a client-supplied pricing object.
 * Returns { errors, value } where `value` is safe to persist.
 */
function normalizePricing(input) {
  const errors = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['pricing must be a JSON object.'], value: null };
  }

  const mode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : input.mode;
  if (!BILLING_MODES.includes(mode)) {
    errors.push(`pricing.mode must be one of: ${BILLING_MODES.join(', ')}.`);
  }

  const baseRateCents = input.baseRateCents;
  if (!isIntegerInRange(baseRateCents, 0, 50_000_000)) {
    errors.push('pricing.baseRateCents must be an integer between 0 and 50000000.');
  }

  let hours = null;
  if (mode === 'hourly') {
    const rawHours = Number(input.hours);
    if (!Number.isFinite(rawHours) || rawHours < 0.5 || rawHours > 24) {
      errors.push('pricing.hours must be a number between 0.5 and 24 for hourly charters.');
    } else {
      hours = Math.round(rawHours * 100) / 100;
    }
  }

  const gratuityCents = input.gratuityCents == null ? 0 : input.gratuityCents;
  if (!isIntegerInRange(gratuityCents, 0, 10_000_000)) {
    errors.push('pricing.gratuityCents must be an integer between 0 and 10000000.');
  }

  const depositCents = input.depositCents == null ? 0 : input.depositCents;
  if (!isIntegerInRange(depositCents, 0, 50_000_000)) {
    errors.push('pricing.depositCents must be an integer between 0 and 50000000.');
  }

  if (errors.length > 0) return { errors, value: null };

  return {
    errors,
    value: derive({ mode, baseRateCents, hours, gratuityCents, depositCents }),
  };
}

/** Legacy/partial bookings always expose a total to the dashboard. */
function ensurePricing(booking) {
  if (booking && booking.pricing && Number.isInteger(booking.pricing.totalCents)) {
    return booking.pricing;
  }
  return defaultPricing(booking && booking.vehicleType);
}

function formatUsd(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format((Number(cents) || 0) / 100);
}

module.exports = {
  BILLING_MODES,
  VEHICLE_BASE_RATES_CENTS,
  DEFAULT_GRATUITY_RATE,
  defaultPricing,
  defaultHourlyPricing,
  normalizePricing,
  ensurePricing,
  derive,
  formatUsd,
};
