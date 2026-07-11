'use strict';

const repo = require('../db/repo');
const time = require('./time');
const state = require('./state');
const warmup = require('./warmup');
const fire = require('./fire');
const courtAllocator = require('./courtAllocator');
const log = require('../logger');
const bus = require('./bus');
const EV = require('./bus-events');
const config = require('../config');
const endpoints = require('../kooroo/endpoints.json');
const { KoorooClient } = require('../kooroo/client');
const fmt = require('../lib/format');

// Allowed courts (C-numbers the user picks; mapped to API court_ids).
const ALLOWED_COURTS = courtAllocator.ALLOWED_COURTS; // ['4','5','6']
const COURT_TO_API = { '4': '5', '5': '6', '6': '7' };
const API_TO_COURT = { '5': '4', '6': '5', '7': '6' };

// Build the fallback order for a given preferred court and a toggle.
// When fallback is on, the order is: preferred, then ascending 4 → 5 → 6 (skipping
// the preferred). When off, just the preferred.
function computeFallbackOrder(courtPref, fallbackEnabled) {
  return fmt.computeFallbackOrder(courtPref, !!fallbackEnabled);
}

function validate(rec) {
  if (!ALLOWED_COURTS.includes(rec.court_pref)) {
    throw new Error(`court_pref must be one of ${ALLOWED_COURTS.join(', ')}`);
  }
  if (typeof rec.day_of_week !== 'number' || rec.day_of_week < 0 || rec.day_of_week > 6) {
    throw new Error('day_of_week must be 0-6');
  }
  if (!/^\d{2}:\d{2}$/.test(rec.time)) throw new Error('time must be HH:MM');
  if (rec.courts && !Array.isArray(rec.courts)) throw new Error('courts must be an array');
  if (rec.courts) for (const c of rec.courts) {
    if (!ALLOWED_COURTS.includes(c)) throw new Error(`courts must be subset of ${ALLOWED_COURTS.join(', ')}`);
  }
}

// v3 normalize:
//   - If `fallback_enabled` is provided, use it to compute the courts array
//   - Else if `courts` is provided (legacy form), keep it but ensure preferred is first
//   - Else default to [preferred] (no fallback)
function normalize(rec) {
  const out = { ...rec };
  if (typeof rec.fallback_enabled === 'boolean') {
    out.courts = computeFallbackOrder(out.court_pref, rec.fallback_enabled);
  } else if (rec.courts && rec.courts.length) {
    const unique = [out.court_pref, ...rec.courts.filter(c => c !== out.court_pref)];
    out.courts = unique;
  } else {
    out.courts = [out.court_pref];
  }
  // Auto-generate label if not provided
  if (!out.label) {
    out.label = fmt.buildRecurringLabel({
      day_of_week: out.day_of_week,
      time: out.time,
      court_pref: out.court_pref,
    });
  }
  return out;
}

function present(r) {
  if (!r) return null;
  return { ...r, courts: JSON.parse(r.courts || '[]') };
}

