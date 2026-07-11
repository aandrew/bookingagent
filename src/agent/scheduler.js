'use strict';

const repo = require('../db/repo');
const time = require('./time');
const state = require('./state');
const warmup = require('./warmup');
const fire = require('./fire');
const pool = require('./pool');
const recurring = require('./recurring');
const log = require('../logger');
const config = require('../config');
const { KoorooClient } = require('../kooroo/client');
const { timeToSlot, slotToTime } = require('../kooroo/client');

const timers = new Map(); // recurringId -> { sessionCheckTimer, warmTimer, fireTimer }
const inFlight = new Set(); // recurringId -> fire currently executing
const SESSION_LEAD_MS = 7 * 24 * 3600_000;  // 7 days

function isFiring(recurringId) { return inFlight.has(recurringId); }
function markFiring(recurringId) { inFlight.add(recurringId); }
function clearFiring(recurringId) { inFlight.delete(recurringId); }
function isFiringAny() { return inFlight.size > 0; }
function inFlightIds() { return [...inFlight]; }

function clearTimers(id) {
  const t = timers.get(id);
  if (!t) return;
  for (const k of ['sessionCheckTimer', 'warmTimer', 'fireTimer']) {
    if (t[k]) clearTimeout(t[k]);
  }
  timers.delete(id);
}

function nextFireUtcMs(rec) {
  if (!rec.next_fire_at) return null;
  return new Date(rec.next_fire_at).getTime();
}

// Returns the slot (date, from, to) we will book at `fireMs`.
//
// v3.4: the fire happens at the OPENING of a slot (T-7d, where T is the
// slot's time). So the slot we book is T = fireMs + 7d. For the very
// first fire, the row carries first_slot_date — we use that directly so
// the picked slot is honoured even when the opening has already passed
// and the fire happens at the slot's closing moment.
function slotForFire(rec, fireMs) {
  let dateStr;
  if (!rec.last_fire_at && rec.first_slot_date) {
    // First fire: honour the user-picked slot date.
    dateStr = rec.first_slot_date;
  } else {
    // Subsequent fires: the slot is 7 days after the fire time.
    dateStr = time.sydneyDateString(fireMs + 7 * 86_400_000);
  }
  const from = timeToSlot(rec.time);
  const to = from + Math.max(1, Math.round((rec.duration_mins || 60) / 30));
  return { date: dateStr, from, to };
}

async function prepareForFire(rec, fireMs) {
  // Kept for backward compat with call sites that still want the
  // full prepared context. New code should call warmup.prepareForFire
  // directly (which stashes a fire-ready context keyed by recurringId).
  return warmup.prepareForFire(rec, fireMs);
}

async function executeScheduledBooking(rec, fireMs) {
  if (isFiring(rec.id)) {
    log.warn('scheduler.fire.duplicate', { recurring: rec.id });
    return;
  }
  markFiring(rec.id);
  log.info('scheduler.fire', { recurring: rec.id, label: rec.label, fireMs });
  try {
    let ctx = fire.popFireContext(rec.id);
    if (!ctx) {
      log.warn('scheduler.fire.noContext.fallback', { recurring: rec.id, fireMs });
      try {
        ctx = await warmup.prepareForFire(rec, fireMs);
      } catch (e) {
        log.error('scheduler.fire.prepare', { recurring: rec.id, error: e.message });
        repo.recurring.setLastResult(rec.id, { status: 'login_required', msg: e.message, category: 'technical_error' });
        state.transition(rec.account_id, state.STATES.LOGIN_REQUIRED, e.message);
        return;
      }
    }
    await time.waitUntilExact(fireMs);
    const result = await fire.fireScheduledFromContext({
      ctx,
      onAttempt: ({ courtId, idx }) => {
        repo.fireEvents.create({
          recurring_id: rec.id, account_id: rec.account_id,
          scheduled_at: new Date(fireMs).toISOString(),
          status: 'attempting', attempt: 1, court_attempted: courtId,
          date: ctx.slot.date, time: slotToTime(ctx.slot.from),
        });
      },
    });
    await fire.recordAndPersistScheduledFire({ ctx, result });
    recurring.chainToNextWeek(rec.id);
    repo.recurring.update(rec.id, { first_occurrence_action: 'resolved' });
  } catch (e) {
    log.error('scheduler.fire.error', { recurring: rec.id, error: e.message });
  } finally {
    clearFiring(rec.id);
  }
  schedule(rec.id);
}

