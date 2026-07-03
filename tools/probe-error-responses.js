#!/usr/bin/env node
'use strict';

/**
 * Probe what the server returns for various edge cases so we can refine
 * the categoriser in src/agent/fire.js.
 *
 * Cases:
 *   1. Court doesn't exist (e.g. court_id "99")
 *   2. Slot already booked (book a real slot twice)
 *   3. Booking on a date too far in advance (e.g. 30 days out)
 *   4. Booking with bogus action
 *
 * Usage: node tools/probe-error-responses.js
 */

require('dotenv').config();
const db = require('../src/db');
const repo = require('../src/db/repo');
const { KoorooClient } = require('../src/kooroo/client');
const endpoints = require('../src/kooroo/endpoints.json');
const { slotToTime, timeToSlot } = require('../src/kooroo/client');

async function main() {
  db.init();
  const account = repo.accounts.list()[0];
  if (!account) { console.error('No account'); process.exit(2); }
  const client = new KoorooClient(account);
  await client.hydrateFromSession();
  const boot = await client.bootstrapParams();
  if (!boot.ok) { console.error('bootstrap failed:', boot.reason); process.exit(3); }

  async function trial(label, params) {
    console.log(`\n--- ${label} ---`);
    const r = await client.createBooking(params);
    console.log('  status:', r.status);
    console.log('  body:', JSON.stringify(r.body).slice(0, 400));
    return { status: r.status, body: r.body };
  }

  // Find a slot in the near future we already booked today
  const today = new Date().toISOString().slice(0,10);
  const sched = await client.getDaySchedule(today);
  const existing = sched.body?.bookings?.[0];
  let alreadyBookedSlot = null;
  if (existing) {
    alreadyBookedSlot = { date: existing.date, from: existing.from, to: existing.to, court_id: existing.court_id };
    console.log('Found existing booking on', today, '— court', existing.court_id, 'slots', existing.from, '-', existing.to);
  }

  // 1. bogus court
  await trial('bogus court (court_id 99)', { date: today, from: 30, to: 32, court_id: '99' });

  // 2. duplicate booking
  if (alreadyBookedSlot) {
    await trial('duplicate slot', { date: alreadyBookedSlot.date, from: alreadyBookedSlot.from, to: alreadyBookedSlot.to, court_id: alreadyBookedSlot.court_id });
  } else {
    console.log('No existing booking today; skipping duplicate test');
  }

  // 3. too far in advance (30 days)
  const farDate = new Date(); farDate.setDate(farDate.getDate() + 30);
  const farStr = farDate.toISOString().slice(0,10);
  await trial('too far in advance (30 days)', { date: farStr, from: 30, to: 32, court_id: '5' });

  // 4. past date
  const past = new Date(); past.setDate(past.getDate() - 1);
  const pastStr = past.toISOString().slice(0,10);
  await trial('past date', { date: pastStr, from: 30, to: 32, court_id: '5' });
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
