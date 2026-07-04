'use strict';

// v3.1 multi-account smoke test.
//
// Goal: prove that the court auto-allocation logic correctly assigns distinct
// courts to two accounts on the same recurring time slot.
//
// This test exercises ONLY the create-time allocation logic via the admin
// API. It does NOT trigger any actual booking. It does NOT run Playwright
// (the live re-login is a separate concern — `npm run spike` to capture
// cookies once, then re-use them).
//
// Usage:
//   1. Add two accounts via the dashboard / Make Booking (or via
//      `npm run spike` for each, then `node tools/import-session.js`).
//      The accounts MUST use the usernames in KOOROO_TEST_USER_1 / _2.
//   2. Start the dashboard (this script hits the live HTTP API).
//   3. `npm run smoke:multi`.
//
// The test:
//   - logs in as admin
//   - finds the two existing accounts by username
//   - creates 4 recurring bookings on the SAME (day_of_week, time) slot
//   - asserts r1=C4, r2 auto-allocated to C5, r3 auto-allocated to C6,
//     r4 marked no_courts_available
//   - cleans up: deletes the test recurring and accounts
//
// Per the spec, this is a verify-allocation-only test — no real bookings
// are made and the smoke test should finish within 30 seconds.
//
// Env vars (all required):
//   KOOROO_TEST_BASE_URL   e.g. http://127.0.0.1:3000
//   KOOROO_TEST_ADMIN_USER admin username
//   KOOROO_TEST_ADMIN_PASS admin password
//   KOOROO_TEST_USER_1     first test account username (must already exist)
//   KOOROO_TEST_USER_2     second test account username (must already exist)

require('dotenv').config();
const { CookieJar } = require('tough-cookie');
const { Agent, fetch: undiciFetch } = require('undici');

const BASE = process.env.KOOROO_TEST_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_USER = process.env.KOOROO_TEST_ADMIN_USER || process.env.ADMIN_USER;
const ADMIN_PASS = process.env.KOOROO_TEST_ADMIN_PASS || process.env.ADMIN_PASS;
const USER_1 = process.env.KOOROO_TEST_USER_1;
const USER_2 = process.env.KOOROO_TEST_USER_2;

// Hard 30s budget for the whole test (no booking fires, no Playwright).
const TEST_BUDGET_MS = 30_000;

const jar = new CookieJar();
const dispatcher = new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000, connections: 4 });

function fail(msg, extra) {
  console.error('FAIL:', msg, extra ? JSON.stringify(extra) : '');
  process.exit(1);
}
function ok(msg, extra) {
  console.log(' OK :', msg, extra ? JSON.stringify(extra) : '');
}

