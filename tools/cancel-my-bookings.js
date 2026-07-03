#!/usr/bin/env node
'use strict';
require('dotenv').config();
const db = require('../src/db');
const repo = require('../src/db/repo');
const { KoorooClient } = require('../src/kooroo/client');

async function main() {
  db.init();
  const account = repo.accounts.list()[0];
  const client = new KoorooClient(account);
  await client.hydrateFromSession();
  await client.bootstrapParams();

  const target = process.argv[2] || '2026-07-10';
  console.log('Listing bookings on', target, '...');
  const r = await client.getDaySchedule(target);
  const myBookings = (r.body?.bookings || []).filter(b => String(b.contact_id) === String(client.contactId));
  console.log('bookings by this account:', myBookings.length);
  myBookings.forEach(b => console.log(' -', b));
  for (const b of myBookings) {
    console.log('Deleting', b.id, '...');
    const dr = await client.deleteBooking(b.id);
    console.log('  status', dr.status, 'body', JSON.stringify(dr.body).slice(0, 200));
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
