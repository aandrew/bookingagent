'use strict';

const { withClient } = require('./pool');
const { createBooking, cancelBooking } = require('../kooroo/booking');
const { slotToTime } = require('../kooroo/client');
const repo = require('../db/repo');
const log = require('../logger');

async function book({ accountId, date, startTime, endTime, court, watchId = null }) {
  return withClient(accountId, async (client) => {
    // Translate times to slots (30-min units)
    const { timeToSlot } = require('../kooroo/client');
    const from = timeToSlot(startTime);
    const to = timeToSlot(endTime);
    if (!from || !to || to <= from) throw new Error(`Invalid time window: ${startTime}-${endTime}`);
    const r = await createBooking(client, { date, from, to, court_id: court });
    const externalId = r.body?.id || r.body?.booking_id || (r.body?.data2?.bookingId) || null;
    const booking = repo.bookings.create({
      account_id: accountId,
      watch_id: watchId,
      court, date, start_time: startTime, end_time: endTime,
      status: r.status >= 200 && r.status < 300 ? 'confirmed' : 'failed',
      external_id: externalId,
      raw_json: r.body,
    });
    log.info('booker.manual', { accountId, status: r.status, booking: booking.id });
    return { status: r.status, body: r.body, booking };
  });
}

async function cancel(bookingId) {
  const b = repo.bookings.get(bookingId);
  if (!b) throw new Error(`No such booking: ${bookingId}`);
  return withClient(b.account_id, async (client) => {
    const r = await cancelBooking(client, { id: b.external_id, date: b.date, from: b.start_time, to: b.end_time, court_id: b.court });
    const newStatus = r.status >= 200 && r.status < 300 ? 'cancelled' : 'cancel-failed';
    repo.bookings.update(b.id, { status: newStatus, raw_json: r.body });
    return { status: r.status, body: r.body };
  });
}

module.exports = { book, cancel };
