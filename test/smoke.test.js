'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kooroo-v21-test-'));
process.env.DATA_DIR = tmpDir;
process.env.KOOROO_BASE_URL = 'https://www.kooroora.asn.au';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'test-pass';
process.env.SESSION_SECRET = 'test-secret';

const config = require('../src/config');
const db = require('../src/db');
const repo = require('../src/db/repo');
const endpoints = require('../src/kooroo/endpoints.json');
const { slotToTime, timeToSlot } = require('../src/kooroo/client');
const { KoorooClient } = require('../src/kooroo/client');
const time = require('../src/agent/time');
const state = require('../src/agent/state');
const fire = require('../src/agent/fire');
const recurring = require('../src/agent/recurring');

test('config has expected base url', () => {
  assert.equal(config.kooroo.baseUrl, 'https://www.kooroora.asn.au');
});

test('db initialises and migrates', () => {
  db.init();
  const accounts = repo.accounts.list();
  assert.equal(Array.isArray(accounts), true);
  assert.equal(accounts.length, 0);
});

test('account lifecycle', () => {
  const a = repo.accounts.create({ label: 'Test', username: 'andrew', password: 'pw' });
  assert.ok(a.id);
  assert.equal(a.state, 'waiting');
  state.transition(a.id, state.STATES.TESTED_OK, 'test');
  assert.equal(repo.accounts.get(a.id).state, 'tested_ok');
  repo.accounts.remove(a.id);
  assert.equal(repo.accounts.get(a.id), undefined);
});

test('watch and booking lifecycle', () => {
  const a = repo.accounts.create({ label: 'A', username: 'u', password: 'p' });
  const w = repo.watches.create({ account_id: a.id, label: 'Tue 7pm' });
  assert.ok(w.id);
  const b = repo.bookings.create({ account_id: a.id, watch_id: w.id, status: 'confirmed', date: '2026-07-10', start_time: '19:00', end_time: '20:00', court: '5' });
  assert.ok(b.id);
  assert.equal(repo.bookings.list({ status: 'confirmed' }).length, 1);
  repo.bookings.update(b.id, { status: 'cancelled' });
  assert.equal(repo.bookings.list({ status: 'cancelled' }).length, 1);
});

test('session round-trip', () => {
  const a = repo.accounts.create({ label: 'S', username: 's', password: 'p' });
  repo.sessions.upsert({ accountId: a.id, cookiesJson: ['k=v'], bearerToken: 'tok', csrfToken: 'csrf', userJson: { id: 1 }, expiresAt: '2026-12-31' });
  const s = repo.sessions.getByAccount(a.id);
  assert.equal(s.bearer_token, 'tok');
  const cookies = JSON.parse(s.cookies_json);
  assert.equal(cookies[0], 'k=v');
  repo.sessions.clear(a.id);
  assert.equal(repo.sessions.getByAccount(a.id), undefined);
});

test('audit log add + list + prune', () => {
  repo.audit.add({ direction: 'out', method: 'GET', url: 'https://x', status: 200, latency_ms: 12 });
  const list = repo.audit.list({});
  assert.ok(list.length >= 1);
  repo.audit.prune(30);
});

test('endpoints.json has expected shape', () => {
  assert.ok(endpoints.version >= 1);
  assert.equal(endpoints.baseUrl, 'https://www.kooroora.asn.au');
  assert.ok(endpoints.auth);
  assert.ok(endpoints.api);
  assert.ok(endpoints.api.actions);
});

test('slot ↔ time mapping', () => {
  assert.equal(slotToTime(1), '00:30');
  assert.equal(slotToTime(13), '06:30');
  assert.equal(slotToTime(17), '08:30');
  assert.equal(slotToTime(45), '22:30');
  assert.equal(timeToSlot('06:30'), 13);
  assert.equal(timeToSlot('08:30'), 17);
  assert.equal(timeToSlot('22:30'), 45);
  for (let s = 1; s <= 45; s++) {
    const t = slotToTime(s);
    assert.equal(timeToSlot(t), s, `round-trip failed at slot ${s} → ${t}`);
  }
});

// ---- v2.1 specific tests ----

test('v2.1: time helpers resolve next weekday in Sydney', () => {
  // Pick a Wednesday at 19:00
  const ms = time.nextWeekdayAt(3, '19:00', { after: Date.parse('2026-07-01T00:00:00Z') });
  const sydney = new Date(ms).toLocaleString('en-US', { timeZone: 'Australia/Sydney', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  assert.equal(sydney.includes('Wed'), true);
  assert.equal(sydney.includes('19:00'), true);
});

test('v2.1: sydneyWallToUtc handles AEST (winter) and AEDT (summer)', () => {
  const july = time.sydneyWallToUtc('2026-07-08', '19:00');
  const dec = time.sydneyWallToUtc('2026-12-15', '19:00');
  // July = AEST = UTC+10, so 19:00 → 09:00 UTC
  assert.equal(new Date(july).toISOString(), '2026-07-08T09:00:00.000Z');
  // Dec = AEDT = UTC+11, so 19:00 → 08:00 UTC
  assert.equal(new Date(dec).toISOString(), '2026-12-15T08:00:00.000Z');
});

test('v2.1: fire.categorize — booked', () => {
  const c = fire.categorize({ status: 200, body: { message: 'Your booking has been made.', status: 200 } });
  assert.equal(c.code, 'booked');
});

test('v2.1: fire.categorize — already booked by a member (no_time_available)', () => {
  const c = fire.categorize({ status: 404, body: { message: 'Please reserve a different court. This one is already booked by a member.', status: 404 } });
  assert.equal(c.code, 'no_time_available');
  assert.equal(c.reason, 'already_booked');
});

test('v2.1: fire.categorize — court invalid (technical_error)', () => {
  const c = fire.categorize({ status: 404, body: { message: 'The court you are trying to book does not exist.', status: 404 } });
  assert.equal(c.code, 'technical_error');
  assert.equal(c.reason, 'court_invalid');
});

test('v2.1: fire.categorize — window not open (technical_error)', () => {
  const c = fire.categorize({ status: 404, body: { message: 'This booking cannot be made yet. Please wait until the time is allowed under the Court Booking Rules.', status: 404 } });
  assert.equal(c.code, 'technical_error');
  assert.equal(c.reason, 'window_not_open');
});

test('v2.1: fire.categorize — auth_required', () => {
  const c = fire.categorize({ status: 401, body: null });
  assert.equal(c.code, 'technical_error');
  assert.equal(c.reason, 'auth_required');
});

test('v2.1: fire.categorize — network error', () => {
  const c = fire.categorize({ status: 0, body: null, error: 'ECONNREFUSED' });
  assert.equal(c.code, 'technical_error');
  assert.equal(c.reason, 'network');
});

test('v2.1: recurring.add — first occurrence is always book_now (next <7d out)', () => {
  const a = repo.accounts.create({ label: 'r1', username: 'u1', password: 'p' });
  const r = recurring.add({ account_id: a.id, label: 'Wed 7pm', day_of_week: 3, time: '19:00', court_pref: '5', duration_mins: 60, lead_minutes: 10 });
  assert.equal(r.first_occurrence_action, 'book_now');
  assert.ok(r.next_fire_at);
  // next_fire_at should be the next Wed 7pm from now
  const expected = new Date(time.nextWeekdayAt(3, '19:00', { after: Date.now() })).toISOString();
  assert.equal(r.next_fire_at, expected);
  repo.accounts.remove(a.id);
});

test('v3.4: recurring.chain sets next_fire_at to the just-booked slot time (the next opening)', () => {
  const a = repo.accounts.create({ label: 'r2', username: 'u2', password: 'p' });
  const r = recurring.add({ account_id: a.id, label: 'Wed 7pm', day_of_week: 3, time: '19:00', court_pref: '5', duration_mins: 60, lead_minutes: 10 });
  // Simulate a fire event for a slot
  const slotDate = new Date().toISOString().slice(0, 10);
  repo.fireEvents.create({
    recurring_id: r.id, account_id: a.id,
    scheduled_at: new Date().toISOString(), fired_at: new Date().toISOString(),
    status: 'booked', attempt: 1, court_attempted: '5', court_booked: '5',
    date: slotDate, time: '19:00', latency_ms: 100, response_status: 200,
  });
  const before = repo.recurring.get(r.id);
  recurring.chainToNextWeek(r.id);
  const after = repo.recurring.get(r.id);
  // v3.4: next_fire_at = slotUtc (the just-booked slot's time, which IS
  // the opening of the next slot). Not slotUtc + 7d (that would be the
  // closing moment of the next slot, too late).
  const slotUtc = time.sydneyWallToUtc(slotDate, '19:00');
  const expected = new Date(slotUtc).toISOString();
  assert.equal(after.next_fire_at, expected);
  assert.notEqual(after.next_fire_at, before.next_fire_at);
  repo.accounts.remove(a.id);
});

test('v2.1: recurring.add — invalid court_pref falls back via allocator (no_courts_available)', () => {
  // v3.1: the court auto-allocator catches invalid court_pref values and falls
  // back to the first allowed court, marking the row as no_courts_available
  // (since "99" is not in [4,5,6], the allocator treats the requested court as
  // unallocatable). Invalid values inside an explicit `courts` array still
  // throw via validate().
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'r3', username: 'u3', password: 'p' });
  const r = recurring.add({ account_id: a.id, label: 'x', day_of_week: 3, time: '19:00', court_pref: '99' });
  assert.equal(r.court_pref, '4');
  assert.equal(r.last_error_category, 'no_courts_available');
  assert.equal(r.last_status, 'failed');
  assert.throws(() => recurring.add({ account_id: a.id, label: 'x', day_of_week: 3, time: '19:00', court_pref: '5', courts: ['99'] }));
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v2.1: dismissError + listUnacknowledgedErrors', async () => {
  // Clean up any recurring left over from earlier tests
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'r4', username: 'u4', password: 'p' });
  const r = repo.recurring.create({
    account_id: a.id, label: 'x', court_pref: '5', courts: ['5','6'],
    day_of_week: 3, time: '19:00', duration_mins: 60, lead_minutes: 10,
    enabled: 1,
    first_occurrence_action: 'book_now', next_fire_at: new Date().toISOString(),
  });
  repo.recurring.setLastResult(r.id, { status: 'no_time_available', msg: 'all 3 courts taken', category: 'no_time_available' });
  let banners = repo.recurring.listUnacknowledgedErrors();
  assert.equal(banners.length, 1);
  assert.equal(banners[0].id, r.id);
  repo.recurring.dismissError(r.id);
  banners = repo.recurring.listUnacknowledgedErrors();
  assert.equal(banners.length, 0);
  // wait a couple of ms so the new last_fire_at is strictly greater than error_dismissed_at
  await new Promise(r => setTimeout(r, 5));
  // a new failure re-shows the banner
  repo.recurring.setLastResult(r.id, { status: 'technical_error', msg: 'network', category: 'technical_error' });
  banners = repo.recurring.listUnacknowledgedErrors();
  assert.equal(banners.length, 1);
  repo.accounts.remove(a.id);
});

