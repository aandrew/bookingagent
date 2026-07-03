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
    const info = stmt.run(
      w.account_id, w.label, w.court || null, w.date_from || null, w.date_to || null,
      w.time_start || null, w.time_end || null, w.duration_mins || 60,
      w.strategy || 'watch', w.lead_days ?? 7, w.enabled === false ? 0 : 1, nowIso(), nowIso()
    );
    return watches.get(info.lastInsertRowid);
  },
  update(id, fields) {
    const allowed = ['label','court','date_from','date_to','time_start','time_end','duration_mins','strategy','lead_days','enabled'];
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
      `INSERT INTO bookings (account_id, watch_id, court, date, start_time, end_time, status, external_id, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      b.account_id, b.watch_id || null, b.court || null, b.date || null,
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

module.exports = { accounts, sessions, watches, bookings, audit };
