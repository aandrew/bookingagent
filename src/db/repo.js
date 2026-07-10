'use strict';

const db = require('./index');

function nowIso() { return new Date().toISOString(); }

const accounts = {
  list() {
    return db.get().prepare(`SELECT * FROM accounts ORDER BY id ASC`).all();
  },
  get(id) {
    return db.get().prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
  },
  byUsername(username) {
    return db.get().prepare(`SELECT * FROM accounts WHERE username = ?`).get(username);
  },
  create({ label, username, password }) {
    const stmt = db.get().prepare(
      `INSERT INTO accounts (label, username, password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const info = stmt.run(label, username, password, nowIso(), nowIso());
    return accounts.get(info.lastInsertRowid);
  },
  update(id, fields) {
    const allowed = ['label', 'username', 'password', 'enabled'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if (sets.length === 0) return accounts.get(id);
    sets.push(`updated_at = ?`); vals.push(nowIso()); vals.push(id);
    db.get().prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return accounts.get(id);
  },
  remove(id) {
    db.get().prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  },
  recordLogin(id, ok, msg) {
    db.get().prepare(
      `UPDATE accounts SET last_login_at = ?, last_login_ok = ?, last_login_msg = ?, updated_at = ? WHERE id = ?`
    ).run(nowIso(), ok ? 1 : 0, msg || null, nowIso(), id);
  },
  touchCheck(id) {
    db.get().prepare(`UPDATE accounts SET last_check_at = ?, updated_at = ? WHERE id = ?`)
      .run(nowIso(), nowIso(), id);
  },
  setState(id, state, msg = null) {
    db.get().prepare(
      `UPDATE accounts SET state = ?, state_msg = ?, state_updated_at = ?, updated_at = ? WHERE id = ?`
    ).run(state, msg, nowIso(), nowIso(), id);
    return accounts.get(id);
  },
  setSessionExpiry(id, expiresAt) {
    db.get().prepare(
      `UPDATE accounts SET session_expires_at = ?, updated_at = ? WHERE id = ?`
    ).run(expiresAt, nowIso(), id);
  },
};

const sessions = {
  getByAccount(accountId) {
    return db.get().prepare(`SELECT * FROM sessions WHERE account_id = ?`).get(accountId);
  },
  upsert({ accountId, cookiesJson, bearerToken, csrfToken, userJson, expiresAt }) {
    const existing = sessions.getByAccount(accountId);
    if (existing) {
      db.get().prepare(
        `UPDATE sessions SET cookies_json = ?, bearer_token = ?, csrf_token = ?, user_json = ?, expires_at = ?, updated_at = ? WHERE account_id = ?`
      ).run(JSON.stringify(cookiesJson || []), bearerToken || null, csrfToken || null, userJson ? JSON.stringify(userJson) : null, expiresAt || null, nowIso(), accountId);
    } else {
      db.get().prepare(
        `INSERT INTO sessions (account_id, cookies_json, bearer_token, csrf_token, user_json, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(accountId, JSON.stringify(cookiesJson || []), bearerToken || null, csrfToken || null, userJson ? JSON.stringify(userJson) : null, expiresAt || null, nowIso(), nowIso());
    }
  },
  clear(accountId) {
    db.get().prepare(`DELETE FROM sessions WHERE account_id = ?`).run(accountId);
  },
};

const watches = {
  list() {
    return db.get().prepare(`SELECT * FROM watches ORDER BY id ASC`).all();
  },
  listForAccount(accountId) {
    return db.get().prepare(`SELECT * FROM watches WHERE account_id = ? ORDER BY id ASC`).all(accountId);
  },
  get(id) {
    return db.get().prepare(`SELECT * FROM watches WHERE id = ?`).get(id);
  },
  create(w) {
    const stmt = db.get().prepare(
      `INSERT INTO watches (account_id, label, court, date_from, date_to, time_start, time_end, duration_mins, strategy, lead_days, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Note: `0 === false` is `false` in JS (strict equality), so we have to
    // check for both 0 and false explicitly to honour `enabled: 0` or
    // `enabled: false`. Missing/undefined defaults to enabled (1).
    const enabledVal = (w.enabled === false || w.enabled === 0) ? 0 : 1;
    const info = stmt.run(
      w.account_id, w.label, w.court || null, w.date_from || null, w.date_to || null,
      w.time_start || null, w.time_end || null, w.duration_mins || 60,
      w.strategy || 'watch', w.lead_days ?? 7, enabledVal, nowIso(), nowIso()
    );
    return watches.get(info.lastInsertRowid);
  },
  update(id, fields) {
    const allowed = ['label','court','date_from','date_to','time_start','time_end','duration_mins','strategy','lead_days','enabled','fired_at'];
    const sets = []; const vals = [];
    for (const k of allowed) if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    if (!sets.length) return watches.get(id);
    sets.push(`updated_at = ?`); vals.push(nowIso()); vals.push(id);
    db.get().prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return watches.get(id);
  },
  remove(id) {
    db.get().prepare(`DELETE FROM watches WHERE id = ?`).run(id);
  },
  recordRun(id, status, msg) {
    db.get().prepare(
      `UPDATE watches SET last_run_at = ?, last_status = ?, last_msg = ?, updated_at = ? WHERE id = ?`
    ).run(nowIso(), status, msg || null, nowIso(), id);
  },
  // v3.5: mark a watch as fired. The fire-due-watches cron skips watches
  // with fired_at set, so non-recurring bookings don't get repeatedly
  // rescheduled.
  setFired(id, firedAt) {
    db.get().prepare(
      `UPDATE watches SET fired_at = ?, updated_at = ? WHERE id = ?`
    ).run(firedAt || nowIso(), nowIso(), id);
  },
};

const bookings = {
  list({ limit = 100, status = null } = {}) {
    let q = `SELECT * FROM bookings`;
    const args = [];
    if (status) { q += ` WHERE status = ?`; args.push(status); }
    q += ` ORDER BY id DESC LIMIT ?`; args.push(limit);
    return db.get().prepare(q).all(...args);
  },
  create(b) {
    const stmt = db.get().prepare(
      `INSERT INTO bookings (account_id, watch_id, recurring_id, court, date, start_time, end_time, status, external_id, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      b.account_id, b.watch_id || null, b.recurring_id || null, b.court || null, b.date || null,
      b.start_time || null, b.end_time || null, b.status, b.external_id || null,
      b.raw_json ? JSON.stringify(b.raw_json) : null, nowIso()
    );
    return bookings.get(info.lastInsertRowid);
  },
  get(id) {
    return db.get().prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
  },
  update(id, fields) {
    const allowed = ['status', 'external_id', 'raw_json'];
    const sets = []; const vals = [];
    for (const k of allowed) if (k in fields) { sets.push(`${k} = ?`); vals.push(k === 'raw_json' ? JSON.stringify(fields[k]) : fields[k]); }
    if (!sets.length) return bookings.get(id);
    vals.push(id);
    db.get().prepare(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return bookings.get(id);
  },
  listForRecurring(recurringId, limit = 50) {
    return db.get().prepare(`SELECT * FROM bookings WHERE recurring_id = ? ORDER BY id DESC LIMIT ?`).all(recurringId, limit);
  },
  listUnverified({ olderThanMs = 30_000, limit = 50 } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return db.get().prepare(`
      SELECT * FROM bookings
      WHERE status = 'booked_unverified'
        AND external_id IS NULL
        AND created_at < ?
      ORDER BY id ASC
      LIMIT ?
    `).all(cutoff, limit);
  },
  markVerified(id, externalId) {
    return bookings.update(id, { status: 'confirmed', external_id: String(externalId) });
  },
};

const recurring = {
  list({ enabled = null, accountId = null } = {}) {
    let q = `SELECT * FROM recurring_bookings`;
    const args = [];
    const conds = [];
    if (enabled !== null) { conds.push('enabled = ?'); args.push(enabled ? 1 : 0); }
    if (accountId) { conds.push('account_id = ?'); args.push(accountId); }
    if (conds.length) q += ` WHERE ${conds.join(' AND ')}`;
    q += ` ORDER BY id ASC`;
    return db.get().prepare(q).all(...args);
  },
  get(id) {
    return db.get().prepare(`SELECT * FROM recurring_bookings WHERE id = ?`).get(id);
  },
  create(r) {
    const stmt = db.get().prepare(
      `INSERT INTO recurring_bookings (account_id, label, court_pref, courts, day_of_week, time, duration_mins, lead_minutes, enabled, first_occurrence_action, next_fire_at, first_slot_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Honour `enabled: 0` or `enabled: false` (see watches.create for the
    // same fix — `0 === false` is false in strict equality).
    const enabledVal = (r.enabled === false || r.enabled === 0) ? 0 : 1;
    const info = stmt.run(
      r.account_id, r.label, r.court_pref, JSON.stringify(r.courts || [r.court_pref]),
      r.day_of_week, r.time, r.duration_mins || 60, r.lead_minutes || 10,
      enabledVal,
      r.first_occurrence_action || null, r.next_fire_at || null,
      r.first_slot_date || null,
      nowIso(), nowIso()
    );
    return recurring.get(info.lastInsertRowid);
  },

  update(id, fields) {
    const allowed = ['label', 'court_pref', 'courts', 'day_of_week', 'time', 'duration_mins', 'lead_minutes', 'enabled', 'next_fire_at', 'last_fire_at', 'last_status', 'last_msg', 'last_error_category', 'error_dismissed_at', 'first_occurrence_action', 'first_slot_date'];
    const sets = []; const vals = [];
    for (const k of allowed) if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(k === 'courts' ? JSON.stringify(fields[k]) : fields[k]);
    }
    if (!sets.length) return recurring.get(id);
    sets.push('updated_at = ?'); vals.push(nowIso()); vals.push(id);
    db.get().prepare(`UPDATE recurring_bookings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return recurring.get(id);
  },
  remove(id) {
    db.get().prepare(`DELETE FROM recurring_bookings WHERE id = ?`).run(id);
  },
  setNextFire(id, nextFireAt) {
    return recurring.update(id, { next_fire_at: nextFireAt });
  },
  setLastResult(id, { status, msg, category }) {
    return recurring.update(id, {
      last_fire_at: nowIso(),
      last_status: status,
      last_msg: msg,
      last_error_category: category || null,
    });
  },
  dismissError(id) {
    return recurring.update(id, { error_dismissed_at: nowIso() });
  },
  // For the banner: any enabled recurring with an un-dismissed error
  listUnacknowledgedErrors() {
    return db.get().prepare(`
      SELECT r.*, a.label AS account_label, a.username AS account_username
      FROM recurring_bookings r
      JOIN accounts a ON a.id = r.account_id
      WHERE r.enabled = 1
        AND r.last_status IS NOT NULL
        AND r.last_status IN ('no_time_available', 'technical_error', 'failed', 'login_required')
        AND (r.error_dismissed_at IS NULL OR r.error_dismissed_at < r.last_fire_at)
      ORDER BY r.last_fire_at DESC
    `).all();
  },
};

const fireEvents = {
  create(e) {
    const stmt = db.get().prepare(
      `INSERT INTO fire_events (recurring_id, account_id, scheduled_at, fired_at, status, attempt, court_attempted, court_booked, date, time, latency_ms, response_status, response_body, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      e.recurring_id || null, e.account_id || null, e.scheduled_at, e.fired_at || null,
      e.status, e.attempt || 1, e.court_attempted || null, e.court_booked || null,
      e.date || null, e.time || null, e.latency_ms || null, e.response_status || null,
      e.response_body ? String(e.response_body).slice(0, 200_000) : null,
      e.error || null, nowIso()
    );
    return fireEvents.get(info.lastInsertRowid);
  },
  get(id) { return db.get().prepare(`SELECT * FROM fire_events WHERE id = ?`).get(id); },
  list({ limit = 100, recurringId = null, accountId = null, status = null } = {}) {
    let q = `SELECT * FROM fire_events`;
    const args = [];
    const conds = [];
    if (recurringId) { conds.push('recurring_id = ?'); args.push(recurringId); }
    if (accountId) { conds.push('account_id = ?'); args.push(accountId); }
    if (status) { conds.push('status = ?'); args.push(status); }
    if (conds.length) q += ` WHERE ${conds.join(' AND ')}`;
    q += ` ORDER BY id DESC LIMIT ?`; args.push(limit);
    return db.get().prepare(q).all(...args);
  },
};

const audit = {
  add(entry) {
    const stmt = db.get().prepare(
      `INSERT INTO audit_log (ts, account_id, direction, method, url, status, latency_ms, request_body, response_body, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      nowIso(), entry.account_id || null, entry.direction, entry.method || null,
      entry.url || null, entry.status || null, entry.latency_ms || null,
      entry.request_body || null, entry.response_body || null, entry.error || null
    );
  },
  list({ limit = 100, accountId = null } = {}) {
    let q = `SELECT * FROM audit_log`;
    const args = [];
    if (accountId) { q += ` WHERE account_id = ?`; args.push(accountId); }
    q += ` ORDER BY id DESC LIMIT ?`; args.push(limit);
    return db.get().prepare(q).all(...args);
  },
  prune(retentionDays) {
    db.get().prepare(
      `DELETE FROM audit_log WHERE ts < datetime('now', ?)`
    ).run(`-${retentionDays} days`);
  },
};

module.exports = { accounts, sessions, watches, bookings, audit, recurring, fireEvents };