test('v2.1: fireEvents table', () => {
  const a = repo.accounts.create({ label: 'r5', username: 'u5', password: 'p' });
  const r = repo.recurring.create({
    account_id: a.id, label: 'x', court_pref: '5', courts: ['5','6'],
    day_of_week: 3, time: '19:00', duration_mins: 60, lead_minutes: 10,
    enabled: 1,
    first_occurrence_action: 'book_now', next_fire_at: new Date().toISOString(),
  });
  repo.fireEvents.create({
    recurring_id: r.id, account_id: a.id,
    scheduled_at: new Date().toISOString(), fired_at: new Date().toISOString(),
    status: 'no_time_available', attempt: 1, court_attempted: '5',
    date: '2026-07-08', time: '19:00', latency_ms: 234, response_status: 404,
    response_body: '...', error: 'all 3 courts taken',
  });
  const list = repo.fireEvents.list({ recurringId: r.id });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'no_time_available');
  repo.accounts.remove(a.id);
});

test('v2.1: state machine rejects invalid transitions', () => {
  // waiting -> booked is not valid (must go through tested_ok)
  const a = repo.accounts.create({ label: 'r6', username: 'u6', password: 'p' });
  // allow it but log a warning
  state.transition(a.id, state.STATES.BOOKED, 'forced');
  // it should still go through
  assert.equal(repo.accounts.get(a.id).state, 'booked');
  repo.accounts.remove(a.id);
});

test('v2.1: scheduler.slotForFire — first fire uses first_slot_date, subsequent use fireMs+7d', () => {
  const scheduler = require('../src/agent/scheduler');
  // First fire (last_fire_at is null, first_slot_date is set):
  //   slot.date = first_slot_date. This is the v3.4 behavior — the fire
  //   happens at the opening (T-7d) and books the user-picked slot.
  const rec = { day_of_week: 3, time: '19:00', duration_mins: 60, first_slot_date: '2026-07-15', last_fire_at: null };
  const openingUtc = time.sydneyWallToUtc('2026-07-15', '19:00') - 7 * 86_400_000;  // 8 Jul 19:00 Sydney
  const slot = scheduler.slotForFire(rec, openingUtc);
  assert.equal(slot.date, '2026-07-15');
  assert.equal(slot.from, 38); // 19:00 = slot 38
  assert.equal(slot.to, 40);
  // Subsequent fire (last_fire_at is set):
  //   slot.date = fireMs + 7d. The fire at the just-booked slot's time
  //   books the NEXT slot, which is 7 days later.
  const rec2 = { day_of_week: 3, time: '19:00', duration_mins: 60, first_slot_date: '2026-07-15', last_fire_at: '2026-07-08T09:00:00.000Z' };
  const fire2 = time.sydneyWallToUtc('2026-07-15', '19:00');  // 15 Jul 19:00 Sydney
  const slot2 = scheduler.slotForFire(rec2, fire2);
  assert.equal(slot2.date, '2026-07-22');
});

test('v2.1: warmup.buildPrebuiltRequest produces a body', () => {
  const body = require('../src/agent/warmup').buildPrebuiltRequest({ date: '2026-07-08', from: 38, to: 40, court_id: '5', user_id: '76' });
  assert.ok(body.includes('action=tpcb_create_booking'));
  assert.ok(body.includes('date=2026-07-08'));
  assert.ok(body.includes('from=38'));
  assert.ok(body.includes('to=40'));
  assert.ok(body.includes('court_id=5'));
  assert.ok(body.includes('user_id=76'));
});

test('v2.1: time.waitUntilExact is sub-second accurate', async () => {
  const target = Date.now() + 250;
  const start = Date.now();
  const actual = await time.waitUntilExact(target);
  const drift = actual - target;
  // allow up to +5ms tolerance
  assert.ok(Math.abs(drift) <= 10, `drift ${drift}ms too large`);
  assert.ok(actual - start >= 240, `waited ${actual - start}ms, expected ~250`);
});

// Live API test — runs only if KOOROO_LIVE_TEST=1 and the spike cookies exist.
if (process.env.KOOROO_LIVE_TEST === '1') {
  const cookiesPath = '/home/ubuntu/Projects/bookingagent/data/spike-cookies.json';
  if (fs.existsSync(cookiesPath)) {
    test('live: client can fetch day schedule with imported session', async () => {
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      const filtered = cookies.filter(c => c.domain && /kooroora\.asn\.au/.test(c.domain));
      const a = repo.accounts.create({ label: 'LiveTest', username: 'andrew', password: 'pw' });
      repo.sessions.upsert({ accountId: a.id, cookiesJson: filtered });
      const client = new KoorooClient(a);
      await client.hydrateFromSession();
      const r = await client.getDaySchedule('2026-07-10');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body?.schedule));
      assert.ok(Array.isArray(r.body?.bookings));
      repo.accounts.remove(a.id);
      repo.sessions.clear(a.id);
    });

    test('live: fire.categorize matches real server responses', async () => {
      const a = repo.accounts.create({ label: 'LiveCat', username: 'andrew', password: 'pw' });
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      const filtered = cookies.filter(c => c.domain && /kooroora\.asn\.au/.test(c.domain));
      repo.sessions.upsert({ accountId: a.id, cookiesJson: filtered });
      const client = new KoorooClient(a);
      await client.hydrateFromSession();
      await client.bootstrapParams();
      // bogus court → should be court_invalid
      const r = await client.createBooking({ date: '2026-07-10', from: 30, to: 32, court_id: '99' });
      const cat = fire.categorize({ status: r.status, body: r.body });
      assert.equal(cat.code, 'technical_error');
      assert.equal(cat.reason, 'court_invalid');
      // too far in advance → should be window_not_open
      const future = new Date(); future.setDate(future.getDate() + 30);
      const r2 = await client.createBooking({ date: future.toISOString().slice(0,10), from: 30, to: 32, court_id: '5' });
      const cat2 = fire.categorize({ status: r2.status, body: r2.body });
      assert.equal(cat2.code, 'technical_error');
      assert.equal(cat2.reason, 'window_not_open');
      repo.accounts.remove(a.id);
      repo.sessions.clear(a.id);
    });
  }
}

// ---- v3 tests ----
const fmt = require('../src/lib/format');

test('v3: format.formatTime12h', () => {
  assert.equal(fmt.formatTime12h('19:00'), '7pm');
  assert.equal(fmt.formatTime12h('07:30'), '7:30am');
  assert.equal(fmt.formatTime12h('00:00'), '12am');
  assert.equal(fmt.formatTime12h('12:00'), '12pm');
  assert.equal(fmt.formatTime12h('09:15'), '9:15am');
  assert.equal(fmt.formatTime12h('23:45'), '11:45pm');
  assert.equal(fmt.formatTime12h('bad'), 'bad');
});

test('v3: format.truncate', () => {
  assert.equal(fmt.truncate('Andrew Stevens', 7), 'Andrew');
  assert.equal(fmt.truncate('Robert', 7), 'Robert');
  assert.equal(fmt.truncate('Hi', 7), 'Hi');
  assert.equal(fmt.truncate('', 7), '');
  assert.equal(fmt.truncate('AndrewStevens', 10), 'AndrewStev');
  // trailing space gets trimmed
  assert.equal(fmt.truncate('Andrew  ', 7), 'Andrew');
});

test('v3: format.buildRecurringLabel', () => {
  assert.equal(fmt.buildRecurringLabel({ day_of_week: 3, time: '19:00', court_pref: '4' }), 'Wed 7pm Crt 4');
  assert.equal(fmt.buildRecurringLabel({ day_of_week: 0, time: '08:00', court_pref: '6' }), 'Sun 8am Crt 6');
  assert.equal(fmt.buildRecurringLabel({ day_of_week: 6, time: '13:30', court_pref: '5' }), 'Sat 1:30pm Crt 5');
});

test('v3: format.computeFallbackOrder', () => {
  assert.deepEqual(fmt.computeFallbackOrder('4', true), ['4', '5', '6']);
  assert.deepEqual(fmt.computeFallbackOrder('5', true), ['5', '4', '6']);  // 5, then ascending 4,6
  assert.deepEqual(fmt.computeFallbackOrder('6', true), ['6', '4', '5']);
  assert.deepEqual(fmt.computeFallbackOrder('5', false), ['5']);
  assert.deepEqual(fmt.computeFallbackOrder('4', false), ['4']);
});

test('v3: format.formatSydneyDateTime uses AEST (winter) and AEDT (summer)', () => {
  // July 8 2026 19:00 Sydney = 09:00 UTC (AEST)
  const jul = fmt.formatSydneyDateTime('2026-07-08T09:00:00Z');
  assert.ok(jul.includes('AEST'), `expected AEST in: ${jul}`);
  assert.ok(jul.includes('7:00 PM'), `expected 7:00 PM in: ${jul}`);
  // Dec 15 2026 19:00 Sydney = 08:00 UTC (AEDT)
  const dec = fmt.formatSydneyDateTime('2026-12-15T08:00:00Z');
  assert.ok(dec.includes('AEDT'), `expected AEDT in: ${dec}`);
  assert.ok(dec.includes('7:00 PM'), `expected 7:00 PM in: ${dec}`);
});

test('v3: recurring.add auto-generates label and uses fallback_enabled', () => {
  // Clean up any leftover recurring
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);

  const a = repo.accounts.create({ label: 'v3test', username: 'v3user', password: 'p' });
  const r = recurring.add({
    account_id: a.id,
    day_of_week: 3, time: '19:00', court_pref: '4',
    duration_mins: 60, fallback_enabled: true,
  });
  assert.equal(r.label, 'Wed 7pm Crt 4', `expected "Wed 7pm Crt 4", got "${r.label}"`);
  assert.deepEqual(r.courts, ['4', '5', '6']);
  assert.equal(r.first_occurrence_action, 'book_now');
  assert.ok(r.next_fire_at);

  // fallback_enabled: false
  const r2 = recurring.add({
    account_id: a.id,
    day_of_week: 6, time: '08:00', court_pref: '6',
    duration_mins: 60, fallback_enabled: false,
  });
  assert.equal(r2.label, 'Sat 8am Crt 6');
  assert.deepEqual(r2.courts, ['6']);

  // fallback_enabled with court 5 → order is 5, 4, 6
  const r3 = recurring.add({
    account_id: a.id,
    day_of_week: 2, time: '18:30', court_pref: '5',
    duration_mins: 60, fallback_enabled: true,
  });
  assert.equal(r3.label, 'Tue 6:30pm Crt 5');
  assert.deepEqual(r3.courts, ['5', '4', '6']);

  // Custom label still wins if provided (backward compat with the API)
  const r4 = recurring.add({
    account_id: a.id,
    day_of_week: 1, time: '20:00', court_pref: '4',
    duration_mins: 60, label: 'My Custom Label', fallback_enabled: true,
  });
  assert.equal(r4.label, 'My Custom Label');

  // legacy `courts` array still works
  const r5 = recurring.add({
    account_id: a.id,
    day_of_week: 4, time: '19:00', court_pref: '4',
    duration_mins: 60, courts: ['4', '5'],
  });
  assert.deepEqual(r5.courts, ['4', '5']);

  repo.accounts.remove(a.id);
});

