-- Kooroo Booking Agent schema (v2.1)
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

-- v2.1: account state machine columns
-- (added via migrate() in index.js for upgrades; declared here for fresh installs)
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
-- idx_bookings_recurring added in migrate() for upgrades; declared here for fresh installs is harmless because of IF NOT EXISTS

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

-- v2.1: recurring booking patterns
CREATE TABLE IF NOT EXISTS recurring_bookings (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label                   TEXT NOT NULL,
  court_pref              TEXT NOT NULL,
  courts                  TEXT NOT NULL,
  day_of_week             INTEGER NOT NULL,
  time                    TEXT NOT NULL,
  duration_mins           INTEGER NOT NULL DEFAULT 60,
  lead_minutes            INTEGER NOT NULL DEFAULT 10,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  next_fire_at            TEXT,
  last_fire_at            TEXT,
  last_status             TEXT,
  last_msg                TEXT,
  last_error_category     TEXT,
  error_dismissed_at      TEXT,
  first_occurrence_action TEXT,
  -- v3.4: the FIRST slot the user picked (the "anchor" of the weekly schedule).
  -- The first fire is scheduled 7 days before this date at the recurring's time
  -- (the opening moment). The chain then sets each subsequent fire to the
  -- just-booked slot's time (also the opening of the next slot). Nullable for
  -- backward compat with rows created before v3.4 — those use the
  -- nextWeekdayAt logic.
  first_slot_date         TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_account ON recurring_bookings(account_id);
CREATE INDEX IF NOT EXISTS idx_recurring_enabled ON recurring_bookings(enabled);
CREATE INDEX IF NOT EXISTS idx_recurring_next_fire ON recurring_bookings(next_fire_at);

-- v2.1: fire events
CREATE TABLE IF NOT EXISTS fire_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  recurring_id    INTEGER REFERENCES recurring_bookings(id) ON DELETE SET NULL,
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  scheduled_at    TEXT NOT NULL,
  fired_at        TEXT,
  status          TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  court_attempted TEXT,
  court_booked    TEXT,
  date            TEXT,
  time            TEXT,
  latency_ms      INTEGER,
  response_status INTEGER,
  response_body   TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fire_events_recurring ON fire_events(recurring_id);
CREATE INDEX IF NOT EXISTS idx_fire_events_scheduled ON fire_events(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_fire_events_status ON fire_events(status);
