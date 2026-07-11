'use strict';

const { getAvailability, annotateBooking, findOpenSlot } = require('../kooroo/availability');
const { createBooking, findBookingFor } = require('../kooroo/booking');
const { timeToSlot, slotToTime } = require('../kooroo/client');
const { withClient } = require('./pool');
const repo = require('../db/repo');
const log = require('../logger');
const bus = require('./bus');
const EV = require('./bus-events');

function watchMatchesSlot(slot, watch) {
  if (watch.court && String(slot.court_id) !== String(watch.court)) return false;
  if (watch.date_from && slot.date && slot.date < watch.date_from) return false;
  if (watch.date_to && slot.date && slot.date > watch.date_to) return false;
  if (watch.time_start && slot.start_time && slot.start_time < watch.time_start) return false;
  if (watch.time_end && slot.end_time && slot.end_time > watch.time_end) return false;
  return true;
}

function pickTargetDate(watch) {
  if (watch.strategy === 'scheduled' && watch.date_from) return watch.date_from;
  if (watch.date_from) return watch.date_from;
  const d = new Date();
  d.setDate(d.getDate() + (watch.lead_days || 7));
  return d.toISOString().slice(0, 10);
}

function pickTimeWindow(watch) {
  const from = timeToSlot(watch.time_start || '18:00');
  const to = from + (watch.duration_mins ? Math.max(1, Math.round(watch.duration_mins / 30)) : 2);
  return { from, to };
}

// v3.4: Koorora only allows bookings up to 7 days in advance. If the
// target date is beyond that, we don't even attempt — the API silently
// returns the nearest bookable week, which would book the wrong date.
// The user must use the Make Booking form (recurring) for >7 days.
function isWithinBookingWindow(targetDateStr) {
  if (!targetDateStr) return false;
  // v3.6: the date math must use Sydney time, not the container's local
  // time. The container is UTC, but the user is in Sydney, so a date
  // string like "2026-07-15" represents a Sydney calendar day. If we
  // naively used `new Date('2026-07-15T00:00:00')` (which interprets in
  // local time = UTC), a user in Sydney at 8am (22:00 UTC the previous
  // day) would see "today" as 2026-07-10 (UTC) when they think it's
  // 2026-07-11 (Sydney), making the 7-day boundary off by a day.
  // Using sydneyWallToUtc + sydneyDateString anchors both ends to Sydney.
  const time = require('./time');
  const targetMs = time.sydneyWallToUtc(String(targetDateStr), '00:00');
  const todaySydney = time.sydneyDateString(Date.now());
  const todayMs = time.sydneyWallToUtc(todaySydney, '00:00');
  const diffDays = Math.round((targetMs - todayMs) / 86_400_000);
  return diffDays >= 0 && diffDays <= 7;
}

async function runWatch(watch) {
  const account = repo.accounts.get(watch.account_id);
  if (!account || !account.enabled) {
    repo.watches.recordRun(watch.id, 'skipped', 'account disabled or missing');
    return { status: 'skipped' };
  }
  const targetDate = pickTargetDate(watch);
  if (!isWithinBookingWindow(targetDate)) {
    const msg = `Date ${targetDate} is more than 7 days out — Koorora only allows bookings within 7 days. Use the Make Booking form (recurring) for dates > 7 days out.`;
    repo.watches.recordRun(watch.id, 'scheduled', msg);
    return { status: 'scheduled', reason: msg, date: targetDate };
  }
  return withClient(account.id, async (client) => {
    const date = pickTargetDate(watch);
    const r = await getAvailability(client, { date, court: watch.court });
    if (r.status !== 200) {
      repo.watches.recordRun(watch.id, 'error', `HTTP ${r.status}`);
      return { status: 'error', http: r.status };
    }
    const { from, to } = pickTimeWindow(watch);
    const candidates = (r.bookings || []).filter(b => watchMatchesSlot(b, watch));
    // We need to find an OPEN slot, not a booked one — so look at the schedule
    // and check for free windows.
    const allBookings = r.bookings;
    const courtId = watch.court || r.courts?.[0]?.id;
    const open = findOpenSlot({ bookings: allBookings, courtId, fromSlot: from, toSlot: to });
    if (!open) {
      repo.watches.recordRun(watch.id, 'no-match', `checked ${allBookings.length} bookings on ${date}`);
      return { status: 'no-match', date, candidates: candidates.length };
    }
    const cr = await createBooking(client, { date, from, to, court_id: courtId });
    if (cr.status >= 200 && cr.status < 300) {
      const found = await findBookingFor(client, { date, from, to, court_id: courtId });
      const externalId = found?.id || null;
      const newBooking = repo.bookings.create({
        account_id: account.id,
        watch_id: watch.id,
        court: String(courtId),
        date,
        start_time: slotToTime(from),
        end_time: slotToTime(to),
        status: 'confirmed',
        external_id: externalId,
        raw_json: cr.body,
      });
      repo.watches.recordRun(watch.id, 'booked', `slot ${slotToTime(from)}-${slotToTime(to)}`);
      // v3.5: non-recurring watches are one-shot — mark fired so the
      // fire-due-watches cron doesn't keep retrying.
      repo.watches.setFired(watch.id);
      log.info('monitor.booked', { watch: watch.id, account: account.username, courtId, from, to, date });
      // v4: emit booking_created so /bookings updates live.
      try { bus.emit(EV.BOOKING_CREATED, newBooking); } catch (e) { log.warn('bus.emit.failed', { event: EV.BOOKING_CREATED, error: e.message }); }
      return { status: 'booked', http: cr.status, body: cr.body, externalId };
    }
    repo.bookings.create({
      account_id: account.id,
      watch_id: watch.id,
      court: String(courtId),
      date,
      start_time: slotToTime(from),
      end_time: slotToTime(to),
      status: 'failed',
      raw_json: cr.body,
    });
    repo.watches.recordRun(watch.id, 'failed', `HTTP ${cr.status}`);
    // Mark fired even on failure so the cron doesn't repeatedly retry
    // a doomed slot. The user can create a new watch if they want to retry.
    repo.watches.setFired(watch.id);
    return { status: 'failed', http: cr.status, body: cr.body };
  });
}