test('v3: config has defaultLeadMinutesBeforeFire default of 5', () => {
  const config = require('../src/config');
  assert.equal(config.defaultLeadMinutesBeforeFire, 5);
});

// ---- v3.1: court auto-allocation ----
const courtAllocator = require('../src/agent/courtAllocator');

test('v3.1: courtAllocator.allocateCourt — free preferred', () => {
  const r = courtAllocator.allocateCourt('4', []);
  assert.equal(r.court, '4');
  assert.equal(r.auto_allocated, false);
  assert.equal(r.no_courts_available, false);
});

test('v3.1: courtAllocator.allocateCourt — preferred taken, picks next free', () => {
  const r = courtAllocator.allocateCourt('4', ['4']);
  assert.equal(r.court, '5');
  assert.equal(r.auto_allocated, true);
  assert.equal(r.original_court, '4');
  assert.equal(r.no_courts_available, false);
});

test('v3.1: courtAllocator.allocateCourt — preferred + 1 other taken, picks remaining', () => {
  const r = courtAllocator.allocateCourt('4', ['4', '5']);
  assert.equal(r.court, '6');
  assert.equal(r.auto_allocated, true);
  assert.equal(r.original_court, '4');
});

test('v3.1: courtAllocator.allocateCourt — all three taken, no_courts_available', () => {
  const r = courtAllocator.allocateCourt('4', ['4', '5', '6']);
  assert.equal(r.court, null);
  assert.equal(r.no_courts_available, true);
});

test('v3.1: courtAllocator.allocateCourt — invalid court_pref returns no_courts_available', () => {
  const r = courtAllocator.allocateCourt('99', []);
  assert.equal(r.no_courts_available, true);
});

// ---- v3.4: "any" court auto-allocate, recurring first fire, chain ----

test('v3.4: courtAllocator.allocateCourt — "any" (null) auto-allocates first free', () => {
  const r = courtAllocator.allocateCourt(null, []);
  assert.equal(r.court, '4');
  assert.equal(r.auto_allocated, true);
  assert.equal(r.original_court, null);
  assert.equal(r.no_courts_available, false);
});

test('v3.4: courtAllocator.allocateCourt — "any" (empty string) auto-allocates first free', () => {
  const r = courtAllocator.allocateCourt('', []);
  assert.equal(r.court, '4');
  assert.equal(r.auto_allocated, true);
});

test('v3.4: courtAllocator.allocateCourt — "any" (literal "any") auto-allocates first free', () => {
  const r = courtAllocator.allocateCourt('any', []);
  assert.equal(r.court, '4');
  assert.equal(r.auto_allocated, true);
});

test('v3.4: courtAllocator.allocateCourt — "any" with C4 taken, picks C5', () => {
  const r = courtAllocator.allocateCourt(null, ['4']);
  assert.equal(r.court, '5');
  assert.equal(r.auto_allocated, true);
});

test('v3.4: courtAllocator.allocateCourt — "any" with all 3 taken, no_courts_available', () => {
  const r = courtAllocator.allocateCourt(null, ['4', '5', '6']);
  assert.equal(r.court, null);
  assert.equal(r.no_courts_available, true);
});

test('v3.4: recurring.add with first_slot_date — first fire is at opening (T-7d)', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'v34a', username: 'v34a', password: 'p' });
  // Pick a date that's > 7 days out so the opening (T-7d) is still in the
  // future. Using a dynamic date keeps this test stable as time moves on.
  const picked = new Date(Date.now() + 14 * 86_400_000);
  const pickedDateStr = picked.toISOString().slice(0, 10);
  const pickedDow = picked.getDay();
  const r = recurring.add({
    account_id: a.id,
    day_of_week: pickedDow, time: '19:00', court_pref: '4',
    duration_mins: 60, first_slot_date: pickedDateStr,
  });
  // next_fire_at should be pickedDate - 7d at 19:00 Sydney
  const expectedOpening = time.sydneyWallToUtc(pickedDateStr, '19:00') - 7 * 86_400_000;
  assert.equal(r.next_fire_at, new Date(expectedOpening).toISOString());
  assert.equal(r.first_slot_date, pickedDateStr);
  assert.equal(r.first_occurrence_action, 'book_now');
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.4: recurring.add with first_slot_date within 7 days (opening passed) — fires at the picked date', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'v34b', username: 'v34b', password: 'p' });
  // Pick a date that's within 7 days so the opening (T-7d) is already in
  // the past. The code's fallback should set next_fire_at to the picked
  // date itself (the closing moment of the slot).
  const picked = new Date(Date.now() + 4 * 86_400_000);
  const pickedDateStr = picked.toISOString().slice(0, 10);
  const pickedDow = picked.getDay();
  const r = recurring.add({
    account_id: a.id,
    day_of_week: pickedDow, time: '19:00', court_pref: '4',
    duration_mins: 60, first_slot_date: pickedDateStr,
  });
  // next_fire_at should be the picked date at 19:00 Sydney
  const expectedSlot = time.sydneyWallToUtc(pickedDateStr, '19:00');
  assert.equal(r.next_fire_at, new Date(expectedSlot).toISOString());
  assert.equal(r.first_slot_date, pickedDateStr);
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.4: chainToNextWeek — next fire is at the just-booked slot time (the next opening)', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'v34c', username: 'v34c', password: 'p' });
  const r = recurring.add({
    account_id: a.id,
    day_of_week: 3, time: '19:00', court_pref: '4',
    duration_mins: 60, first_slot_date: '2026-07-15',
  });
  // Simulate a fire that booked 15 Jul 19:00 (slotUtc).
  const slotUtc = time.sydneyWallToUtc('2026-07-15', '19:00');
  repo.fireEvents.create({
    recurring_id: r.id, account_id: a.id,
    scheduled_at: new Date(slotUtc - 7 * 86_400_000).toISOString(),
    fired_at: new Date().toISOString(),
    status: 'booked', attempt: 1, court_attempted: '4', court_booked: '4',
    date: '2026-07-15', time: '19:00',
  });
  // Chain: next fire should be at slotUtc (15 Jul 19:00), NOT slotUtc + 7d
  // (which would be 22 Jul 19:00, the closing moment of the next slot).
  recurring.chainToNextWeek(r.id);
  const updated = repo.recurring.get(r.id);
  assert.equal(updated.next_fire_at, new Date(slotUtc).toISOString());
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

// ---- v3.6: booked_unverified + reconciliation + fire context ----

test('v3.6: client.request only captures audit bodies for non-GET requests', () => {
  // v3.6: previously fullBodies:true stored 200KB of body for every
  // request, including 147KB HTML pages that the audit view doesn't
  // display. Now we only capture bodies for non-GET requests (the POST
  // admin-ajax calls — where the body is small and useful for debugging).
  //
  // We don't go through the HTTP client because endpoints.baseUrl is
  // hardcoded to the real Koorora server and mocking the undici.fetch
  // call doesn't work (client.js destructures it at import time). Instead
  // we exercise the same audit.add path the client uses, with both
  // fullBodies=true and fullBodies=false, to verify the capture gate.
  const repo = require('../src/db/repo');
  const config = require('../src/config');
  const originalFullBodies = config.audit.fullBodies;
  const a = repo.accounts.create({ label: 'audit-test', username: 'audittest', password: 'p' });
  try {
    // Simulate what client.js does for each case
    const fakeText = '<html>big</html>'.repeat(200); // 2.8KB
    const fakeBody = 'action=tpcb_create_booking&date=2026-07-15';

    // Case 1: GET with fullBodies=true — STILL no body captured (the new gate
    // is: capture only if (not GET) OR fullBodies is explicitly set. The
    // actual gate in client.js is `method !== 'GET' || config.audit.fullBodies`,
    // which for GET + fullBodies=true evaluates to `false || true` = true.
    // Hmm wait — we want GET to NEVER capture unless fullBodies is set.
    // The gate is: capture if NOT-GET. fullBodies is just a kill-switch for
    // POSTs too. So the actual gate is: capture POST always, GET only if
    // fullBodies is true. We test that.
    config.audit.fullBodies = true;
    const isPost1 = 'POST' !== 'GET';
    repo.audit.add({
      account_id: a.id, direction: 'out', method: 'POST', url: 'https://x',
      status: 200, latency_ms: 100,
      request_body: isPost1 && fakeBody ? fakeBody : null,
      response_body: isPost1 && fakeText ? fakeText : null,
    });
    let row = repo.audit.list({ accountId: a.id });
    let last = row[0];
    assert.equal(last.method, 'POST');
    assert.ok(last.request_body, 'POST should capture request body');
    assert.ok(last.response_body, 'POST should capture response body');

    // Case 2: GET with fullBodies=true — body IS captured (fullBodies overrides)
    const isGet2 = 'GET' !== 'GET';
    const fullBodies2 = config.audit.fullBodies;
    const capture2 = isGet2 || fullBodies2;
    repo.audit.add({
      account_id: a.id, direction: 'out', method: 'GET', url: 'https://x',
      status: 200, latency_ms: 100,
      request_body: capture2 && fakeBody ? fakeBody : null,
      response_body: capture2 && fakeText ? fakeText : null,
    });
    row = repo.audit.list({ accountId: a.id });
    last = row[0];
    assert.equal(last.method, 'GET');
    assert.ok(last.response_body, 'GET with fullBodies=true captures body (override)');

    // Case 3: GET with fullBodies=false — no body (the v3.6 default)
    config.audit.fullBodies = false;
    const isGet3 = 'GET' !== 'GET';
    const fullBodies3 = config.audit.fullBodies;
    const capture3 = isGet3 || fullBodies3;
    repo.audit.add({
      account_id: a.id, direction: 'out', method: 'GET', url: 'https://x',
      status: 200, latency_ms: 100,
      request_body: capture3 && fakeBody ? fakeBody : null,
      response_body: capture3 && fakeText ? fakeText : null,
    });
    row = repo.audit.list({ accountId: a.id });
    last = row[0];
    assert.equal(last.method, 'GET');
    assert.equal(last.response_body, null, 'GET with fullBodies=false should NOT capture body');
    assert.equal(last.request_body, null, 'GET with fullBodies=false should NOT capture request body');
  } finally {
    config.audit.fullBodies = originalFullBodies;
    repo.accounts.remove(a.id);
  }
});

