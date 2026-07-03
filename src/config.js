'use strict';

require('dotenv').config();
const path = require('path');

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function intEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

function boolEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

const config = {
  kooroo: {
    baseUrl: (process.env.KOOROO_BASE_URL || 'https://kooroora.asn.au').replace(/\/+$/, ''),
  },
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    pass: process.env.ADMIN_PASS || 'change-me-please',
  },
  session: {
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
    cookieMaxAgeMs: 1000 * 60 * 60 * 12,
  },
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  dbPath: process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'bookingagent.sqlite'),
  port: intEnv('PORT', 3000),
  bind: process.env.BIND || '0.0.0.0',
  pollCron: process.env.POLL_CRON || '*/2 * * * *',
  sessionProbeCron: process.env.SESSION_PROBE_CRON || '*/10 * * * *',
  defaultLeadDays: intEnv('DEFAULT_LEAD_DAYS', 7),
  defaultLeadMinutesBeforeFire: intEnv('LEAD_MINUTES_BEFORE_FIRE', 5),
  backups: {
    retentionDays: intEnv('BACKUP_RETENTION_DAYS', 30),
    dailyCron: process.env.BACKUP_CRON || '30 2 * * *',
    dir: process.env.BACKUP_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), '..', 'backups'),
  },
  audit: {
    fullBodies: boolEnv('AUDIT_FULL_BODIES', true),
    retentionDays: intEnv('AUDIT_RETENTION_DAYS', 30),
  },
  nodeEnv: process.env.NODE_ENV || 'development',
};

module.exports = config;
module.exports.required = required;
