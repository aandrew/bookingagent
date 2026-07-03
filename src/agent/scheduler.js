'use strict';

const repo = require('../db/repo');
const time = require('./time');
const state = require('./state');
const warmup = require('./warmup');
const fire = require('./fire');
const recurring = require('./recurring');
const log = require('../logger');
const { KoorooClient } = require('../kooroo/client');
const { timeToSlot, slotToTime } = require('../kooroo/client');

const timers = new Map(); // recurringId -> { warmTimer, fireTimer }
const SESSION_LEAD_MS = 7 * 24 * 3600_000;  // 7 days

function clearTimers(id) {
  const t = timers.get(id);
  if (!t) return;
  for (const k of ['warmTimer', 'fireTimer']) {
    if (t[k]) clearTimeout(t[k]);
  }
  timers.delete(id);
}

function nextFireUtcMs(rec) {
  if (!rec.next_fire_at) return null;
  return new Date(rec.next_fire_at).getTime();
}

// Returns the slot (date, from, to) we will book at `fireMs`. The "slot" is
// at fireMs itself (since each fire books a slot AT the fire time, by the
// pattern "every Wed 7pm, starting at the first Wed 7pm from now"). The
// release of the next slot is exactly the slot we just booked.
function slotForFire(rec, fireMs) {
  const dateStr = time.sydneyDateString(fireMs);
  const from = timeToSlot(rec.time);
  const to = from + Math.max(1, Math.round((rec.duration_mins || 60) / 30));
  return { date: dateStr, from, to };
}

async function prepareForFire(rec, fireMs) {
  const courts = JSON.parse(rec.courts || '[]');
  const pref = rec.court_pref;
  const apiPref = recurring.COURT_TO_API[pref];
  const slot = slotForFire(rec, fireMs);
  const primed = await warmup.warm(rec.account_id, {
    date: slot.date, from: slot.from, to: slot.to, courtId: apiPref,
  });
  return { courts, pref, apiPref, fireMs, slot, primed };
}

async function executeScheduledBooking(rec, fireMs) {
  log.info('scheduler.fire', { recurring: rec.id, label: rec.label, fireMs });
  let prepared;
  try {
    prepared = await prepareForFire(rec, fireMs);
  } catch (e) {
    log.error('scheduler.fire.prepare', { recurring: rec.id, error: e.message });
    repo.recurring.setLastResult(rec.id, { status: 'login_required', msg: e.message, category: 'technical_error' });
    state.transition(rec.account_id, state.STATES.LOGIN_REQUIRED, e.message);
    return;
  }
  const { courts, apiPref, fireMs: fm, slot, primed } = prepared;
  // Wait for the exact fire millisecond
  await time.waitUntilExact(fm);
  const account = repo.accounts.get(rec.account_id);
  const client = new KoorooClient(account);
  await client.hydrateFromSession();
  const result = await fire.fireScheduled({ recurring: { ...rec, courts }, targetMs: fm, client, primed });
  await fire.recordAndPersistScheduledFire({ recurring: { ...rec, courts }, targetMs: fm, client, primed, result });
  recurring.chainToNextWeek(rec.id);
  repo.recurring.update(rec.id, { first_occurrence_action: 'resolved' });
  schedule(rec.id);
}

async function executeImmediateBooking(rec) {
  log.info('scheduler.immediate', { recurring: rec.id, label: rec.label });
  // The immediate path: use the next_fire_at directly as the target slot
  const fireMs = nextFireUtcMs(rec) || Date.now();
  let prepared;
  try {
    prepared = await prepareForFire(rec, fireMs);
  } catch (e) {
    log.error('scheduler.immediate.prepare', { recurring: rec.id, error: e.message });
    repo.recurring.setLastResult(rec.id, { status: 'login_required', msg: e.message, category: 'technical_error' });
    state.transition(rec.account_id, state.STATES.LOGIN_REQUIRED, e.message);
    return;
  }
  const { courts, apiPref, slot, primed } = prepared;
  const account = repo.accounts.get(rec.account_id);
  const client = new KoorooClient(account);
  await client.hydrateFromSession();
  await fire.fireImmediate({
    recurring: { ...rec, courts },
    client,
    primed: { date: slot.date, from: slot.from, to: slot.to, courtId: apiPref },
  });
  recurring.chainToNextWeek(rec.id);
  repo.recurring.update(rec.id, { first_occurrence_action: 'resolved' });
  schedule(rec.id);
}