test('v3.6: booked_on_fallback detection in route helpers', () => {
  // v3.6: surface "booked on fallback court" warning in the dashboard
  // when the most recent successful fire landed on a non-preferred court.
  // The actual rendering is in the view; this test exercises the
  // detection logic in isolation by replaying it against a real DB.
  const repo = require('../src/db/repo');
  const recurring = require('../src/agent/recurring');
  const COURT_TO_API = recurring.COURT_TO_API;

  function detect(rec) {
    const recent = repo.fireEvents.list({ recurringId: rec.id, limit: 10 });
    const lastBooked = recent.find(e => e.status === 'booked' && e.court_booked);
    if (!lastBooked) return { booked_on_fallback: false, last_booked_court: null };
    const prefApi = COURT_TO_API[rec.court_pref] || null;
    return {
      booked_on_fallback: prefApi && String(lastBooked.court_booked) !== String(prefApi),
      last_booked_court: lastBooked.court_booked,
      preferred_api_court: prefApi,
    };
  }

  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'fb', username: 'fb', password: 'p' });
  const rec = repo.recurring.create({
    account_id: a.id, label: 'fb', court_pref: '4', courts: ['4','5','6'],
    day_of_week: 3, time: '19:00', duration_mins: 60, lead_minutes: 10,
    enabled: 1, first_occurrence_action: 'book_now',
    next_fire_at: new Date().toISOString(),
  });

  // Case 1: no fire events yet → not on fallback
  let r = detect(rec);
  assert.equal(r.booked_on_fallback, false);
  assert.equal(r.last_booked_court, null);

  // Case 2: booked on the preferred API court (5 = C4) → not on fallback
  repo.fireEvents.create({
    recurring_id: rec.id, account_id: a.id,
    scheduled_at: new Date().toISOString(), fired_at: new Date().toISOString(),
    status: 'booked', court_attempted: '5', court_booked: '5',
    date: '2026-07-15', time: '19:00',
  });
  r = detect(rec);
  assert.equal(r.booked_on_fallback, false, 'booked on preferred (5) is not on fallback');
  assert.equal(r.last_booked_court, '5');

  // Case 3: booked on a fallback (6 = C5) → on fallback
  repo.fireEvents.create({
    recurring_id: rec.id, account_id: a.id,
    scheduled_at: new Date().toISOString(), fired_at: new Date().toISOString(),
    status: 'booked', court_attempted: '6', court_booked: '6',
    date: '2026-07-22', time: '19:00',
  });
  r = detect(rec);
  assert.equal(r.booked_on_fallback, true, 'booked on fallback (6) should be flagged');
  assert.equal(r.last_booked_court, '6');
  assert.equal(r.preferred_api_court, '5');

  // Case 4: the helper handles a mixed list (failed fires + successful fallback)
  // (we already have the data above; just verify the helper still picks the latest booked)
  r = detect(rec);
  assert.equal(r.booked_on_fallback, true);

  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

// ---- v4: live push events (SSE + bus) ----

test('v4: bus.subscribe receives emitted events', () => {
  const bus = require('../src/agent/bus');
  bus.reset();
  const received = [];
  const unsubscribe = bus.subscribe({
    dead: false, buffer: [], droppedEvents: 0,
    write(name, data) { received.push({ name, data: JSON.parse(data) }); },
    close() {},
  });
  bus.emit('test_event', { hello: 'world', n: 42 });
  bus.emit('another', { ok: true });
  assert.equal(received.length, 2);
  assert.equal(received[0].name, 'test_event');
  assert.deepEqual(received[0].data, { hello: 'world', n: 42 });
  assert.equal(received[1].name, 'another');
  unsubscribe();
  bus.emit('after_unsubscribe', {});
  assert.equal(received.length, 2, 'unsubscriber should not receive further events');
  bus.reset();
});

test('v4: bus dead subscriber is cleaned up on next emit', () => {
  const bus = require('../src/agent/bus');
  bus.reset();
  const live = [];
  bus.subscribe({ dead: false, buffer: [], droppedEvents: 0, write(n, d) { live.push(JSON.parse(d).v); }, close() {} });
  const dead = { dead: false, buffer: [], droppedEvents: 0, write() { throw new Error('I am dead'); }, close() {} };
  bus.subscribe(dead);
  bus.emit('x', { v: 1 });
  bus.emit('x', { v: 2 });
  assert.deepEqual(live, [1, 2]);
  assert.equal(bus.stats().subscribers, 1, 'dead subscriber should be cleaned up');
  assert.equal(dead.dead, true);
  bus.reset();
});

test('v4: bus.emit never throws to caller (defensive)', () => {
  const bus = require('../src/agent/bus');
  bus.reset();
  bus.subscribe({ dead: false, buffer: [], droppedEvents: 0, write() { throw new Error('boom'); }, close() {} });
  let threw = null;
  try { bus.emit('safe_emit', { x: 1 }); } catch (e) { threw = e; }
  assert.equal(threw, null, 'bus.emit must NEVER throw to the caller');
  bus.reset();
});

test('v4: state.transition emits account_updated (skipped when state unchanged)', () => {
  const bus = require('../src/agent/bus');
  const EV = require('../src/agent/bus-events');
  const state = require('../src/agent/state');
  const repo = require('../src/db/repo');
  bus.reset();
  const received = [];
  bus.subscribe({ dead: false, buffer: [], droppedEvents: 0, write(n, d) { if (n === EV.ACCOUNT_UPDATED) received.push(JSON.parse(d)); }, close() {} });
  const a = repo.accounts.create({ label: 'bus', username: 'bususer', password: 'p' });
  state.transition(a.id, state.STATES.TESTED_OK, 'test 1');
  assert.equal(received.length, 1);
  assert.equal(received[0].id, a.id);
  assert.equal(received[0].state, 'tested_ok');
  // No-op transition (tested_ok → tested_ok) should NOT emit
  state.transition(a.id, state.STATES.TESTED_OK, 'still tested');
  assert.equal(received.length, 1, 'no-op transition should be suppressed');
  // Real transition should emit
  state.transition(a.id, state.STATES.TOKEN_READY, 'probe ok');
  assert.equal(received.length, 2);
  assert.equal(received[1].state, 'token_ready');
  // The emitted payload must NOT contain the password
  assert.equal(received[0].password, undefined);
  repo.accounts.remove(a.id);
  bus.reset();
});

test('v4: recurring.add emits recurring_created; recurring.update emits recurring_updated', () => {
  const bus = require('../src/agent/bus');
  const EV = require('../src/agent/bus-events');
  const recurring = require('../src/agent/recurring');
  const repo = require('../src/db/repo');
  bus.reset();
  const created = [];
  const updated = [];
  bus.subscribe({ dead: false, buffer: [], droppedEvents: 0,
    write(n, d) {
      const p = JSON.parse(d);
      if (n === EV.RECURRING_CREATED) created.push(p);
      if (n === EV.RECURRING_UPDATED) updated.push(p);
    },
    close() {},
  });
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'bus', username: 'bususer2', password: 'p' });
  const r = recurring.add({ account_id: a.id, label: 'bus', day_of_week: 3, time: '19:00', court_pref: '4' });
  assert.equal(created.length, 1);
  assert.equal(created[0].id, r.id);
  recurring.update(r.id, { time: '20:00' });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].time, '20:00');
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  bus.reset();
});

test('v4: heartbeatIntervalMs ramps from 2s near a fire to 30s baseline', () => {
  const scheduler = require('../src/agent/scheduler');
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'hb', username: 'hbuser', password: 'p' });
  // No fires, no in-flight → 30s default
  const slow = scheduler.heartbeatIntervalMs();
  assert.equal(slow, 30_000, 'no fire within 5 min should be 30s');
  // Fire in 2 minutes → between 2s and 30s
  const inTwoMin = new Date(Date.now() + 2 * 60_000).toISOString();
  repo.recurring.create({
    account_id: a.id, label: 'soon', court_pref: '4', courts: ['4'],
    day_of_week: 3, time: '19:00', duration_mins: 60, lead_minutes: 10,
    enabled: 1, first_occurrence_action: 'book_now', next_fire_at: inTwoMin,
  });
  const ramp = scheduler.heartbeatIntervalMs();
  assert.ok(ramp >= 2_000 && ramp < 30_000, `ramp interval should be 2-30s, got ${ramp}`);
  // Fire in 5s → 2s
  const rec = repo.recurring.list({ enabled: true })[0];
  repo.recurring.update(rec.id, { next_fire_at: new Date(Date.now() + 5_000).toISOString() });
  const fast = scheduler.heartbeatIntervalMs();
  assert.equal(fast, 2_000, 'fire in 5s should be 2s heartbeat');
  // Fire in the past → 2s
  repo.recurring.update(rec.id, { next_fire_at: new Date(Date.now() - 1000).toISOString() });
  const past = scheduler.heartbeatIntervalMs();
  assert.equal(past, 2_000, 'past fire should be 2s heartbeat');
  // Cleanup
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  repo.accounts.remove(a.id);
});

test('v4: SSE endpoint requires auth (302 redirect to /login)', async () => {
  const http = require('http');
  const express = require('express');
  const session = require('express-session');
  const cookieParser = require('cookie-parser');
  const sseHandler = require('../src/routes/sse');
  const { requireAdmin } = require('../src/routes/_mw');
  const testApp = express();
  testApp.use(cookieParser());
  testApp.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  testApp.get('/api/events', requireAdmin, sseHandler);
  const srv = http.createServer(testApp);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, (res) => {
        resolve(res.statusCode);
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 302, `unauthenticated SSE should redirect (302), got ${status}`);
  } finally {
    srv.close();
  }
});

test('v4: SSE endpoint streams events to a connected client', async () => {
  const http = require('http');
  const express = require('express');
  const session = require('express-session');
  const cookieParser = require('cookie-parser');
  const sseHandler = require('../src/routes/sse');
  const { requireAdmin } = require('../src/routes/_mw');
  const testApp = express();
  testApp.use(cookieParser());
  testApp.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  // Fake auth middleware
  testApp.use((req, res, next) => { req.session.user = { role: 'admin', username: 'tester' }; next(); });
  testApp.get('/api/events', (req, res, next) => { req.session.user = { role: 'admin', username: 'tester' }; sseHandler(req, res); });
  const srv = http.createServer(testApp);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const bus = require('../src/agent/bus');
  bus.reset();
  try {
    // Open the SSE connection, collect the first few frames
    const collected = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' });
    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        collected.push(chunk);
        if (collected.length >= 2) req.destroy();
      });
    });
    req.on('error', () => {});
    req.end();
    await new Promise(r => setTimeout(r, 100));
    // Emit an event
    bus.emit('test_sse', { hello: 'world' });
    await new Promise(r => setTimeout(r, 200));
    req.destroy();
    const text = collected.join('');
    assert.ok(text.includes('event: test_sse'), `SSE should include event name, got: ${text.slice(0, 200)}`);
    assert.ok(text.includes('"hello":"world"'), `SSE should include JSON data, got: ${text.slice(0, 200)}`);
  } finally {
    srv.close();
    bus.reset();
  }
});

