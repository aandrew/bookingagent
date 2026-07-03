'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./_mw');
const repo = require('../db/repo');
const monitor = require('../agent/monitor');
const booker = require('../agent/booker');
const pool = require('../agent/pool');
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

router.post('/accounts', requireAdmin, (req, res) => {
  const { label, username, password } = req.body || {};
  if (!label || !username || !password) return res.status(400).json({ error: 'label, username, password required' });
  try {
    const a = repo.accounts.create({ label, username, password });
    res.status(201).json(presentAccount(a));
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
    res.json({ ok: true });
  } catch (e) {
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

router.get('/health', requireAdmin, (req, res) => res.json({ ok: true }));

module.exports = router;
