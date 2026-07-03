'use strict';

const repo = require('../db/repo');
const time = require('./time');
const state = require('./state');
const warmup = require('./warmup');
const fire = require('./fire');
const log = require('../logger');
const config = require('../config');
const endpoints = require('../kooroo/endpoints.json');
const { KoorooClient } = require('../kooroo/client');

// Allowed courts (C-numbers the user picks; mapped to API court_ids).
const ALLOWED_COURTS = ['4', '5', '6']; // C4, C5, C6
const COURT_TO_API = { '4': '5', '5': '6', '6': '7' };
const API_TO_COURT = { '5': '4', '6': '5', '7': '6' };

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

function normalize(rec) {
  const courts = rec.courts && rec.courts.length ? rec.courts : [rec.court_pref];
  // ensure court_pref is first in the fallback list
  const unique = [rec.court_pref, ...courts.filter(c => c !== rec.court_pref)];
  return { ...rec, courts: unique };
}

function present(r) {
  if (!r) return null;
  return { ...r, courts: JSON.parse(r.courts || '[]') };
}

function add(input) {
  const rec = normalize(input);
  validate(rec);
  // Compute the first target slot. The pattern is "next <day> at <time>".
  // The very next occurrence is always 0-7 days away, so it's always inside
  // the 7-day booking window → action = 'book_now'. The subsequent chain
  // (chainToNextWeek) sets the next fire to the slot we just booked (release
  // for the next slot = this slot's time).
  const firstOccurrenceUtc = time.nextWeekdayAt(rec.day_of_week, rec.time, { after: Date.now() });
  const action = 'book_now';
  // Fire immediately; the chain will set next_fire_at to first_occurrence + 7d after.
  const nextFireAt = new Date(firstOccurrenceUtc).toISOString();
  const created = repo.recurring.create({ ...rec, first_occurrence_action: action, next_fire_at: nextFireAt });
  log.info('recurring.add', { id: created.id, action, firstOccurrenceUtc });
  return present(created);
}

function update(id, fields) {
  const cur = repo.recurring.get(id);
  if (!cur) throw new Error('not found');
  const merged = normalize({ ...cur, ...fields, courts: fields.courts || JSON.parse(cur.courts || '[]') });
  validate(merged);
  const updated = repo.recurring.update(id, merged);
  if (fields.day_of_week !== undefined || fields.time !== undefined || fields.court_pref !== undefined || fields.courts !== undefined) {
    // re-anchor to the next occurrence
    const firstOccurrenceUtc = time.nextWeekdayAt(updated.day_of_week, updated.time, { after: Date.now() });
    repo.recurring.update(id, { first_occurrence_action: 'book_now', next_fire_at: new Date(firstOccurrenceUtc).toISOString() });
  }
  return present(repo.recurring.get(id));
}

function remove(id) {
  return repo.recurring.remove(id);
}

function list(opts) {
  return repo.recurring.list(opts).map(present);
}

function get(id) {
  return present(repo.recurring.get(id));
}

// After a fire at slot T (we just booked slot T), the next slot is T+7d.
// The release for T+7d is T. So the next fire should be AT T (= the slot
// we just booked, which becomes available again a week later). We track the
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
    // Reconstruct the UTC slot time from the last fired slot (sydneyWallToUtc)
    const slotUtc = time.sydneyWallToUtc(lastFire.date, lastFire.time);
    nextFireMs = slotUtc + 7 * 86_400_000;
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

module.exports = { add, update, remove, list, get, present, validate, normalize, chainToNextWeek, bookNow, ALLOWED_COURTS, COURT_TO_API, API_TO_COURT };
// backward-compat alias
const _origFireNow = module.exports.bookNow;
if (!module.exports.fireNow) module.exports.fireNow = _origFireNow;