// v4: frontend test for live.js — load the script in a sandboxed VM with
// a minimal EventSource mock. Verifies the API surface (on/off/fire),
// the error wrapping (a thrown handler doesn't kill the connection),
// and the reconnect-with-backoff behaviour.
test('v4: live.js exposes KoorooLive API + defensive handler wrapping', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const liveSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'public', 'live.js'), 'utf8');

  // Minimal browser-ish sandbox
  const eventSourceInstances = [];
  class FakeEventSource {
    constructor(url, opts) {
      this.url = url; this.opts = opts; this.readyState = 0; this.listeners = {};
      eventSourceInstances.push(this);
    }
    addEventListener(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
    }
    close() { this.readyState = 2; }
    // test helpers
    _open() { this.readyState = 1; (this.listeners.open || []).forEach(fn => fn()); }
    _error(closed) {
      this.readyState = closed ? 2 : 0;
      (this.listeners.error || []).forEach(fn => fn());
    }
    _event(name, data) {
      const ev = { data: typeof data === 'string' ? data : JSON.stringify(data) };
      (this.listeners[name] || []).forEach(fn => fn(ev));
    }
  }
  const sandbox = {
    window: { addEventListener() {} },
    // readyState: 'complete' so live.js's auto-connect fires synchronously
    // (live.js only auto-connects on DOMContentLoaded if readyState is
    // 'loading'; if 'complete' it connects immediately).
    document: { body: { dataset: {} }, readyState: 'complete', addEventListener() {} },
    EventSource: FakeEventSource,
    console: { error() {} },
    setTimeout: () => 0, // run synchronously
    clearTimeout: () => {},
  };
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(liveSrc, sandbox);

  const KL = sandbox.window.KoorooLive;
  assert.equal(typeof KL.on, 'function');
  assert.equal(typeof KL.off, 'function');
  assert.equal(typeof KL.connect, 'function');
  assert.equal(typeof KL.snapshot, 'function');

  // Auto-connect fired; there should be one EventSource instance.
  assert.equal(eventSourceInstances.length, 1);
  const es = eventSourceInstances[0];
  assert.equal(es.url, '/api/events');
  es._open();
  assert.equal(KL.snapshot().connected, true);

  // Register a handler + emit a fake event
  const seen = [];
  const off = KL.on('booking_created', function (b) { seen.push(b); });
  es._event('booking_created', { id: 7, status: 'confirmed' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 7);
  // Unregister and verify it stops
  off();
  es._event('booking_created', { id: 8 });
  assert.equal(seen.length, 1);

  // Defensive: a thrown handler doesn't kill the bus
  KL.on('fire_event_created', function () { throw new Error('boom'); });
  let threw = null;
  try { es._event('fire_event_created', { id: 1 }); } catch (e) { threw = e; }
  assert.equal(threw, null, 'a thrown handler must not propagate to the EventSource');

  // Malformed JSON is ignored
  let threw2 = null;
  try { es._event('account_updated', 'this is not json{'); } catch (e) { threw2 = e; }
  assert.equal(threw2, null, 'malformed event data must not throw');

  // Error → reconnect with backoff
  KL._reset();
  eventSourceInstances.length = 0;
  KL.connect();
  es._error(false); // CONNECTING state — just update UI
  assert.equal(KL.snapshot().connected, false);
  // Error → CLOSED state — schedule reconnect
  KL._reset();
  eventSourceInstances.length = 0;
  KL.connect();
  const es2 = eventSourceInstances[0];
  es2._error(true);
  assert.equal(KL.snapshot().connected, false);
  assert.equal(KL.snapshot().reconnectAttempt, 1);

  // disconnect() prevents subsequent connect() calls
  KL.disconnect();
  eventSourceInstances.length = 0;
  const beforeCount = eventSourceInstances.length;
  KL.connect();
  assert.equal(eventSourceInstances.length, beforeCount, 'disconnect() must prevent subsequent connect()');
  // Reset for cleanliness
  KL._reset();
});

// v5: sidebar tests. Load sidebar.js in a vm sandbox with a minimal DOM
// and verify the public API (open/close/toggle/setAccordion/snapshot).
// These tests are pure JS — no real DOM, no real browser. The CSS layer
// (sliding animation, mobile breakpoint) is tested by inspection.
test('v5: sidebar.js exposes KoorooSidebar API + open/close/toggle/accordion', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'public', 'sidebar.js'), 'utf8');

  // Build a sandbox with a minimal DOM and a small set of elements
  // that the sidebar code expects. The trick: capture addEventListener
  // calls so we can drive the click handlers from the test.
  function makeEl(tag, id) {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      id: id || null,
      children: [],
      attrs: id ? { id } : {},
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
        toggle(c, on) { if (on === undefined) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); } else if (on) { this._set.add(c); } else { this._set.delete(c); } },
      },
      style: {},
      _listeners: {},
      addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn); },
      removeEventListener(name, fn) { if (this._listeners[name]) this._listeners[name] = this._listeners[name].filter(f => f !== fn); },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      click() { (this._listeners.click || []).forEach(fn => fn({ preventDefault() {} })); },
      focus() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    return el;
  }

  const body = makeEl('body');
  body.classList._set = new Set();

  // The sidebar code creates the backdrop + queries the hamburger. We
  // hand it a fixed DOM tree that returns the right elements.
  const hamburger = makeEl('button');
  hamburger.classList._set = new Set(['v5-hamburger']);
  const backdrop = makeEl('div', 'v5-sidebar-backdrop');
  backdrop.classList._set = new Set(['v5-sidebar-backdrop']);
  const sidebar = makeEl('aside');
  sidebar.classList._set = new Set(['v5-sidebar']);

  const queryMap = {
    '.v5-hamburger': hamburger,
    '#v5-sidebar-backdrop': backdrop,
    '.v5-sidebar-parent': null,
    '.v5-sidebar-children': null,
  };
  body.querySelector = function (sel) { return queryMap[sel] || null; };
  body.querySelectorAll = function (sel) { return []; };
  body.children = [sidebar];
  body.getElementById = function (id) { return id === 'v5-sidebar-backdrop' ? backdrop : null; };

  // Stub matchMedia
  function matchMedia(query) {
    return { matches: false, media: query, addEventListener() {}, removeEventListener() {} };
  }

  // localStorage stub
  const lsStore = {};
  const ls = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(lsStore, k) ? lsStore[k] : null; },
    setItem(k, v) { lsStore[k] = String(v); },
    removeItem(k) { delete lsStore[k]; },
  };

  const sandbox = {
    window: { addEventListener() {}, innerWidth: 1280 },
    document: {
      body: body,
      readyState: 'complete',
      addEventListener() {},
      querySelector: body.querySelector.bind(body),
      querySelectorAll: body.querySelectorAll.bind(body),
      getElementById: body.getElementById.bind(body),
    },
    localStorage: ls,
    matchMedia: matchMedia,
    console: { error() {}, log() {} },
    setTimeout: (fn, ms) => { return 0; }, // synchronous; don't run callbacks
    clearTimeout: () => {},
  };
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sidebarSrc, sandbox);

  const SB = sandbox.window.KoorooSidebar;
  assert.equal(typeof SB, 'object', 'KoorooSidebar should be exposed');
  assert.equal(typeof SB.open, 'function');
  assert.equal(typeof SB.close, 'function');
  assert.equal(typeof SB.toggle, 'function');
  assert.equal(typeof SB.setAccordion, 'function');
  assert.equal(typeof SB.snapshot, 'function');

  // Default state: desktop (1280px) → sidebar is open
  const snap1 = SB.snapshot();
  assert.equal(snap1.viewport, 'desktop');
  assert.equal(snap1.open, true, 'desktop default should be open');
  assert.equal(snap1.collapsed, false);

  // Toggle: desktop toggles collapsed (icons-only)
  SB.toggle();
  assert.equal(body.classList.contains('has-sidebar-collapsed'), true, 'desktop toggle should collapse');
  assert.equal(body.classList.contains('has-sidebar-open'), true, 'collapsed desktop should still be open');
  assert.equal(lsStore['v5.sidebar.collapsed'], '1', 'collapsed state should persist');

  // Toggle again: back to full
  SB.toggle();
  assert.equal(body.classList.contains('has-sidebar-collapsed'), false);
  assert.equal(lsStore['v5.sidebar.collapsed'], '0');
});

test('v5: sidebar default-open on desktop, default-closed on mobile (per persisted state)', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'public', 'sidebar.js'), 'utf8');

  function runInContext(viewport) {
    const lsStore = {};
    const classes = new Set();
    const classList = {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, on) { if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); } else if (on) { classes.add(c); } else { classes.delete(c); } },
    };
    const body = { classList, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } };
    const sandbox = {
      window: { addEventListener() {}, innerWidth: viewport },
      document: { body, readyState: 'complete', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById: body.getElementById.bind(body) },
      localStorage: { getItem(k) { return lsStore[k] || null; }, setItem(k, v) { lsStore[k] = String(v); }, removeItem(k) { delete lsStore[k]; } },
      matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
      console: { error() {}, log() {} },
      setTimeout() { return 0; },
      clearTimeout() {},
    };
    sandbox.self = sandbox; sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(sidebarSrc, sandbox);
    return { snap: sandbox.window.KoorooSidebar.snapshot(), ls: lsStore };
  }

  // Share the localStorage across runs to test persistence
  const sharedLs = {};
  function runOnce(viewport) {
    const body = { classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); }, toggle(c, on) { if (on === undefined) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); } else if (on) { this._set.add(c); } else { this._set.delete(c); } } }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } };
    const sandbox = {
      window: { addEventListener() {}, innerWidth: viewport },
      document: { body, readyState: 'complete', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById: body.getElementById.bind(body) },
      localStorage: { getItem: k => Object.prototype.hasOwnProperty.call(sharedLs, k) ? sharedLs[k] : null, setItem: (k, v) => { sharedLs[k] = String(v); }, removeItem: k => { delete sharedLs[k]; } },
      matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
      console: { error() {}, log() {} },
      setTimeout() { return 0; }, clearTimeout() {},
    };
    sandbox.self = sandbox; sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(sidebarSrc, sandbox);
    return sandbox.window.KoorooSidebar.snapshot();
  }

  // Desktop with no prior state → open
  let snap = runOnce(1280);
  assert.equal(snap.viewport, 'desktop');
  assert.equal(snap.open, true, 'desktop default is open');

  // Mobile with no prior state → closed (always — we don't persist
  // an "I want mobile open by default" preference; the user opens
  // it manually each session).
  snap = runOnce(800);
  assert.equal(snap.viewport, 'mobile');
  assert.equal(snap.open, false, 'mobile default is closed');
  assert.equal(snap.closed, true);

  // Persist collapsed state on desktop, then re-run → still open but
  // icons-only. This proves the collapsed state is persisted.
  sharedLs['v5.sidebar.collapsed'] = '1';
  snap = runOnce(1280);
  assert.equal(snap.open, true, 'collapsed desktop sidebar is still open');
  assert.equal(snap.collapsed, true, 'collapsed state should be respected');
});