async function runAll() {
  const watches = repo.watches.list().filter(w => w.enabled);
  const results = [];
  for (const w of watches) {
    try { results.push({ watch: w.id, ...(await runWatch(w)) }); }
    catch (e) {
      log.error('monitor.error', { watch: w.id, error: e.message });
      repo.watches.recordRun(w.id, 'error', e.message);
      results.push({ watch: w.id, status: 'error', error: e.message });
    }
  }
  return results;
}

async function bookNow(watchId) {
  const w = repo.watches.get(watchId);
  if (!w) throw new Error(`No such watch: ${watchId}`);
  return runWatch(w);
}

// v3.5: fire any "scheduled" watches whose date_from is now within the
// 7-day booking window. Called by the cron in jobs.js. Skips watches
// that have already fired (fired_at set) or that are disabled.
async function fireDueWatches() {
  const all = repo.watches.list();
  const results = [];
  for (const w of all) {
    if (!w.enabled) continue;
    if (w.fired_at) continue;  // already done
    const target = pickTargetDate(w);
    if (!isWithinBookingWindow(target)) continue;  // wait until within window
    try { results.push({ watch: w.id, ...(await runWatch(w)) }); }
    catch (e) {
      log.error('monitor.fire-due.error', { watch: w.id, error: e.message });
      repo.watches.recordRun(w.id, 'error', e.message);
      results.push({ watch: w.id, status: 'error', error: e.message });
    }
  }
  return { fired: results.length, results };
}

module.exports = { runAll, runWatch, bookNow, fireDueWatches, pickTargetDate, pickTimeWindow, isWithinBookingWindow, reconcileUnverifiedBookings };

// v3.6: reconcile bookings that the server confirmed (cat.code === 'booked')
// but where the day-schedule lookup right after the POST didn't see the new
// row in the server's response. We re-fetch the day schedule and try to find
// the booking again. If found, we fill in external_id and flip to 'confirmed'.
// This is the fix for the "confirmed in our DB but no external_id" desync.
async function reconcileUnverifiedBookings({ olderThanMs = 30_000, maxItems = 25 } = {}) {
  const pending = repo.bookings.listUnverified({ olderThanMs, limit: maxItems });
  if (!pending.length) return { checked: 0, confirmed: 0, abandoned: 0, results: [] };
  const results = [];
  let confirmed = 0;
  let abandoned = 0;
  for (const b of pending) {
    const account = repo.accounts.get(b.account_id);
    if (!account || !account.enabled) {
      results.push({ id: b.id, status: 'skipped', reason: 'account disabled or missing' });
      continue;
    }
    try {
      const result = await withClient(account.id, async (client) => {
        const date = b.date;
        const from = require('../kooroo/client').timeToSlot(b.start_time);
        const to = require('../kooroo/client').timeToSlot(b.end_time);
        if (!from || !to) return { status: 'bad_slot' };
        const courtId = b.court ? String(b.court) : null;
        if (!courtId) return { status: 'no_court' };
        return await require('../kooroo/booking').findBookingFor(client, { date, from, to, court_id: courtId });
      });
      if (result && result.id) {
        repo.bookings.markVerified(b.id, result.id);
        confirmed++;
        results.push({ id: b.id, status: 'confirmed', external_id: result.id });
        log.info('reconcile.confirmed', { booking: b.id, account: b.account_id, external_id: result.id });
      } else {
        results.push({ id: b.id, status: 'still_unverified', reason: result?.status || 'no_match' });
      }
    } catch (e) {
      log.error('reconcile.error', { booking: b.id, error: e.message });
      results.push({ id: b.id, status: 'error', error: e.message });
    }
  }
  if (confirmed > 0) log.info('reconcile.summary', { checked: pending.length, confirmed });
  return { checked: pending.length, confirmed, abandoned, results };
}