function deadline(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(`test exceeded ${ms}ms budget`)), ms));
}

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label || 'op'} exceeded ${ms}ms`)), ms))]);
}

async function cookieHeader() {
  const cs = await jar.getCookies(BASE);
  return cs.map(c => `${c.key}=${c.value}`).join('; ');
}

async function request(method, path, body) {
  const headers = { 'accept': 'application/json' };
  const ck = await cookieHeader();
  if (ck) headers.cookie = ck;
  const init = { method, headers, dispatcher, redirect: 'manual' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await undiciFetch(BASE + path, init);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) { try { await jar.setCookie(sc, BASE); } catch {} }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json, text };
}

async function login() {
  const localDispatcher = new Agent({ keepAliveTimeout: 10_000 });
  const form = new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS });
  const res = await undiciFetch(BASE + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
    dispatcher: localDispatcher,
  });
  if (res.status !== 302 && res.status !== 200) {
    fail('admin login failed', { status: res.status, body: await res.text() });
  }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) { try { await jar.setCookie(sc, BASE); } catch {} }
  ok('admin login OK');
}

async function logout() {
  try {
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    const ck = await cookieHeader(); if (ck) headers.cookie = ck;
    await undiciFetch(BASE + '/logout', { method: 'POST', headers, dispatcher });
  } catch {}
}

async function findAccount(username) {
  const r = await withTimeout(request('GET', '/api/accounts'), 5_000, 'GET /api/accounts');
  if (r.status !== 200) fail('GET /api/accounts', r);
  const a = (r.body || []).find(x => x.username === username);
  if (!a) fail(`account with username "${username}" not found — add it via the dashboard first (or run npm run spike + import-session)`);
  return a.id;
}

async function addRecurring({ accountId, dayOfWeek, time, courtPref, label }) {
  const r = await withTimeout(request('POST', '/api/recurring', {
    account_id: accountId, day_of_week: dayOfWeek, time, court_pref: courtPref,
    duration_mins: 60, fallback_enabled: true, label,
  }), 5_000, `POST /api/recurring ${label}`);
  if (r.status >= 400) fail(`POST /api/recurring (${label})`, r);
  return r.body;
}

async function deleteRecurring(id) {
  const r = await withTimeout(request('DELETE', `/api/recurring/${id}`), 5_000, `DELETE /api/recurring/${id}`);
  if (r.status >= 400) fail(`DELETE /api/recurring/${id}`, r);
}

async function deleteAccount(id) {
  const r = await withTimeout(request('DELETE', `/api/accounts/${id}`), 5_000, `DELETE /api/accounts/${id}`);
  if (r.status >= 400) fail(`DELETE /api/accounts/${id}`, r);
}

async function main() {
  if (!ADMIN_USER || !ADMIN_PASS) fail('admin creds not set');
  if (!USER_1 || !USER_2) fail('KOOROO_TEST_USER_1 / KOOROO_TEST_USER_2 not set');
  ok(`target: ${BASE}`);

  // Whole test budget
  await Promise.race([runTest(), deadline(TEST_BUDGET_MS)]);
}

async function runTest() {
  await login();

  const acc1 = await findAccount(USER_1);
  const acc2 = await findAccount(USER_2);
  ok(`accounts found: ${USER_1}=#${acc1}, ${USER_2}=#${acc2}`);

  // Saturday 09:00 — far enough out that we don't accidentally match a
  // pre-existing booking.
  const dayOfWeek = 6;
  const time = '09:00';

  // First booking: C4 on account1 — should be C4, no auto-allocate.
  const r1 = await addRecurring({ accountId: acc1, dayOfWeek, time, courtPref: '4', label: 'smoke-r1' });
  if (r1.court_pref !== '4') fail('r1 should be C4', r1);
  if (r1.court_auto_allocated) fail('r1 should NOT be auto-allocated', r1);
  ok('r1: C4, no auto-allocate', r1);

  // Second booking: C4 on account2 — should auto-allocate to C5.
  const r2 = await addRecurring({ accountId: acc2, dayOfWeek, time, courtPref: '4', label: 'smoke-r2' });
  if (r2.court_pref !== '5') fail('r2 should auto-allocate to C5', r2);
  if (!r2.court_auto_allocated) fail('r2 should be auto-allocated', r2);
  if (r2.original_court_pref !== '4') fail('r2 original_court_pref should be 4', r2);
  ok('r2: auto-allocated C4 → C5', r2);

  // Third booking: C4 on account1 — should auto-allocate to C6.
  const r3 = await addRecurring({ accountId: acc1, dayOfWeek, time, courtPref: '4', label: 'smoke-r3' });
  if (r3.court_pref !== '6') fail('r3 should auto-allocate to C6', r3);
  if (!r3.court_auto_allocated) fail('r3 should be auto-allocated', r3);
  ok('r3: auto-allocated C4 → C6', r3);

  // Fourth booking: C4 on account2 — should be marked no_courts_available.
  const r4 = await addRecurring({ accountId: acc2, dayOfWeek, time, courtPref: '4', label: 'smoke-r4' });
  if (!r4.no_courts_available) fail('r4 should be no_courts_available', r4);
  if (r4.last_error_category !== 'no_courts_available') fail('r4 last_error_category should be no_courts_available', r4);
  if (r4.last_status !== 'failed') fail('r4 last_status should be failed', r4);
  ok('r4: no_courts_available (all 3 courts taken)', { id: r4.id, court_pref: r4.court_pref, last_error_category: r4.last_error_category });

  // Cleanup
  for (const r of [r1, r2, r3, r4]) {
    await deleteRecurring(r.id);
  }
  ok('4 recurring deleted');

  await deleteAccount(acc1);
  await deleteAccount(acc2);
  ok('2 accounts deleted');

  await logout();
  ok('all assertions passed — court auto-allocation works correctly for two accounts');
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(2); });