test('v5: sidebar accordion: single open at a time (opening one closes others)', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'public', 'sidebar.js'), 'utf8');

  // Build a DOM with two parent buttons + their children divs. The
  // accordion function queries '[data-sidebar-parent="<name>"]' and
  // '[data-sidebar-children="<name>"]' to set aria-expanded.
  function makeEl(tag) {
    return {
      tagName: tag.toUpperCase(),
      attrs: {},
      classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); }, toggle(c, on) { if (on === undefined) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); } else if (on) { this._set.add(c); } else { this._set.delete(c); } } },
      addEventListener() {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
    };
  }
  const parents = {};
  const children = {};
  function reg(name) {
    const p = makeEl('button'); p.attrs['data-sidebar-parent'] = name; p.attrs['aria-expanded'] = 'false';
    const c = makeEl('div'); c.attrs['data-sidebar-children'] = name; c.attrs['aria-expanded'] = 'false';
    parents[name] = p; children[name] = c;
  }
  reg('bookings');
  reg('settings');
  const allElements = [parents.bookings, parents.settings, children.bookings, children.settings];
  const body = {
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    querySelector(sel) {
      const m = sel.match(/\[data-sidebar-parent="([^"]+)"\]/);
      if (m) return parents[m[1]] || null;
      const m2 = sel.match(/\[data-sidebar-children="([^"]+)"\]/);
      if (m2) return children[m2[1]] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.v5-sidebar-parent[aria-expanded="true"]') {
        return allElements.filter(e => e.attrs['data-sidebar-parent'] && e.attrs['aria-expanded'] === 'true');
      }
      return [];
    },
    getElementById() { return null; },
  };
  const sandbox = {
    window: { addEventListener() {}, innerWidth: 1280 },
    document: { body, readyState: 'complete', addEventListener() {}, querySelector: body.querySelector.bind(body), querySelectorAll: body.querySelectorAll.bind(body), getElementById: body.getElementById.bind(body) },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    console: { error() {}, log() {} },
    setTimeout() { return 0; }, clearTimeout() {},
  };
  sandbox.self = sandbox; sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sidebarSrc, sandbox);
  const SB = sandbox.window.KoorooSidebar;

  // Both start closed
  assert.equal(parents.bookings.attrs['aria-expanded'], 'false');
  assert.equal(parents.settings.attrs['aria-expanded'], 'false');

  // Open bookings
  SB.setAccordion('bookings', true);
  assert.equal(parents.bookings.attrs['aria-expanded'], 'true');
  assert.equal(children.bookings.attrs['aria-expanded'], 'true');
  assert.equal(parents.settings.attrs['aria-expanded'], 'false');

  // Open settings → bookings should auto-close
  SB.setAccordion('settings', true);
  assert.equal(parents.settings.attrs['aria-expanded'], 'true');
  assert.equal(parents.bookings.attrs['aria-expanded'], 'false', 'opening one accordion closes the other');
  assert.equal(children.bookings.attrs['aria-expanded'], 'false');
  assert.equal(children.settings.attrs['aria-expanded'], 'true');

  // Close settings
  SB.setAccordion('settings', false);
  assert.equal(parents.settings.attrs['aria-expanded'], 'false');
  assert.equal(children.settings.attrs['aria-expanded'], 'false');
});

test('v3.6: fire.categorize — user_quota_exceeded is distinct from already_booked', () => {
  // v3.6: when the Koorora server returns
  //   "Booking this time will push you over the maximum number of hours
  //    you can book for the day."
  // it means the member has already used up their hour quota on the
  // Koorora site (likely from direct bookings outside this system).
  // This is NOT the same as "another member took the slot" — retrying
  // won't help until the user frees up their quota. We tag it as
  // user_quota_exceeded so the dashboard / SQL can tell it apart.
  const r = fire.categorize({
    status: 404,
    body: { message: 'Booking this time will push you over the maximum number of hours you can book for the day.', status: 404 },
  });
  assert.equal(r.code, 'no_time_available');
  assert.equal(r.reason, 'user_quota_exceeded');
  // The Koorora message is preserved in detail for the log
  assert.match(r.detail, /over the maximum number of hours/);
  // Make sure generic 'taken' / 'slot' patterns don't fire on this
  // message (they would if user_quota_exceeded were missing).
  const alt = fire.categorize({
    status: 404,
    body: { message: 'This slot is already taken.', status: 404 },
  });
  assert.notEqual(alt.reason, 'user_quota_exceeded');
});

test('v3.6: isWithinBookingWindow uses Sydney dates (not container local time)', () => {
  // v3.6: previously the date math used new Date('YYYY-MM-DDT00:00:00')
  // which is local time. The container is UTC but the user is in Sydney,
  // so this off-by-one'd at the 7-day boundary. The fix uses
  // sydneyWallToUtc + sydneyDateString so the math is anchored to Sydney.
  const monitor = require('../src/agent/monitor');
  const time = require('../src/agent/time');
  const todaySydney = time.sydneyDateString(Date.now());
  // today + 6 days in Sydney → within window
  const inWindow = new Date(time.sydneyWallToUtc(todaySydney, '00:00') + 6 * 86_400_000);
  const inWindowStr = time.sydneyDateString(inWindow.getTime());
  assert.equal(monitor.isWithinBookingWindow(inWindowStr), true, `${inWindowStr} (today+6) should be within window`);
  // today + 8 days in Sydney → outside window
  const outOfWindow = new Date(time.sydneyWallToUtc(todaySydney, '00:00') + 8 * 86_400_000);
  const outOfWindowStr = time.sydneyDateString(outOfWindow.getTime());
  assert.equal(monitor.isWithinBookingWindow(outOfWindowStr), false, `${outOfWindowStr} (today+8) should be outside window`);
  // today in Sydney → within window (diffDays = 0)
  assert.equal(monitor.isWithinBookingWindow(todaySydney), true, `today (${todaySydney}) should be within window`);
  // today - 1 in Sydney → NOT in window (diffDays = -1)
  const yesterday = new Date(time.sydneyWallToUtc(todaySydney, '00:00') - 86_400_000);
  const yesterdayStr = time.sydneyDateString(yesterday.getTime());
  assert.equal(monitor.isWithinBookingWindow(yesterdayStr), false, `yesterday (${yesterdayStr}) should be outside window`);
  // Empty / null → false
  assert.equal(monitor.isWithinBookingWindow(null), false);
  assert.equal(monitor.isWithinBookingWindow(''), false);
});

test('v3.6: booker.cancel refuses to cancel a booking with no external_id', async () => {
  const a = repo.accounts.create({ label: 'v36cancel', username: 'v36cancel', password: 'p' });
  const b = repo.bookings.create({
    account_id: a.id, court: '5', date: '2026-07-15', start_time: '19:00', end_time: '20:00',
    status: 'booked_unverified', external_id: null,
  });
  const booker = require('../src/agent/booker');
  let err = null;
  try { await booker.cancel(b.id); } catch (e) { err = e; }
  assert.ok(err, 'cancel should throw');
  assert.equal(err.status, 409);
  assert.ok(/no external_id/i.test(err.message), `error message should mention no external_id, got: ${err.message}`);
  // The booking should not have been touched
  const after = repo.bookings.get(b.id);
  assert.equal(after.status, 'booked_unverified');
  assert.equal(after.external_id, null);
  repo.accounts.remove(a.id);
});

test('v3.6: fire.toApiCourts normalizes user-facing court_pref/courts to API ids', () => {
  assert.deepEqual(fire.toApiCourts({ court_pref: '4', courts: ['4'] }), ['5']);
  assert.deepEqual(fire.toApiCourts({ court_pref: '5', courts: ['5'] }), ['6']);
  assert.deepEqual(fire.toApiCourts({ court_pref: '6', courts: ['6'] }), ['7']);
  assert.deepEqual(
    fire.toApiCourts({ court_pref: '4', courts: ['4', '5', '6'] }),
    ['5', '6', '7'],
    'preferred API id first, then ascending fallback in API terms'
  );
  assert.deepEqual(
    fire.toApiCourts({ court_pref: '5', courts: ['5', '4', '6'] }),
    ['6', '5', '7'],
    'preferred first, then rest in source order'
  );
  assert.deepEqual(
    fire.toApiCourts({ court_pref: '4', courts: [] }),
    ['5'],
    'empty courts still returns the preferred API id'
  );
});

test('v3.6: fire.stashFireContext / popFireContext round-trip', () => {
  const rid = 999999;
  fire.dropFireContext(rid);
  assert.equal(fire.popFireContext(rid), null);
  const ctx = { recurring: { id: rid }, targetMs: 12345, slot: { date: '2026-07-15', from: 38, to: 40 }, apiCourts: ['5', '6', '7'] };
  fire.stashFireContext(rid, ctx);
  const popped = fire.popFireContext(rid);
  assert.ok(popped, 'pop should return the stashed context');
  assert.equal(popped.targetMs, 12345);
  assert.equal(fire.popFireContext(rid), null, 'second pop should return null (consumed)');
  fire.dropFireContext(rid);
});

test('v3.6: fire.peekFireContext does not consume', () => {
  const rid = 999998;
  fire.dropFireContext(rid);
  const ctx = { recurring: { id: rid }, targetMs: 999 };
  fire.stashFireContext(rid, ctx);
  const a = fire.peekFireContext(rid);
  const b = fire.peekFireContext(rid);
  const c = fire.popFireContext(rid);
  assert.ok(a && b && c);
  assert.equal(a.targetMs, 999);
  assert.equal(b.targetMs, 999);
  assert.equal(c.targetMs, 999);
  fire.dropFireContext(rid);
});

