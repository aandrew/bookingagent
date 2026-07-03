'use strict';

const cron = require('node-cron');
const config = require('../config');
const log = require('../logger');
const pool = require('./pool');
const repo = require('../db/repo');
const scheduler = require('./scheduler');

let probeTask;
let auditTask;

function start() {
  // Sub-second scheduler for recurring bookings
  scheduler.start();
  // Session probe every 10 min (re-login if needed)
  if (!probeTask) {
    probeTask = cron.schedule(config.sessionProbeCron, async () => {
      try {
        const r = await pool.probeAll();
        log.info('cron.probe', { count: r.length });
      } catch (e) {
        log.error('cron.probe.error', { error: e.message });
      }
    });
    log.info('cron.probe.started', { expr: config.sessionProbeCron });
  }
  // Daily audit prune at 03:00
  if (!auditTask) {
    auditTask = cron.schedule('0 3 * * *', () => {
      try {
        repo.audit.prune(config.audit.retentionDays);
        log.info('cron.audit.prune', { retentionDays: config.audit.retentionDays });
      } catch (e) {
        log.error('cron.audit.prune.error', { error: e.message });
      }
    });
    log.info('cron.audit.started', {});
  }
}

function stop() {
  scheduler.stop();
  for (const t of [probeTask, auditTask]) {
    try { t?.stop?.(); } catch {}
  }
  probeTask = auditTask = undefined;
  pool.shutdown();
}

module.exports = { start, stop };
