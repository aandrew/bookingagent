'use strict';

const cron = require('node-cron');
const config = require('../config');
const log = require('../logger');
const pool = require('./pool');
const repo = require('../db/repo');
const scheduler = require('./scheduler');
const monitor = require('./monitor');

let auditTask;
let backupTask;
let dueWatchesTask;

function start() {
  // Sub-second scheduler for recurring bookings
  scheduler.start();
  // v3.5: fire any due non-recurring watches every minute. A watch is
  // "due" when its date_from is within the 7-day booking window and it
  // hasn't already fired (fired_at is null). After firing, fired_at is
  // set and the cron skips it, so the booking doesn't get repeatedly
  // rescheduled.
  if (!dueWatchesTask) {
    dueWatchesTask = cron.schedule('*/1 * * * *', async () => {
      try {
        const r = await monitor.fireDueWatches();
        if (r.fired > 0) log.info('cron.fire-due-watches', r);
      } catch (e) {
        log.error('cron.fire-due-watches.error', { error: e.message });
      }
    });
    log.info('cron.fire-due-watches.started', {});
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
  for (const t of [dueWatchesTask, auditTask, backupTask]) {
    try { t?.stop?.(); } catch {}
  }
  dueWatchesTask = auditTask = backupTask = undefined;
  pool.shutdown();
}

module.exports = { start, stop };