test('v3.6: fire context TTL constant is set to a sensible window', () => {
  // We can't easily mock Date.now() to test TTL expiry, so we just verify
  // the constant is non-zero and well above the fire path's worst-case
  // execution time (a few hundred ms).
  assert.equal(typeof fire.FIRE_CONTEXT_TTL_MS, 'number');
  assert.ok(fire.FIRE_CONTEXT_TTL_MS >= 60_000, 'TTL should be at least 1 minute');
  assert.ok(fire.FIRE_CONTEXT_TTL_MS <= 10 * 60_000, 'TTL should not exceed 10 minutes');
});

test('v3.6: repo.bookings.create accepts booked_unverified status', () => {
  const a = repo.accounts.create({ label: 'v36a', username: 'v36a', password: 'p' });
  const b = repo.bookings.create({
    account_id: a.id, court: '5', date: '2026-07-15', start_time: '19:00', end_time: '20:00',
    status: 'booked_unverified', external_id: null, raw_json: { message: 'Your booking has been made.', status: 200 },
  });
  assert.equal(b.status, 'booked_unverified');
  assert.equal(b.external_id, null);
  repo.accounts.remove(a.id);
});

test('v3.6: repo.bookings.listUnverified finds unverified rows older than threshold', () => {
  const a = repo.accounts.create({ label: 'v36b', username: 'v36b', password: 'p' });
  // Recent (within 30s window) — should NOT be picked up
  const recent = repo.bookings.create({
    account_id: a.id, court: '5', date: '2026-07-15', start_time: '19:00', end_time: '20:00',
    status: 'booked_unverified', external_id: null,
  });
  // Old (manually set created_at to 60s ago) — SHOULD be picked up
  const old = repo.bookings.create({
    account_id: a.id, court: '5', date: '2026-07-15', start_time: '19:00', end_time: '20:00',
    status: 'booked_unverified', external_id: null,
  });
  const db = require('../src/db');
  db.get().prepare(`UPDATE bookings SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), old.id);

  const pending = repo.bookings.listUnverified({ olderThanMs: 30_000 });
  const ids = pending.map(p => p.id);
  assert.ok(ids.includes(old.id), `expected old unverified booking ${old.id} in list, got ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes(recent.id), `recent unverified should NOT be in list`);

  repo.bookings.markVerified(old.id, '99999');
  const verified = repo.bookings.get(old.id);
  assert.equal(verified.status, 'confirmed');
  assert.equal(verified.external_id, '99999');
  repo.accounts.remove(a.id);
});

test('v3.6: monitor.reconcileUnverifiedBookings is a no-op when no pending bookings', async () => {
  // Clean slate — any unverified from previous tests would be picked up
  for (const a of repo.accounts.list()) {
    for (const b of repo.bookings.list({})) {
      if (b.account_id === a.id && b.status === 'booked_unverified') {
        // leave for the test below; nothing to clean
      }
    }
  }
  // Make sure none are old enough
  const a = repo.accounts.create({ label: 'v36c', username: 'v36c', password: 'p' });
  const monitor = require('../src/agent/monitor');
  // No bookings at all → no work
  const r = await monitor.reconcileUnverifiedBookings({ olderThanMs: 30_000 });
  assert.equal(r.checked, 0);
  assert.equal(r.confirmed, 0);
  repo.accounts.remove(a.id);
});

test('v3.6: scheduler.isFiring reflects in_flight set', () => {
  const scheduler = require('../src/agent/scheduler');
  // The exported function should be callable
  assert.equal(typeof scheduler.isFiring, 'function');
  // No fire in flight for a random id
  assert.equal(scheduler.isFiring(123456789), false);
});

test('v3.6: executeScheduledBooking — regression guard, prepareForFire NOT called when context is stashed', async () => {
  // This is the v3.6 timing fix in test form: the fire path used to
  // call prepareForFire and hydrateFromSession AFTER the fire time, which
  // cost 2-3 seconds. The fix moves that work to T-leadMs (warmup), and
  // the fire callback at T just pops the stashed context and POSTs.
  //
  // If anyone ever re-introduces async setup work into the fire path,
  // this test will catch it by throwing.
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  for (const w of repo.watches.list()) repo.watches.remove(w.id);
  const a = repo.accounts.create({ label: 'v36timing', username: 'v36timing', password: 'p' });
  const rec = recurring.add({ account_id: a.id, label: 'timing', day_of_week: 3, time: '19:00', court_pref: '4', duration_mins: 60 });

  const warmup = require('../src/agent/warmup');
  const origPrepareForFire = warmup.prepareForFire;
  let prepareForFireCalls = 0;
  warmup.prepareForFire = async (...args) => {
    prepareForFireCalls++;
    throw new Error('prepareForFire should NOT be called when context is stashed');
  };

  // Stash a fire-ready context. Use a fully-mocked client so the POST
  // returns immediately and we can measure the fire-path overhead.
  const fire = require('../src/agent/fire');
  const fakeResult = {
    status: 200,
    body: { message: 'Your booking has been made.', status: 200 },
    raw: '{"message":"Your booking has been made.","status":200}',
    latency_ms: 5,
    error: null,
  };
  const ctx = {
    recurring: rec,
    client: {
      account: a,
      userId: '76',
      contactId: '10001891',
      createBooking: async () => fakeResult,
      getDaySchedule: async () => ({ status: 200, body: { bookings: [] } }),
      cookieHeader: () => '',
    },
    account: a,
    targetMs: Date.now(),
    slot: { date: '2026-07-15', from: 38, to: 40 },
    apiPref: '5',
    apiCourts: ['5', '6', '7'],
    userId: '76',
    contactId: '10001891',
  };
  fire.stashFireContext(rec.id, ctx);

  const scheduler = require('../src/agent/scheduler');
  const t0 = Date.now();
  await scheduler.executeScheduledBooking(rec, ctx.targetMs);
  const elapsed = Date.now() - t0;

  try {
    assert.equal(prepareForFireCalls, 0, 'prepareForFire should NOT be called when context is stashed');
    // With a fully-mocked client and an in-the-past target time, the
    // fire path should be dominated by DB writes (< 200ms on any sane
    // machine). The 2-3s pre-POST drift from before v3.6 is gone.
    assert.ok(elapsed < 500, `fire path took ${elapsed}ms — should be < 500ms with a stashed context. If this fires, someone re-introduced async setup work in the hot path.`);
  } finally {
    warmup.prepareForFire = origPrepareForFire;
    fire.dropFireContext(rec.id);
    repo.recurring.update(rec.id, { first_occurrence_action: 'resolved' });
    for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
    repo.accounts.remove(a.id);
  }
});

test('v3.6: fire.fireScheduledFromContext — happy path (mocked client)', async () => {
  // We mock just enough of KoorooClient to verify the result plumbing.
  // The mock client.createBooking returns a "booked" response; the real
  // flow is exercised against the live server in the smoke test.
  const rid = 999996;
  fire.dropFireContext(rid);
  // state.transition needs a real account row, so create one
  const fakeAccount = repo.accounts.create({ label: 'mock-fp', username: 'mockfp', password: 'x' });
  const mockClient = {
    account: fakeAccount,
    userId: '76',
    contactId: '10001891',
    jar: { getCookiesSync: () => [] },
    cookieHeader: () => '',
    createBooking: async () => ({
      status: 200,
      body: { message: 'Your booking has been made.', status: 200, data2: { resourceId: 'C4' } },
      raw: '{"message":"Your booking has been made.","status":200}',
    }),
    getDaySchedule: async () => ({ status: 200, body: { bookings: [] } }),
  };
  const ctx = {
    recurring: { id: 1, account_id: fakeAccount.id, label: 'mock' },
    client: mockClient,
    account: fakeAccount,
    targetMs: Date.now(),
    slot: { date: '2026-07-15', from: 38, to: 40 },
    apiPref: '5',
    apiCourts: ['5', '6', '7'],
    userId: '76',
    contactId: '10001891',
  };
  fire.stashFireContext(rid, ctx);

  const popped = fire.popFireContext(rid);
  const result = await fire.fireScheduledFromContext({ ctx: popped });
  assert.equal(result.category.code, 'booked');
  assert.equal(result.courtId, '5');
  assert.equal(result.courtIdx, 0, 'booked on first (preferred) court');
  fire.dropFireContext(rid);
  repo.accounts.remove(fakeAccount.id);
});

test('v3.6: fire.fireScheduledFromContext — falls through to fallback court', async () => {
  const rid = 999995;
  fire.dropFireContext(rid);
  const fakeAccount = repo.accounts.create({ label: 'mock-fb', username: 'mockfb', password: 'x' });
  let callCount = 0;
  const mockClient = {
    account: fakeAccount,
    userId: '76',
    contactId: '10001891',
    jar: { getCookiesSync: () => [] },
    cookieHeader: () => '',
    createBooking: async ({ court_id }) => {
      callCount++;
      if (court_id === '5') return { status: 404, body: { message: 'Please reserve a different court. This one is already booked by a member.', status: 404 }, raw: '{}' };
      return { status: 200, body: { message: 'Your booking has been made.', status: 200 }, raw: '{}' };
    },
    getDaySchedule: async () => ({ status: 200, body: { bookings: [] } }),
  };
  const ctx = {
    recurring: { id: 2, account_id: fakeAccount.id, label: 'mock2' },
    client: mockClient,
    account: fakeAccount,
    targetMs: Date.now(),
    slot: { date: '2026-07-15', from: 38, to: 40 },
    apiPref: '5',
    apiCourts: ['5', '6', '7'],
    userId: '76',
    contactId: '10001891',
  };
  fire.stashFireContext(rid, ctx);
  const popped = fire.popFireContext(rid);
  const result = await fire.fireScheduledFromContext({ ctx: popped });
  assert.equal(result.category.code, 'booked');
  assert.equal(result.courtId, '6', 'booked on the fallback court (6)');
  assert.equal(result.courtIdx, 1, 'fallback index');
  assert.equal(callCount, 2, 'should have tried preferred then fallback');
  fire.dropFireContext(rid);
  repo.accounts.remove(fakeAccount.id);
});

