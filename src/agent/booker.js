'use strict';

const { withClient } = require('./pool');
const { createBooking, cancelBooking, findBookingFor } = require('../kooroo/booking');
const { slotToTime } = require('../kooroo/client');
const repo = require('../db/repo');
const log = require('../logger');
const bus = require('./bus');
const EV = require('./bus-events');

async function book({ accountId, date, startTime, endTime, court, watchId = null }) {
  return withClient(accountId, async (client) => {
    const { timeToSlot } = require('../kooroo/client');
    const from = timeToSlot(startTime);
    const to = timeToSlot(endTime);
    if (!from || !to || to <= from) throw new Error(`Invalid time window: ${startTime}-${endTime}`);
    const r = await createBooking(client, { date, from, to, court_id: court });
    const httpOk = r.status >= 200 && r.status < 300;
    let externalId = null;
    if (httpOk) {
      const found = await findBookingFor(client, { date, from, to, court_id: court });
      externalId = found?.id || null;
    }
    const status = !httpOk ? 'failed' : (externalId ? 'confirmed' : 'booked_unverified');
    const booking = repo.bookings.create({
      account_id: accountId,
      watch_id: watchId,
      court, date, start_time: startTime, end_time: endTime,
      status,
      external_id: externalId,
      raw_json: r.body,
    });
    log.info('booker.manual', { accountId, status: r.status, booking: booking.id, externalId, bookingStatus: status });
    try { bus.emit(EV.BOOKING_CREATED, booking); } catch (e) { log.warn('bus.emit.failed', { event: EV.BOOKING_CREATED, error: e.message }); }
    return { status: r.status, body: r.body, booking };
  });
}

async function cancel(bookingId) {
  const b = repo.bookings.get(bookingId);
  if (!b) throw new Error(`No such booking: ${bookingId}`);
  if (!b.external_id) {
    const err = new Error(`Cannot cancel booking #${bookingId}: no external_id (status=${b.status}). The booking may still be reconciling — try again in a minute, or check the audit log.`);
    err.status = 409;
    throw err;
  }
  return withClient(b.account_id, async (client) => {
    const r = await cancelBooking(client, { id: b.external_id, date: b.date, from: b.start_time, to: b.end_time, court_id: b.court });
    const newStatus = r.status >= 200 && r.status < 300 ? 'cancelled' : 'cancel-failed';
    const updated = repo.bookings.update(b.id, { status: newStatus, raw_json: r.body });
    try { bus.emit(EV.BOOKING_UPDATED, updated); } catch (e) { log.warn('bus.emit.failed', { event: EV.BOOKING_UPDATED, error: e.message }); }
    return { status: r.status, body: r.body };
  });
}

module.exports = { book, cancel };