function add(input) {
  // Resolve court auto-allocation BEFORE normalize (so fallback order reflects the chosen court).
  const dayOfWeek = parseInt(input.day_of_week, 10);
  const timeStr = String(input.time || '');
  const requestedCourt = input.court_pref;
  const alloc = courtAllocator.resolveForRecurring({ dayOfWeek, time: timeStr, courtPref: requestedCourt, excludeId: null });
  // If no_courts_available, we still want to create the row (so the user sees the error)
  // but we keep the requested court_pref so validate() passes and the row has a real value.
  const courtPref = alloc.no_courts_available
    ? (ALLOWED_COURTS.includes(String(requestedCourt)) ? String(requestedCourt) : ALLOWED_COURTS[0])
    : alloc.court;
  const rec = normalize({ ...input, court_pref: courtPref });
  validate(rec);

  // v3.4: compute the first fire time from the picked slot date.
  //
  // The schedule is "every 7 days from the picked date". The first fire is
  // 7 days before the picked slot — i.e. the opening moment of the Koorora
  // 7-day booking window. The chain (chainToNextWeek) then sets each
  // subsequent fire to the just-booked slot's time (which IS the opening
  // of the next slot, since slots are 7 days apart).
  //
  // If first_slot_date is provided, derive the first fire from it (this is
  // the date the user picked on the form). Otherwise, fall back to
  // nextWeekdayAt — the next occurrence of day_of_week+time after now.
  let firstFireUtc;
  if (rec.first_slot_date && /^\d{4}-\d{2}-\d{2}$/.test(rec.first_slot_date)) {
    firstFireUtc = time.sydneyWallToUtc(rec.first_slot_date, rec.time) - 7 * 86_400_000;
    // If the opening is in the past (the picked date is within 7 days and
    // the opening moment has already passed), fall back to the picked
    // date itself — i.e. the closing moment. The slot can still be
    // booked up until the slot time.
    if (firstFireUtc <= Date.now()) {
      firstFireUtc = time.sydneyWallToUtc(rec.first_slot_date, rec.time);
    }
  } else {
    firstFireUtc = time.nextWeekdayAt(rec.day_of_week, rec.time, { after: Date.now() });
  }
  const action = 'book_now';
  const nextFireAt = new Date(firstFireUtc).toISOString();
  const createFields = { ...rec, first_occurrence_action: action, next_fire_at: nextFireAt };
  const created = repo.recurring.create(createFields);
  if (alloc.no_courts_available) {
    // Set the error fields via setLastResult (the canonical way to mark a
    // recurring row with a fire-time result).
    repo.recurring.setLastResult(created.id, {
      status: 'failed',
      msg: 'No courts available at this time slot — all 3 courts are taken by other recurring bookings.',
      category: 'no_courts_available',
    });
  }
  log.info('recurring.add', {
    id: created.id, action, firstFireUtc, firstSlotDate: rec.first_slot_date || null, label: created.label,
    fallback_enabled: !!rec.fallback_enabled,
    court_auto_allocated: alloc.auto_allocated || false,
    original_court: alloc.original_court || null,
    no_courts_available: alloc.no_courts_available || false,
  });
  const presented = present(repo.recurring.get(created.id));
  if (alloc.auto_allocated) {
    presented.court_auto_allocated = true;
    presented.original_court_pref = alloc.original_court;
  }
  if (alloc.no_courts_available) {
    presented.no_courts_available = true;
  }
  // v4: emit recurring_created so the dashboard can prepend the row.
  try { bus.emit(EV.RECURRING_CREATED, presented); } catch (e) { log.warn('bus.emit.failed', { event: EV.RECURRING_CREATED, error: e.message }); }
  // v4: if the row was created in an error state (no_courts_available),
  // emit error_appeared so the error banner shows up immediately.
  if (alloc.no_courts_available) {
    try { bus.emit(EV.ERROR_APPEARED, presented); } catch (e) { log.warn('bus.emit.failed', { event: EV.ERROR_APPEARED, error: e.message }); }
  }
  return presented;
}

function update(id, fields) {
  const cur = repo.recurring.get(id);
  if (!cur) throw new Error('not found');
  const merged = { ...cur, ...fields };
  // Re-run court auto-allocation if any slot-defining field changes
  const slotChanged = fields.day_of_week !== undefined || fields.time !== undefined || fields.court_pref !== undefined;
  if (slotChanged) {
    const alloc = courtAllocator.resolveForRecurring({
      dayOfWeek: merged.day_of_week,
      time: merged.time,
      courtPref: merged.court_pref,
      excludeId: id,
    });
    if (alloc.no_courts_available) {
      // Keep the prior court_pref to preserve user intent; mark failed.
      merged.court_pref = cur.court_pref;
    } else {
      merged.court_pref = alloc.court;
    }
  }
  const normalized = normalize({
    ...merged,
    courts: fields.courts || (typeof fields.fallback_enabled === 'boolean' ? undefined : JSON.parse(cur.courts || '[]')),
  });
  validate(normalized);
  const updated = repo.recurring.update(id, normalized);
  if (slotChanged) {
    // Mark the no_courts_available state (or clear it if the slot is now clear).
    if (courtAllocator.findConflictingCourts({ dayOfWeek: updated.day_of_week, time: updated.time, excludeId: id }).length >= 3) {
      repo.recurring.setLastResult(id, {
        status: 'failed',
        msg: 'No courts available at this time slot — all 3 courts are taken by other recurring bookings.',
        category: 'no_courts_available',
      });
    } else if (cur.last_error_category === 'no_courts_available') {
      // Slot is now clear — clear the error so it doesn't keep showing.
      repo.recurring.setLastResult(id, { status: null, msg: null, category: null });
    }
  }
  // Re-anchor to the next occurrence if the schedule changed OR the courts changed
  if (fields.day_of_week !== undefined || fields.time !== undefined || fields.court_pref !== undefined || fields.courts !== undefined || fields.fallback_enabled !== undefined) {
    const firstOccurrenceUtc = time.nextWeekdayAt(updated.day_of_week, updated.time, { after: Date.now() });
    repo.recurring.update(id, { first_occurrence_action: 'book_now', next_fire_at: new Date(firstOccurrenceUtc).toISOString() });
  }
  const finalRecurring = present(repo.recurring.get(id));
  // v4: emit recurring_updated so the dashboard reflects the new
  // court / time / next_fire_at. Wrap in try/catch.
  try { bus.emit(EV.RECURRING_UPDATED, finalRecurring); } catch (e) { log.warn('bus.emit.failed', { event: EV.RECURRING_UPDATED, error: e.message }); }
  return finalRecurring;
}

