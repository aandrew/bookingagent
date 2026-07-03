'use strict';

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./_mw');
const repo = require('../db/repo');
const monitor = require('../agent/monitor');
const pool = require('../agent/pool');
const config = require('../config');

router.get('/', requireAdmin, (req, res) => {
  const accounts = repo.accounts.list();
  const watches = repo.watches.list();
  const bookings = repo.bookings.list({ limit: 10 });
  const recentAudit = repo.audit.list({ limit: 20 });
  res.render('overview', { accounts, watches, bookings, recentAudit, config });
});

router.get('/accounts', requireAdmin, (req, res) => {
  const accounts = repo.accounts.list();
  const sessionsById = Object.fromEntries(accounts.map((a) => [a.id, repo.sessions.getByAccount(a.id)]));
  res.render('accounts', { accounts, sessionsById });
});

router.get('/watches', requireAdmin, (req, res) => {
  const watches = repo.watches.list();
  const accounts = repo.accounts.list();
  res.render('watches', { watches, accounts });
});

router.get('/bookings', requireAdmin, (req, res) => {
  const bookings = repo.bookings.list({ limit: 200 });
  const accounts = repo.accounts.list();
  res.render('bookings', { bookings, accounts });
});

router.get('/audit', requireAdmin, (req, res) => {
  const entries = repo.audit.list({ limit: 200 });
  const accounts = repo.accounts.list();
  res.render('audit', { entries, accounts });
});

router.get('/settings', requireAdmin, (req, res) => res.render('settings', { config }));

module.exports = router;
