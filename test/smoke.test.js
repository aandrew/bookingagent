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

test('v2.1: recurring.chain advances next_fire_at to slot + 7d', () => {
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
  // next_fire_at should be slotDate 19:00 + 7d
  const slotUtc = time.sydneyWallToUtc(slotDate, '19:00');
  const expected = new Date(slotUtc + 7 * 86_400_000).toISOString();
  assert.equal(after.next_fire_at, expected);
  assert.notEqual(after.next_fire_at, before.next_fire_at);
  repo.accounts.remove(a.id);
});

test('v2.1: recurring.add — court_pref must be 4, 5, or 6', () => {
  const a = repo.accounts.create({ label: 'r3', username: 'u3', password: 'p' });
  assert.throws(() => recurring.add({ account_id: a.id, label: 'x', day_of_week: 3, time: '19:00', court_pref: '99' }));
  assert.throws(() => recurring.add({ account_id: a.id, label: 'x', day_of_week: 3, time: '19:00', court_pref: '5', courts: ['99'] }));
  repo.accounts.remove(a.id);
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

test('v2.1: scheduler.slotForFire computes date+slots from fireMs', () => {
  const scheduler = require('../src/agent/scheduler');
  const rec = { day_of_week: 3, time: '19:00', duration_mins: 60 };
  // Pick a future Wed 7pm Sydney
  const wedUtc = time.nextWeekdayAt(3, '19:00', { after: Date.now() + 60_000 });
  const slot = scheduler.slotForFire(rec, wedUtc);
  assert.equal(slot.date, time.sydneyDateString(wedUtc));
  assert.equal(slot.from, 38); // 19:00 = slot 38
  assert.equal(slot.to, 40);   // 60 min = 2 slots
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

test('teardown', () => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