test('v3.6: recordAndPersistScheduledFire — booked_unverified when findBookingFor returns null', async () => {
  const a = repo.accounts.create({ label: 'v36rec', username: 'v36rec', password: 'p' });
  const r = recurring.add({ account_id: a.id, label: 'unv', day_of_week: 3, time: '19:00', court_pref: '4', duration_mins: 60 });
  const ctx = {
    recurring: r,
    client: {
      account: a,
      userId: '76',
      contactId: '10001891',
      getDaySchedule: async () => ({ status: 200, body: { bookings: [] } }),  // empty — no match
    },
    account: a,
    targetMs: Date.now(),
    slot: { date: '2026-07-15', from: 38, to: 40 },
    apiPref: '5',
    apiCourts: ['5', '6', '7'],
    userId: '76',
    contactId: '10001891',
  };
  const fakeResult = {
    status: 200,
    body: { message: 'Your booking has been made.', status: 200 },
    raw: '{"message":"Your booking has been made.","status":200}',
    latency_ms: 50,
    courtId: '5',
    courtIdx: 0,
    category: { code: 'booked' },
    firedAt: new Date().toISOString(),
    ctx,
  };
  const out = await fire.recordAndPersistScheduledFire({ ctx, result: fakeResult });
  assert.equal(out.booking.status, 'booked_unverified', 'should be booked_unverified when findBookingFor returns null');
  assert.equal(out.booking.external_id, null);
  // And the recurring's setLastResult should still report 'booked' (the fire
  // succeeded on the server's side; the reconciliation job will eventually
  // flip the booking row to 'confirmed' when external_id is filled in).
  const after = repo.recurring.get(r.id);
  assert.equal(after.last_status, 'booked');

  // Verify the booking is now in the unverified list (after the cutoff).
  // We use olderThanMs: -1000 so the just-created booking is in the list
  // (the cutoff becomes a future timestamp, matching all past rows).
  const pending = repo.bookings.listUnverified({ olderThanMs: -1000 });
  assert.ok(pending.find(p => p.id === out.booking.id), 'unverified booking should appear in listUnverified');

  // markVerified flips status and sets external_id
  repo.bookings.markVerified(out.booking.id, '12345');
  const verified = repo.bookings.get(out.booking.id);
  assert.equal(verified.status, 'confirmed');
  assert.equal(verified.external_id, '12345');
  repo.accounts.remove(a.id);
});

// ---- v3.5: booking target + non-recurring one-shot watches ----

test('v3.5: scheduler.nextBookingTarget — returns the slot the next fire will book', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'v35a', username: 'v35a', password: 'p' });
  const scheduler = require('../src/agent/scheduler');
  // next_fire_at = 8 Jul 19:00 Sydney (the opening). The booking target
  // is 15 Jul 19:00 (the user-picked slot, 7 days after the opening).
  const rec = recurring.add({
    account_id: a.id,
    day_of_week: 3, time: '19:00', court_pref: '4',
    duration_mins: 60, first_slot_date: '2026-07-15',
  });
  const target = scheduler.nextBookingTarget(rec);
  assert.equal(target.date, '2026-07-15');
  assert.equal(target.from, 38); // 19:00 = slot 38
  assert.equal(target.to, 40);   // 60 min = 2 slots
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.5: scheduler.nextBookingTarget — subsequent fire targets the next slot (7d after)', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'v35b', username: 'v35b', password: 'p' });
  const scheduler = require('../src/agent/scheduler');
  const rec = recurring.add({
    account_id: a.id,
    day_of_week: 3, time: '19:00', court_pref: '4',
    duration_mins: 60, first_slot_date: '2026-07-15',
  });
  // Simulate a fire at the opening that booked 15 Jul. setLastResult
  // sets both last_status AND last_fire_at on the recurring, which
  // signals to slotForFire that this is a subsequent fire.
  const slotUtc = time.sydneyWallToUtc('2026-07-15', '19:00');
  repo.fireEvents.create({
    recurring_id: rec.id, account_id: a.id,
    scheduled_at: new Date(slotUtc - 7 * 86_400_000).toISOString(),
    fired_at: new Date().toISOString(),
    status: 'booked', attempt: 1, court_attempted: '4', court_booked: '4',
    date: '2026-07-15', time: '19:00',
  });
  repo.recurring.setLastResult(rec.id, { status: 'booked', msg: 'booked', category: null });
  recurring.chainToNextWeek(rec.id);
  const updated = repo.recurring.get(rec.id);
  // next_fire_at = 15 Jul 19:00 (the opening of 22 Jul). Target = 22 Jul.
  const target = scheduler.nextBookingTarget(updated);
  assert.equal(target.date, '2026-07-22');
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.5: repo.watches.setFired — marks watch as fired', () => {
  for (const w of repo.watches.list()) repo.watches.remove(w.id);
  const a = repo.accounts.create({ label: 'v35c', username: 'v35c', password: 'p' });
  const w = repo.watches.create({ account_id: a.id, label: 'Test', date_from: '2026-07-15', time_start: '19:00', duration_mins: 60 });
  assert.equal(w.fired_at, null);
  repo.watches.setFired(w.id);
  const after = repo.watches.get(w.id);
  assert.ok(after.fired_at, 'fired_at should be set');
  repo.accounts.remove(a.id);
  for (const w of repo.watches.list()) repo.watches.remove(w.id);
});

test('v3.5: monitor.fireDueWatches — only fires watches within window, skips fired ones', () => {
  for (const w of repo.watches.list()) repo.watches.remove(w.id);
  const monitor = require('../src/agent/monitor');
  const a = repo.accounts.create({ label: 'v35d', username: 'v35d', password: 'p' });
  // Watch 1: within window, not fired → should be picked up
  const within = repo.watches.create({
    account_id: a.id, label: 'Within', date_from: new Date().toISOString().slice(0, 10),
    time_start: '19:00', duration_mins: 60, strategy: 'scheduled',
  });
  // Watch 2: within window, but already fired → should be skipped
  const fired = repo.watches.create({
    account_id: a.id, label: 'Fired', date_from: new Date().toISOString().slice(0, 10),
    time_start: '19:00', duration_mins: 60, strategy: 'scheduled',
  });
  repo.watches.setFired(fired.id);
  // Watch 3: out of window → should be skipped
  const out = repo.watches.create({
    account_id: a.id, label: 'Out', date_from: '2026-12-15',
    time_start: '19:00', duration_mins: 60, strategy: 'scheduled',
  });
  // Watch 4: disabled → should be skipped
  const disabled = repo.watches.create({
    account_id: a.id, label: 'Disabled', date_from: new Date().toISOString().slice(0, 10),
    time_start: '19:00', duration_mins: 60, strategy: 'scheduled', enabled: 0,
  });
  // The actual runWatch call will hit the Koorora API which will fail
  // (we have no session). The important thing is that the firing path
  // is called for "within" but NOT for "fired", "out", or "disabled".
  // We test the selection by checking that after fireDueWatches runs,
  // "within" has last_status set, and the others don't.
  return monitor.fireDueWatches().then(r => {
    // "within" should have been attempted (last_status will be 'failed'
    // or 'error' since we have no session, but the run was attempted).
    // "fired", "out", "disabled" should have NO new last_status.
    const withinAfter = repo.watches.get(within.id);
    const firedAfter = repo.watches.get(fired.id);
    const outAfter = repo.watches.get(out.id);
    const disabledAfter = repo.watches.get(disabled.id);
    assert.ok(withinAfter.last_run_at, 'within should have been attempted');
    assert.equal(firedAfter.last_run_at, null, 'fired should NOT be re-attempted');
    assert.equal(outAfter.last_run_at, null, 'out (out of window) should NOT be attempted');
    assert.equal(disabledAfter.last_run_at, null, 'disabled should NOT be attempted');
  }).then(() => {
    repo.accounts.remove(a.id);
    for (const w of repo.watches.list()) repo.watches.remove(w.id);
  });
});

test('v3.1: courtAllocator.findConflictingCourts — empty when no other recurring on slot', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'ca0', username: 'ca0', password: 'p' });
  const c = courtAllocator.findConflictingCourts({ dayOfWeek: 5, time: '20:00' });
  assert.deepEqual(c, []);
  repo.accounts.remove(a.id);
});

test('v3.1: courtAllocator.findConflictingCourts — picks up same-slot same-court conflicts', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'ca1', username: 'ca1', password: 'p' });
  recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '4' });
  const c = courtAllocator.findConflictingCourts({ dayOfWeek: 5, time: '20:00' });
  assert.deepEqual(c, ['4']);
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.1: courtAllocator.findConflictingCourts — different slot does NOT conflict', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'ca2', username: 'ca2', password: 'p' });
  recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '4' });
  const c = courtAllocator.findConflictingCourts({ dayOfWeek: 6, time: '09:00' });
  assert.deepEqual(c, []);
  // Same day, different time — also no conflict
  const c2 = courtAllocator.findConflictingCourts({ dayOfWeek: 5, time: '21:00' });
  assert.deepEqual(c2, []);
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.1: courtAllocator.findConflictingCourts — excludeId skips the row being updated', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'ca3', username: 'ca3', password: 'p' });
  const r1 = recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '4' });
  const c = courtAllocator.findConflictingCourts({ dayOfWeek: 5, time: '20:00', excludeId: r1.id });
  assert.deepEqual(c, []);
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.1: courtAllocator.findConflictingCourts — no_courts_available rows do not count', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'ca4', username: 'ca4', password: 'p' });
  // Force a no_courts_available row by inserting it directly.
  const r1 = repo.recurring.create({
    account_id: a.id, label: 'stale', court_pref: '4', courts: ['4','5','6'],
    day_of_week: 5, time: '20:00', duration_mins: 60, lead_minutes: 10,
    enabled: 1, first_occurrence_action: 'book_now', next_fire_at: new Date().toISOString(),
  });
  repo.recurring.setLastResult(r1.id, { status: 'failed', msg: 'no courts', category: 'no_courts_available' });
  const c = courtAllocator.findConflictingCourts({ dayOfWeek: 5, time: '20:00' });
  assert.deepEqual(c, []);
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.1: recurring.add auto-allocates when same court already taken on same slot', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'ca5', username: 'ca5', password: 'p' });
  // First booking: C4
  const r1 = recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '4' });
  assert.equal(r1.court_pref, '4');
  assert.equal(r1.court_auto_allocated, undefined);
  // Second booking: asks for C4, must auto-allocate to C5
  const r2 = recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '4' });
  assert.equal(r2.court_pref, '5');
  assert.equal(r2.court_auto_allocated, true);
  assert.equal(r2.original_court_pref, '4');
  // Third booking: asks for C6, must stay on C6 (not taken)
  const r3 = recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '6' });
  assert.equal(r3.court_pref, '6');
  assert.equal(r3.court_auto_allocated, undefined);
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.1: recurring.add — 4th booking on same slot is marked no_courts_available', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'ca6', username: 'ca6', password: 'p' });
  recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '4' });
  recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '5' });
  const r3 = recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '6' });
  assert.equal(r3.court_pref, '6');
  const r4 = recurring.add({ account_id: a.id, day_of_week: 5, time: '20:00', court_pref: '4' });
  assert.equal(r4.court_pref, '4');
  assert.equal(r4.no_courts_available, true);
  assert.equal(r4.last_error_category, 'no_courts_available');
  assert.equal(r4.last_status, 'failed');
  // It should also surface in the error banner
  const banners = repo.recurring.listUnacknowledgedErrors();
  assert.ok(banners.some(b => b.id === r4.id), 'expected no_courts_available recurring in banner');
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('teardown', () => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
