'use strict';

/**
 * Pure scheduling helpers used by the dispatch desk. Keeping these separate
 * from Express makes the conflict rules easy to test and reuse.
 */

const DEFAULT_SERVICE_MINUTES = 90;
const TURNAROUND_MINUTES = 30;
const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'assigned', 'en_route', 'arrived', 'passenger_aboard']);

function serviceMinutes(booking) {
  const minutes = Number(booking?.pricing?.serviceMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  return DEFAULT_SERVICE_MINUTES;
}

function serviceWindow(booking) {
  const start = Date.parse(booking?.pickupDateTime);
  if (!Number.isFinite(start)) return null;
  const duration = serviceMinutes(booking) * 60_000;
  return { start, end: start + duration + TURNAROUND_MINUTES * 60_000 };
}

function windowsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function minutesUntilPickup(booking, now = Date.now()) {
  const start = Date.parse(booking?.pickupDateTime);
  if (!Number.isFinite(start)) return null;
  return Math.round((start - now) / 60_000);
}

/**
 * Find open rides that would clash with the proposed driver/vehicle assignment.
 * `changes` may contain `driverId`, `assignedVehicle` and `excludeId`.
 */
function findConflicts(bookings, candidate, changes = {}) {
  const candidateWindow = serviceWindow(candidate);
  if (!candidateWindow) return [];

  const driverId = changes.driverId !== undefined ? changes.driverId : candidate.driverId;
  const vehicle = changes.assignedVehicle !== undefined ? changes.assignedVehicle : candidate.assignedVehicle;
  const excludeId = changes.excludeId || candidate.id;

  return bookings.filter((booking) => {
    if (!booking || booking.id === excludeId || !ACTIVE_STATUSES.has(booking.status)) return false;
    const sameDriver = driverId && booking.driverId === driverId;
    const sameVehicle = vehicle && booking.assignedVehicle === vehicle;
    if (!sameDriver && !sameVehicle) return false;
    const window = serviceWindow(booking);
    return Boolean(window && windowsOverlap(candidateWindow, window));
  });
}

module.exports = {
  DEFAULT_SERVICE_MINUTES,
  TURNAROUND_MINUTES,
  serviceMinutes,
  serviceWindow,
  windowsOverlap,
  minutesUntilPickup,
  findConflicts,
};
