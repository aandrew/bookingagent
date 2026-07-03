'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./_mw');
const repo = require('../db/repo');
const monitor = require('../agent/monitor');
const pool = require('../agent/pool');
const recurring = require('../agent/recurring');
const config = require('../config');
const format = require('../lib/format');

// Helper: attach activeErrors to all renders
function withLocals(extra) {
  return Object.assign({ activeErrors: repo.recurring.listUnacknowledgedErrors() }, extra || {});
}

router.get('/', requireAdmin, (req, res) => {
  const accounts = repo.accounts.list();
  const watches = repo.watches.list();
  const bookings = repo.bookings.list({ limit: 10 });
  const recentAudit = repo.audit.list({ limit: 20 });
  const recurringRows = recurring.list();
  const fireEvents = repo.fireEvents.list({ limit: 5 });
  res.render('overview', withLocals({ accounts, watches, bookings, recentAudit, recurringRows, fireEvents, config, format, query: req.query }));
});

router.get('/accounts', requireAdmin, (req, res) => {
  const accounts = repo.accounts.list();
  const sessionsById = Object.fromEntries(accounts.map((a) => [a.id, repo.sessions.getByAccount(a.id)]));
  res.render('accounts', withLocals({ accounts, sessionsById }));
});

router.get('/watches', requireAdmin, (req, res) => {
  const watches = repo.watches.list();
  const accounts = repo.accounts.list();
  res.render('watches', withLocals({ watches, accounts }));
});

router.get('/bookings', requireAdmin, (req, res) => {
  const bookings = repo.bookings.list({ limit: 200 });
  const accounts = repo.accounts.list();
  res.render('bookings', withLocals({ bookings, accounts }));
});

router.get('/recurring', requireAdmin, (req, res) => {
  const recurringRows = recurring.list();
  const accounts = repo.accounts.list();
  // Build a username lookup for the view
  const userById = Object.fromEntries(accounts.map(a => [a.id, a.username]));
  for (const r of recurringRows) r.account_username = userById[r.account_id] || null;
  // v3: handle ?added=N&label=X flash
  if (req.query.added && req.query.label) {
    req.session.flash = { type: 'ok', message: `Added ${req.query.label} (recurring #${req.query.added})` };
  }
  res.render('recurring', withLocals({ recurringRows, accounts }));
});

router.get('/recurring/:id', requireAdmin, (req, res) => {
  const r = recurring.get(parseInt(req.params.id, 10));
  if (!r) return res.status(404).render('error', Object.assign(withLocals(), { message: 'Recurring booking not found', stack: '' }));
  const events = repo.fireEvents.list({ recurringId: r.id, limit: 50 });
  const bookings = repo.bookings.listForRecurring(r.id, 20);
  const account = repo.accounts.get(r.account_id);
  res.render('recurring_detail', withLocals({ recurring: r, events, bookings, account, format, query: req.query }));
});

router.get('/booking-log', requireAdmin, (req, res) => {
  const events = repo.fireEvents.list({ limit: 200, status: req.query.status || null, recurringId: req.query.recurring_id ? parseInt(req.query.recurring_id, 10) : null });
  const accounts = repo.accounts.list();
  res.render('booking_log', withLocals({ events, accounts }));
});

// Backward-compat alias for the old /fire-events page
router.get('/fire-events', requireAdmin, (req, res) => res.redirect('/booking-log'));

router.get('/audit', requireAdmin, (req, res) => {
  const entries = repo.audit.list({ limit: 200 });
  const accounts = repo.accounts.list();
  res.render('audit', withLocals({ entries, accounts }));
});

router.get('/settings', requireAdmin, (req, res) => res.render('settings', withLocals({ config })));

module.exports = router;
