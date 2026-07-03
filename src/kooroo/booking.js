'use strict';

async function createBooking(client, { date, from, to, court_id }) {
  const r = await client.createBooking({ date, from, to, court_id });
  return r;
}

async function findBookingFor(client, { date, from, to, court_id }) {
  const r = await client.getDaySchedule(date);
  if (r.status !== 200) return null;
  const hit = (r.body?.bookings || []).find(b =>
    String(b.court_id) === String(court_id) &&
    parseInt(b.from, 10) === parseInt(from, 10) &&
    parseInt(b.to, 10) === parseInt(to, 10) &&
    String(b.contact_id) === String(client.contactId)
  );
  return hit || null;
}

async function cancelBooking(client, { date, from, to, court_id, id = null }) {
  let bookingId = id;
  if (!bookingId) bookingId = (await findBookingFor(client, { date, from, to, court_id }))?.id;
  if (!bookingId) {
    return { status: 404, body: { error: 'no_matching_booking' } };
  }
  return client.deleteBooking(bookingId);
}

module.exports = { createBooking, cancelBooking, findBookingFor };
