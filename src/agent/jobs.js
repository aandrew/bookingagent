'use strict';

const cron = require('node-cron');
const config = require('../config');
const log = require('../logger');
const pool = require('./pool');
const repo = require('../db/repo');
const scheduler = require('./scheduler');

let probeTask;
let auditTask;
let backupTask;

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
  // v3: daily backup touch (writes a marker so the dashboard can show last-backup age)
  if (!backupTask) {
    backupTask = cron.schedule(config.backups.dailyCron, () => {
      try {
        const fs = require('fs');
        fs.mkdirSync(config.backups.dir, { recursive: true });
        const marker = {
          ran_at: new Date().toISOString(),
          host: require('os').hostname(),
        };
        fs.writeFileSync(`${config.backups.dir}/.last-run`, JSON.stringify(marker, null, 2));
        log.info('cron.backup.marker', marker);
      } catch (e) {
        log.error('cron.backup.error', { error: e.message });
      }
    });
    log.info('cron.backup.started', { expr: config.backups.dailyCron });
  }
}

function stop() {
  scheduler.stop();
  for (const t of [probeTask, auditTask, backupTask]) {
    try { t?.stop?.(); } catch {}
  }
  probeTask = auditTask = backupTask = undefined;
  pool.shutdown();
}

module.exports = { start, stop };
