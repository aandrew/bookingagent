-- Kooroo Booking Agent schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  username        TEXT NOT NULL,
  password        TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_login_at   TEXT,
  last_check_at   TEXT,
  last_login_ok   INTEGER,
  last_login_msg  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  cookies_json    TEXT NOT NULL,
  bearer_token    TEXT,
  csrf_token      TEXT,
  user_json       TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  court           TEXT,
  date_from       TEXT,
  date_to         TEXT,
  time_start      TEXT,
  time_end        TEXT,
  duration_mins   INTEGER NOT NULL DEFAULT 60,
  strategy        TEXT NOT NULL DEFAULT 'watch',
  lead_days       INTEGER NOT NULL DEFAULT 7,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  last_status     TEXT,
  last_msg        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_watches_account ON watches(account_id);

CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  watch_id        INTEGER REFERENCES watches(id) ON DELETE SET NULL,
  court           TEXT,
  date            TEXT,
  start_time      TEXT,
  end_time        TEXT,
  status          TEXT NOT NULL,
  external_id     TEXT,
  raw_json        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_account ON bookings(account_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  direction       TEXT NOT NULL,
  method          TEXT,
  url             TEXT,
  status          INTEGER,
  latency_ms      INTEGER,
  request_body    TEXT,
  response_body   TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
