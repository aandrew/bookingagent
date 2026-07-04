'use strict';

const { getAvailability, annotateBooking, findOpenSlot } = require('../kooroo/availability');
const { createBooking, findBookingFor } = require('../kooroo/booking');
const { timeToSlot, slotToTime } = require('../kooroo/client');
const { withClient } = require('./pool');
const repo = require('../db/repo');
const log = require('../logger');

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
  const target = new Date(String(targetDateStr) + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target - today) / 86_400_000);
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
      repo.bookings.create({
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
      log.info('monitor.booked', { watch: watch.id, account: account.username, courtId, from, to, date });
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

module.exports = { runAll, runWatch, bookNow, pickTargetDate, pickTimeWindow, isWithinBookingWindow };
