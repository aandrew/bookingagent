'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kooroo-test-'));
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

const hasLiveSession = fs.existsSync(path.join(config.dataDir, '..', 'data', 'spike-cookies.json')) ||
                       fs.existsSync('/home/ubuntu/Projects/bookingagent/data/spike-cookies.json');

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
  const got = repo.accounts.get(a.id);
  assert.equal(got.username, 'andrew');
  repo.accounts.update(a.id, { label: 'Renamed' });
  assert.equal(repo.accounts.get(a.id).label, 'Renamed');
  repo.accounts.remove(a.id);
  assert.equal(repo.accounts.get(a.id), undefined);
});

test('watch and booking lifecycle', () => {
  const a = repo.accounts.create({ label: 'A', username: 'u', password: 'p' });
  const w = repo.watches.create({ account_id: a.id, label: 'Tue 7pm' });
  assert.ok(w.id);
  const b = repo.bookings.create({ account_id: a.id, watch_id: w.id, status: 'confirmed', date: '2026-07-10', start_time: '19:00', end_time: '20:00', court: 'Court 1' });
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
  }
}

test('teardown', () => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
