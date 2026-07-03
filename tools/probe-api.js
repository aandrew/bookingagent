#!/usr/bin/env node
'use strict';

/**
 * Probes the live API with the stored session: lists courts/times for today,
 * finds a free slot, and creates a booking far in the future to avoid
 * disrupting real play. Reports the result without committing anything
 * destructive if --book is not passed.
 */

require('dotenv').config();
const db = require('../src/db');
const repo = require('../src/db/repo');
const { KoorooClient, slotToTime } = require('../src/kooroo/client');

async function main() {
  const book = process.argv.includes('--book');
  const cancel = process.argv.includes('--cancel');
  const date = (process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))) || null;
  db.init();
  const account = repo.accounts.list()[0];
  if (!account) { console.error('No account. Run `node tools/import-session.js --probe` first.'); process.exit(2); }
  const client = new KoorooClient(account);
  await client.hydrateFromSession();
  const ready = await client.bootstrapParams();
  if (!ready.ok) { console.error('bootstrap failed:', ready.reason); process.exit(3); }
  console.log('user_id:', client.userId, 'contact_id:', client.contactId);

  const target = date || futureDate(7);
  console.log('\nGET schedule for', target);
  const r = await client.getDaySchedule(target);
  console.log('status:', r.status);
  if (r.status !== 200) { console.error('body:', r.raw.slice(0, 500)); process.exit(4); }
  const courts = r.body?.courts || r.body?.schedule?.map(s => s.court_id) || [];
  const courtList = (Array.isArray(courts) && courts.length && typeof courts[0] === 'object')
    ? courts.map(c => c.id)
    : [...new Set(courts)];
  console.log('court ids on', target, ':', courtList);

  const bookings = r.body?.bookings || [];
  console.log('existing bookings:', bookings.length);

  // Find the first free hour-slot on the first court
  const from = 17, to = 19; // 8:00-9:00am
  const firstCourt = String(courtList[0]);
  const slotBooked = bookings.some(b => String(b.court_id) === firstCourt && !(parseInt(b.to) <= from || parseInt(b.from) >= to));
  console.log('slot', slotToTime(from), '-', slotToTime(to), 'on court', firstCourt, 'free?', !slotBooked);

  if (book && !slotBooked) {
    console.log('\nCreating booking...');
    const cr = await client.createBooking({ date: target, from, to, court_id: firstCourt });
    console.log('status:', cr.status, 'body:', JSON.stringify(cr.body).slice(0, 500));
    // The create response doesn't include the booking id. Fetch the day
    // schedule to find the matching booking, then delete it.
    const after = await client.getDaySchedule(target);
    const ourBooking = (after.body?.bookings || []).find(b =>
      String(b.court_id) === firstCourt &&
      parseInt(b.from) === from &&
      parseInt(b.to) === to
    );
    console.log('found booking in schedule:', ourBooking?.id);
    const rec = repo.bookings.create({
      account_id: account.id,
      court: firstCourt, date: target, start_time: slotToTime(from), end_time: slotToTime(to),
      status: 'confirmed', external_id: ourBooking?.id || null, raw_json: cr.body,
    });
    console.log('saved booking row id', rec.id);
    if (cancel && ourBooking?.id) {
      const dr = await client.deleteBooking(ourBooking.id);
      console.log('cancel:', dr.status, JSON.stringify(dr.body).slice(0, 200));
      repo.bookings.update(rec.id, { status: dr.status < 300 ? 'cancelled' : 'cancel-failed', raw_json: dr.body });
    }
  } else if (book) {
    console.log('No free slot in chosen window; not booking.');
  }
}

function futureDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
