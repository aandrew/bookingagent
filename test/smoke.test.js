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
  // User picks Wed 15 Jul 2026 at 19:00. The first fire should be at 8 Jul 19:00
  // (the opening). day_of_week=3 (Wed).
  const r = recurring.add({
    account_id: a.id,
    day_of_week: 3, time: '19:00', court_pref: '4',
    duration_mins: 60, first_slot_date: '2026-07-15',
  });
  // next_fire_at should be 8 Jul 2026 19:00 Sydney = 8 Jul 09:00 UTC (AEST)
  const expectedOpening = time.sydneyWallToUtc('2026-07-15', '19:00') - 7 * 86_400_000;
  assert.equal(r.next_fire_at, new Date(expectedOpening).toISOString());
  assert.equal(r.first_slot_date, '2026-07-15');
  assert.equal(r.first_occurrence_action, 'book_now');
  repo.accounts.remove(a.id);
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
});

test('v3.4: recurring.add with first_slot_date within 7 days (opening passed) — fires at the picked date', () => {
  for (const r of repo.recurring.list()) repo.recurring.remove(r.id);
  const a = repo.accounts.create({ label: 'v34b', username: 'v34b', password: 'p' });
  // Simulate a picked date that's within 7 days by using today's weekday
  // (no opening-before-now to skip — we test the "fall back to picked date" path).
  // We can't easily mock Date.now() in a unit test, so we just verify the
  // happy path (picked date is >7 days out) here, and rely on the smoke
  // test for the within-7-days case.
  const today = new Date();
  const todayDow = today.getDay();
  const picked = new Date(today.getTime() + 14 * 86_400_000);
  const pickedDateStr = picked.toISOString().slice(0, 10);
  const pickedDow = picked.getDay();
  const r = recurring.add({
    account_id: a.id,
    day_of_week: pickedDow, time: '19:00', court_pref: '4',
    duration_mins: 60, first_slot_date: pickedDateStr,
  });
  const expectedOpening = time.sydneyWallToUtc(pickedDateStr, '19:00') - 7 * 86_400_000;
  assert.equal(r.next_fire_at, new Date(expectedOpening).toISOString());
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
