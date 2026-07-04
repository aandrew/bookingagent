'use strict';

const repo = require('../db/repo');

const ALLOWED_COURTS = ['4', '5', '6'];

function findConflictingCourts({ dayOfWeek, time, excludeId = null }) {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return [];
  if (!/^\d{2}:\d{2}$/.test(String(time || ''))) return [];
  const rows = repo.recurring.list({ enabled: true });
  const conflicts = [];
  for (const r of rows) {
    if (excludeId != null && r.id === excludeId) continue;
    if (r.day_of_week !== dayOfWeek) continue;
    if (r.time !== time) continue;
    // Rows that have no_courts_available are NOT actually occupying a court.
    if (r.last_error_category === 'no_courts_available') continue;
    if (!ALLOWED_COURTS.includes(r.court_pref)) continue;
    if (conflicts.includes(r.court_pref)) continue;
    conflicts.push(r.court_pref);
  }
  return conflicts;
}

function allocateCourt(preferredCourt, conflicts) {
  if (!ALLOWED_COURTS.includes(String(preferredCourt))) {
    return { court: null, no_courts_available: true };
  }
  if (!conflicts.includes(String(preferredCourt))) {
    return { court: String(preferredCourt), no_courts_available: false, auto_allocated: false };
  }
  for (const c of ALLOWED_COURTS) {
    if (!conflicts.includes(c)) {
      return { court: c, no_courts_available: false, auto_allocated: true, original_court: String(preferredCourt) };
    }
  }
  return { court: null, no_courts_available: true };
}

function resolveForRecurring({ dayOfWeek, time, courtPref, excludeId = null }) {
  const conflicts = findConflictingCourts({ dayOfWeek, time, excludeId });
  return allocateCourt(courtPref, conflicts);
}

module.exports = { ALLOWED_COURTS, findConflictingCourts, allocateCourt, resolveForRecurring };