function remove(id) {
  return repo.recurring.remove(id);
}

// v4: dismiss an error — wraps repo.recurring.dismissError and emits
// the corresponding SSE event so the error banner disappears live.
function dismissError(id) {
  const r = repo.recurring.dismissError(id);
  try { bus.emit(EV.ERROR_DISMISSED, { id }); } catch (e) { log.warn('bus.emit.failed', { event: EV.ERROR_DISMISSED, error: e.message }); }
  return r;
}

function list(opts) {
  return repo.recurring.list(opts).map(present);
}

function get(id) {
  return present(repo.recurring.get(id));
}

// v3.4 chain: after a fire that books slot T, the next fire is at T
// (the opening of the next slot, which is 7 days after T). We track the
// last-fired slot via the most recent fire_event so the chain survives
// restarts and skipped fires.
function chainToNextWeek(recurringId) {
  const cur = repo.recurring.get(recurringId);
  if (!cur) return null;
  // Find the most recent successful (or attempted) fire's slot
  const lastFire = repo.fireEvents.list({ recurringId, limit: 5 })
    .find(e => e.date && e.time);
  let nextFireMs;
  if (lastFire) {
    // Reconstruct the UTC time of the just-booked slot from its date+time
    // in Sydney. The next fire happens AT that time — the opening of the
    // next slot (T+7d). The next slot itself is T+7d, which slotForFire
    // computes from the fire time.
    const slotUtc = time.sydneyWallToUtc(lastFire.date, lastFire.time);
    nextFireMs = slotUtc;
  } else {
    // Fall back: next weekday from now
    const nextTarget = time.nextWeekdayAt(cur.day_of_week, cur.time, { after: Date.now() + 60_000 });
    nextFireMs = nextTarget;
  }
  repo.recurring.update(recurringId, { next_fire_at: new Date(nextFireMs).toISOString() });
  log.info('recurring.chain', { id: recurringId, nextFireMs });
  return { nextFireMs };
}

// One-off manual booking (used by the dashboard "Book now" button).
async function bookNow(recurringId, opts = {}) {
  const r = repo.recurring.get(recurringId);
  if (!r) throw new Error('not found');
  const courts = JSON.parse(r.courts || '[]');
  const targetUtc = time.nextWeekdayAt(r.day_of_week, r.time, { after: Date.now() });
  const dateStr = time.sydneyDateString(targetUtc);
  const from = require('../kooroo/client').timeToSlot(r.time);
  const to = from + Math.max(1, Math.round((r.duration_mins || 60) / 30));
  const client = await warmup.ensureFreshSession(r.account_id);
  const isImmediate = targetUtc - 7 * 24 * 3600_000 <= Date.now();
  if (isImmediate) {
    return fire.fireImmediate({
      recurring: { ...r, courts },
      client,
      primed: { date: dateStr, from, to, courtId: COURT_TO_API[r.court_pref] },
    });
  }
  // scheduled: warm + wait
  const primed = await warmup.warm(r.account_id, { date: dateStr, from, to, courtId: COURT_TO_API[r.court_pref] });
  await time.waitUntilExact(targetUtc - 7 * 24 * 3600_000);
  const result = await fire.fireScheduled({ recurring: { ...r, courts }, targetMs: targetUtc - 7 * 24 * 3600_000, client, primed });
  await fire.recordAndPersistScheduledFire({ recurring: { ...r, courts }, targetMs: targetUtc - 7 * 24 * 3600_000, client, primed, result });
  return { category: result.category, result };
}

module.exports = { add, update, remove, list, get, present, validate, normalize, chainToNextWeek, bookNow, dismissError, computeFallbackOrder, ALLOWED_COURTS, COURT_TO_API, API_TO_COURT };
// backward-compat alias
const _origFireNow = module.exports.bookNow;
if (!module.exports.fireNow) module.exports.fireNow = _origFireNow;
