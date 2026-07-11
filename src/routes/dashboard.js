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

// v3.6: for each recurring, attach a `booked_on_fallback` flag and the
// `last_booked_court` it landed on. The view uses this to show a warning
// pill ("on fallback court") when the most recent successful fire didn't
// land on the user's preferred court. N+1 but the list is small (handful
// of recurrings) and fireEvents.list is indexed by recurring_id.
function annotateFallback(recurringRows) {
  for (const r of recurringRows) {
    const recent = repo.fireEvents.list({ recurringId: r.id, limit: 10 });
    const lastBooked = recent.find(e => e.status === 'booked' && e.court_booked);
    if (lastBooked) {
      const prefApi = recurring.COURT_TO_API[r.court_pref] || null;
      r.last_booked_court = lastBooked.court_booked;
      r.booked_on_fallback = prefApi && String(lastBooked.court_booked) !== String(prefApi);
    } else {
      r.last_booked_court = null;
      r.booked_on_fallback = false;
    }
  }
}

router.get('/', requireAdmin, (req, res) => {
  const accounts = repo.accounts.list();
  const watches = repo.watches.list();
  const bookings = repo.bookings.list({ limit: 10 });
  const recentAudit = repo.audit.list({ limit: 20 });
  const recurringRows = recurring.list();
  annotateFallback(recurringRows);
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

router.get('/make-booking', requireAdmin, (req, res) => {
  const accounts = repo.accounts.list();
  res.render('make_booking', withLocals({ accounts }));
});

router.get('/bookings', requireAdmin, (req, res) => {
  const bookings = repo.bookings.list({ limit: 200 });
  const recurringRows = recurring.list();
  const accounts = repo.accounts.list();
  const userById = Object.fromEntries(accounts.map(a => [a.id, a]));
  for (const r of recurringRows) {
    r.account_label = userById[r.account_id]?.label || null;
    r.account_username = userById[r.account_id]?.username || null;
  }
  res.render('bookings', withLocals({ bookings, accounts, recurringRows, format }));
});

router.get('/recurring', requireAdmin, (req, res) => {
  const recurringRows = recurring.list();
  const accounts = repo.accounts.list();
  const userById = Object.fromEntries(accounts.map(a => [a.id, a.username]));
  for (const r of recurringRows) r.account_username = userById[r.account_id] || null;
  annotateFallback(recurringRows);
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
  const scheduler = require('../agent/scheduler');
  const slotToTime = require('../kooroo/client').slotToTime;
  const targetSlot = scheduler.nextBookingTarget(r);
  let target = null;
  if (targetSlot) {
    const targetTime = slotToTime(targetSlot.from);
    const targetDow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][
      new Date(targetSlot.date + 'T00:00:00').getDay()
    ];
    target = {
      date: targetSlot.date,
      time: targetTime,
      dow: targetDow,
      prettyTime: format.formatTime12h(targetTime),
    };
  }
  // v3.6: detect "booked on fallback court" — the most recent successful
  // fire landed on a court that isn't the user's preferred one. This means
  // the preferred court was taken (by another account, an external human,
  // or a parallel fire) and the bot fell through to the next court in
  // the fallback order. Surface it in the UI so the user notices.
  const preferredApiCourt = recurring.COURT_TO_API[r.court_pref] || null;
  const lastBooked = events.find(e => e.status === 'booked' && e.court_booked);
  const bookedOnFallback = lastBooked && preferredApiCourt && String(lastBooked.court_booked) !== String(preferredApiCourt);
  const bookedOnCourt = lastBooked ? lastBooked.court_booked : null;
  res.render('recurring_detail', withLocals({
    recurring: r, events, bookings, account, format, query: req.query, target,
    fallback: bookedOnFallback ? { preferred: preferredApiCourt, actual: bookedOnCourt } : null,
  }));
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
