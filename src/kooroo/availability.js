'use strict';

const { slotToTime } = require('./client');

function parseDaySchedule(body) {
  if (!body) return { date: null, schedule: [], bookings: [], courts: [] };
  return {
    date: body?.date || null,
    schedule: body?.schedule || [],
    bookings: body?.bookings || [],
    courts: body?.courts || [],
    block_out_times: body?.block_out_times || [],
    prevent_times_data: body?.prevent_times_data || {},
    raw: body,
  };
}

function annotateBooking(b) {
  return {
    ...b,
    court_id: b.court_id,
    from_slot: parseInt(b.from, 10),
    to_slot: parseInt(b.to, 10),
    start_time: slotToTime(b.from),
    end_time: slotToTime(b.to),
  };
}

async function getAvailability(client, { date, court = null } = {}) {
  const r = await client.getDaySchedule(date);
  if (r.status !== 200) return { status: r.status, body: r.body, parsed: null };
  const parsed = parseDaySchedule(r.body);
  return {
    status: r.status,
    body: r.body,
    parsed,
    bookings: parsed.bookings.map(annotateBooking),
    schedule: parsed.schedule,
    courts: parsed.courts,
  };
}

function findOpenSlot({ bookings, schedule, courtId, fromSlot, toSlot }) {
  const conflicting = bookings.find(b =>
    String(b.court_id) === String(courtId) &&
    !(parseInt(b.to) <= fromSlot || parseInt(b.from) >= toSlot)
  );
  return !conflicting;
}

module.exports = { getAvailability, parseDaySchedule, annotateBooking, findOpenSlot };
