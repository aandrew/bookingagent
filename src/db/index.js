'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

let db;

function init() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

function migrate(d) {
  // Idempotent column adds for upgrades from earlier schemas.
  const add = (sql) => { try { d.exec(sql); } catch (e) { /* duplicate column = ok */ } };
  add(`ALTER TABLE accounts ADD COLUMN state TEXT NOT NULL DEFAULT 'waiting'`);
  add(`ALTER TABLE accounts ADD COLUMN state_msg TEXT`);
  add(`ALTER TABLE accounts ADD COLUMN state_updated_at TEXT`);
  add(`ALTER TABLE accounts ADD COLUMN session_expires_at TEXT`);
  add(`ALTER TABLE bookings ADD COLUMN recurring_id INTEGER REFERENCES recurring_bookings(id) ON DELETE SET NULL`);
  add(`CREATE INDEX IF NOT EXISTS idx_bookings_recurring ON bookings(recurring_id)`);
  add(`ALTER TABLE recurring_bookings ADD COLUMN last_error_category TEXT`);
  add(`ALTER TABLE recurring_bookings ADD COLUMN error_dismissed_at TEXT`);
  add(`ALTER TABLE recurring_bookings ADD COLUMN first_occurrence_action TEXT`);
  add(`ALTER TABLE recurring_bookings ADD COLUMN first_slot_date TEXT`);
  add(`ALTER TABLE watches ADD COLUMN fired_at TEXT`);
}

function get() {
  return db || init();
}

function close() {
  if (db) {
    db.close();
    db = undefined;
  }
}

module.exports = { init, get, close };