function schedule(recurringId) {
  const rec = repo.recurring.get(recurringId);
  if (!rec || !rec.enabled) { clearTimers(recurringId); return; }
  clearTimers(recurringId);
  const nextUtc = nextFireUtcMs(rec);
  if (!nextUtc) { log.warn('scheduler.no-next-fire', { recurring: recurringId }); return; }
  const now = Date.now();
  const delta = nextUtc - now;
  const isImmediate = delta <= 1000;
  const leadMs = (rec.lead_minutes || 10) * 60_000;
  log.info('scheduler.arm', { recurring: recurringId, nextUtc, deltaMs: delta, isImmediate });
  if (isImmediate) {
    const fireTimer = setTimeout(() => {
      executeImmediateBooking(rec).catch(e => log.error('scheduler.immediate.error', { recurring: recurringId, error: e.message }));
    }, 200);
    timers.set(recurringId, { fireTimer });
    return;
  }
  const warmDelta = Math.max(1000, delta - leadMs);
  const warmTimer = setTimeout(() => {
    const fireMs = nextUtc;
    const slot = slotForFire(rec, fireMs);
    warmup.warm(rec.account_id, {
      date: slot.date, from: slot.from, to: slot.to,
      courtId: recurring.COURT_TO_API[rec.court_pref],
    }).catch(e => log.error('scheduler.warm.error', { recurring: recurringId, error: e.message }));
  }, warmDelta);
  const fireTimer = setTimeout(() => {
    executeScheduledBooking(rec, nextUtc).catch(e => log.error('scheduler.fire.error', { recurring: recurringId, error: e.message }));
  }, delta);
  timers.set(recurringId, { warmTimer, fireTimer });
}

function rescanAll() {
  const all = repo.recurring.list({ enabled: true });
  const liveIds = new Set(all.map(r => r.id));
  for (const id of [...timers.keys()]) if (!liveIds.has(id)) clearTimers(id);
  for (const r of all) {
    // If the next_fire_at is in the past, treat as immediate (the slot we
    // were supposed to book is at-or-near now)
    const nextUtc = nextFireUtcMs(r);
    if (nextUtc && nextUtc < Date.now() - 60_000) {
      // missed: advance to next fire by computing the next slot from now
      const nextTarget = time.nextWeekdayAt(r.day_of_week, r.time, { after: Date.now() + 1000 });
      repo.fireEvents.create({
        recurring_id: r.id, account_id: r.account_id,
        scheduled_at: new Date(nextUtc).toISOString(), status: 'skipped',
        error: 'missed fire on boot',
      });
      log.info('scheduler.rescan.missed', { recurring: r.id, was: new Date(nextUtc).toISOString(), now: new Date(nextTarget).toISOString() });
      repo.recurring.update(r.id, { next_fire_at: new Date(nextTarget).toISOString() });
    }
    schedule(r.id);
  }
}

let rescanInterval;
let booted = false;

function start() {
  if (booted) return;
  booted = true;
  rescanInterval = setInterval(rescanAll, 5 * 60_000);
  rescanAll();
  log.info('scheduler.start');
}

function stop() {
  if (rescanInterval) clearInterval(rescanInterval);
  rescanInterval = null;
  for (const id of [...timers.keys()]) clearTimers(id);
  booted = false;
  log.info('scheduler.stop');
}

function listActive() {
  const out = [];
  for (const [id, t] of timers) out.push({ recurring_id: id, hasWarmTimer: !!t.warmTimer, hasFireTimer: !!t.fireTimer });
  return out;
}

module.exports = { start, stop, schedule, rescanAll, listActive, executeImmediateBooking, executeScheduledBooking, slotForFire, SESSION_LEAD_MS };
// backward-compat aliases
module.exports.executeImmediateFire = module.exports.executeImmediateBooking;
module.exports.executeScheduledFire = module.exports.executeScheduledBooking;