async function executeImmediateBooking(rec) {
  if (isFiring(rec.id)) {
    log.warn('scheduler.immediate.duplicate', { recurring: rec.id });
    return;
  }
  markFiring(rec.id);
  log.info('scheduler.immediate', { recurring: rec.id, label: rec.label });
  const fireMs = nextFireUtcMs(rec) || Date.now();
  try {
    let ctx = fire.popFireContext(rec.id);
    if (!ctx) {
      try {
        ctx = await warmup.prepareForFire(rec, fireMs);
      } catch (e) {
        log.error('scheduler.immediate.prepare', { recurring: rec.id, error: e.message });
        repo.recurring.setLastResult(rec.id, { status: 'login_required', msg: e.message, category: 'technical_error' });
        state.transition(rec.account_id, state.STATES.LOGIN_REQUIRED, e.message);
        return;
      }
    }
    await fire.fireImmediate({
      recurring: ctx.recurring,
      client: ctx.client,
      primed: { date: ctx.slot.date, from: ctx.slot.from, to: ctx.slot.to, courtId: ctx.apiPref },
    });
    recurring.chainToNextWeek(rec.id);
    repo.recurring.update(rec.id, { first_occurrence_action: 'resolved' });
  } catch (e) {
    log.error('scheduler.immediate.error', { recurring: rec.id, error: e.message });
  } finally {
    clearFiring(rec.id);
  }
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
  // v3: lead minutes is global (LEAD_MINUTES_BEFORE_FIRE). The per-recurring
  // lead_minutes field is ignored — the form no longer exposes it and we
  // always use the configured default.
  const leadMs = config.defaultLeadMinutesBeforeFire * 60_000;
  log.info('scheduler.arm', { recurring: recurringId, nextUtc, deltaMs: delta, isImmediate, leadMinutes: config.defaultLeadMinutesBeforeFire });
  if (isImmediate) {
    const fireTimer = setTimeout(() => {
      executeImmediateBooking(rec).catch(e => log.error('scheduler.immediate.error', { recurring: recurringId, error: e.message }));
    }, 200);
    timers.set(recurringId, { fireTimer });
    return;
  }
  // v3.1: per-recurring session-check timer. Probes the account session a
  // configurable offset BEFORE the existing warmup, so a Playwright re-login
  // (if needed) has time to complete. This replaces the legacy */10 cron
  // that polled every account 24/7.
  const sessionCheckOffsetMs = config.sessionCheckOffsetMinutes * 60_000;
  const sessionCheckDelta = Math.max(1000, delta - leadMs - sessionCheckOffsetMs);
  const sessionCheckTimer = setTimeout(() => {
    pool.probeOne(rec.account_id)
      .then(r => log.info('scheduler.sessionCheck.done', { recurring: recurringId, account: rec.account_id, ok: r.ok, reloggedIn: r.reloggedIn || false, error: r.reloginError || null }))
      .catch(e => log.error('scheduler.sessionCheck.error', { recurring: recurringId, error: e.message }));
  }, sessionCheckDelta);
  const warmDelta = Math.max(1000, delta - leadMs);
  const warmTimer = setTimeout(() => {
    const fireMs = nextUtc;
    const fresh = repo.recurring.get(recurringId);
    if (!fresh || !fresh.enabled) return;
    warmup.prepareForFire(fresh, fireMs)
      .catch(e => log.error('scheduler.warm.error', { recurring: recurringId, error: e.message }));
  }, warmDelta);
  const fireTimer = setTimeout(() => {
    executeScheduledBooking(rec, nextUtc).catch(e => log.error('scheduler.fire.error', { recurring: recurringId, error: e.message }));
  }, delta);
  timers.set(recurringId, { sessionCheckTimer, warmTimer, fireTimer });
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
  for (const [id, t] of timers) out.push({ recurring_id: id, hasSessionCheckTimer: !!t.sessionCheckTimer, hasWarmTimer: !!t.warmTimer, hasFireTimer: !!t.fireTimer });
  return out;
}

// v3.5: returns the slot the next fire of `rec` will attempt to book.
// Used by the recurring detail page to show "Booking target: <date> <time>".
// Returns { date, from, to } or null if the recurring has no next_fire_at.
function nextBookingTarget(rec) {
  if (!rec.next_fire_at) return null;
  const fireMs = new Date(rec.next_fire_at).getTime();
  return slotForFire(rec, fireMs);
}

module.exports = { start, stop, schedule, rescanAll, listActive, executeImmediateBooking, executeScheduledBooking, slotForFire, nextBookingTarget, prepareForFire, isFiring, isFiringAny, inFlightIds, msUntilNextFire, heartbeatIntervalMs, SESSION_LEAD_MS };
// backward-compat aliases
module.exports.executeImmediateFire = module.exports.executeImmediateBooking;
module.exports.executeScheduledFire = module.exports.executeScheduledBooking;

// v4: smart heartbeat interval for the SSE endpoint. Fast (2s) when a
// fire is imminent OR a fire is currently in flight (we want quick
// detection of a dead connection so we don't miss a booking result).
// Ramps back to a slow default (30s) as the next fire recedes. The
// linear ramp is 2s at T-0, 30s at T-300s+, smooth in between.
const HEARTBEAT_FAST_MS = 2_000;
const HEARTBEAT_SLOW_MS = 30_000;
const HEARTBEAT_RAMP_FIRE_MS = 300_000; // 5 min — beyond this, full slow

function msUntilNextFire() {
  let best = null;
  try {
    const repo = require('../db/repo');
    for (const r of repo.recurring.list({ enabled: true })) {
      if (!r.next_fire_at) continue;
      const t = new Date(r.next_fire_at).getTime();
      if (Number.isFinite(t) && (best == null || t < best)) best = t;
    }
  } catch {}
  if (best == null) return Infinity;
  return best - Date.now();
}

function heartbeatIntervalMs() {
  if (inFlight.size > 0) return HEARTBEAT_FAST_MS;
  const ms = msUntilNextFire();
  if (!Number.isFinite(ms)) return HEARTBEAT_SLOW_MS;
  // Linear ramp: 2s at T-0, 30s at T-300s+
  if (ms <= 0) return HEARTBEAT_FAST_MS;
  if (ms >= HEARTBEAT_RAMP_FIRE_MS) return HEARTBEAT_SLOW_MS;
  // ms/10 = the desired interval in seconds, but bounded.
  return Math.max(HEARTBEAT_FAST_MS, Math.min(HEARTBEAT_SLOW_MS, Math.ceil(ms / 10)));
}
