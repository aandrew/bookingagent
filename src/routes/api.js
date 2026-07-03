'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./_mw');
const repo = require('../db/repo');
const monitor = require('../agent/monitor');
const booker = require('../agent/booker');
const pool = require('../agent/pool');
const recurring = require('../agent/recurring');
const scheduler = require('../agent/scheduler');
const state = require('../agent/state');
const { probeSession } = require('../kooroo/auth');
const { buildClientForAccount } = require('../kooroo/client');

function presentAccount(a) {
  if (!a) return null;
  const { password, ...rest } = a;
  return rest;
}

router.get('/accounts', requireAdmin, (req, res) => {
  res.json(repo.accounts.list().map(presentAccount));
});

router.post('/accounts', requireAdmin, async (req, res) => {
  const { label, username, password } = req.body || {};
  if (!label || !username || !password) return res.status(400).json({ error: 'label, username, password required' });
  try {
    const a = repo.accounts.create({ label, username, password });
    // Test the credentials immediately: re-login via Playwright so the user
    // sees `state: tested_ok` (or `error` with the message) right away.
    let testResult = null;
    try {
      const { reloginWithBrowser } = require('../kooroo/auth');
      await reloginWithBrowser(a);
      testResult = { ok: true };
      state.transition(a.id, state.STATES.TESTED_OK, 'credentials verified on add');
    } catch (e) {
      testResult = { ok: false, error: e.message };
      state.transition(a.id, state.STATES.ERROR, e.message);
    }
    res.status(201).json({ ...presentAccount(repo.accounts.get(a.id)), test: testResult });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/accounts/:id', requireAdmin, (req, res) => {
  const a = repo.accounts.update(parseInt(req.params.id, 10), req.body || {});
  res.json(presentAccount(a));
});

router.delete('/accounts/:id', requireAdmin, (req, res) => {
  repo.accounts.remove(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/accounts/:id/relogin', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const account = repo.accounts.get(id);
  if (!account) return res.status(404).json({ error: 'not_found' });
  try {
    const { reloginWithBrowser } = require('../kooroo/auth');
    await reloginWithBrowser(account);
    pool.forget(id);
    state.transition(id, state.STATES.TESTED_OK, 'manual relogin');
    res.json({ ok: true });
  } catch (e) {
    state.transition(id, state.STATES.LOGIN_REQUIRED, e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/accounts/:id/probe', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const client = buildClientForAccount(repo.accounts.get(id));
    await client.hydrateFromSession();
    const r = await probeSession(client);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/accounts/:id/state', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(state.get(id));
});

router.get('/watches', requireAdmin, (req, res) => res.json(repo.watches.list()));
router.post('/watches', requireAdmin, (req, res) => {
  const w = req.body || {};
  if (!w.account_id || !w.label) return res.status(400).json({ error: 'account_id and label required' });
  res.status(201).json(repo.watches.create(w));
});
router.patch('/watches/:id', requireAdmin, (req, res) => {
  res.json(repo.watches.update(parseInt(req.params.id, 10), req.body || {}));
});
router.delete('/watches/:id', requireAdmin, (req, res) => {
  repo.watches.remove(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/watches/:id/book-now', requireAdmin, async (req, res) => {
  try {
    const r = await monitor.bookNow(parseInt(req.params.id, 10));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/monitor/run', requireAdmin, async (req, res) => {
  try {
    const r = await monitor.runAll();
    res.json({ results: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/bookings', requireAdmin, (req, res) => {
  res.json(repo.bookings.list({ limit: 200, status: req.query.status || null }));
});

router.post('/bookings', requireAdmin, async (req, res) => {
  try {
    const r = await booker.book(req.body || {});
    res.status(201).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const r = await booker.cancel(parseInt(req.params.id, 10));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/audit', requireAdmin, (req, res) => {
  res.json(repo.audit.list({ limit: 200, accountId: req.query.account_id ? parseInt(req.query.account_id, 10) : null }));
});

// v2.1: recurring bookings
router.get('/recurring', requireAdmin, (req, res) => {
  res.json(recurring.list(req.query.enabled !== undefined ? { enabled: req.query.enabled === 'true' } : {}));
});

router.post('/recurring', requireAdmin, (req, res) => {
  try {
    const r = recurring.add(req.body || {});
    // tell the scheduler to (re-)arm
    scheduler.schedule(r.id);
    res.status(201).json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/recurring/:id', requireAdmin, (req, res) => {
  try {
    const r = recurring.update(parseInt(req.params.id, 10), req.body || {});
    scheduler.schedule(r.id);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/recurring/:id', requireAdmin, (req, res) => {
  recurring.remove(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/recurring/:id/fire-now', requireAdmin, async (req, res) => {
  try {
    const r = await recurring.fireNow(parseInt(req.params.id, 10));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/recurring/:id/dismiss-error', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  recurring.get(id);
  repo.recurring.dismissError(id);
  res.json({ ok: true });
});

router.get('/recurring/:id/fire-events', requireAdmin, (req, res) => {
  res.json(repo.fireEvents.list({ recurringId: parseInt(req.params.id, 10), limit: 100 }));
});

router.get('/fire-events', requireAdmin, (req, res) => {
  res.json(repo.fireEvents.list({
    limit: parseInt(req.query.limit || '100', 10),
    recurringId: req.query.recurring_id ? parseInt(req.query.recurring_id, 10) : null,
    accountId: req.query.account_id ? parseInt(req.query.account_id, 10) : null,
    status: req.query.status || null,
  }));
});

router.get('/scheduler/status', requireAdmin, (req, res) => {
  res.json({ active: scheduler.listActive() });
});

router.get('/errors/active', requireAdmin, (req, res) => {
  res.json(repo.recurring.listUnacknowledgedErrors());
});

router.get('/health', requireAdmin, (req, res) => res.json({ ok: true }));

module.exports = router;
