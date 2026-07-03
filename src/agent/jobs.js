'use strict';

const cron = require('node-cron');
const config = require('../config');
const log = require('../logger');
const monitor = require('./monitor');
const pool = require('./pool');
const repo = require('../db/repo');

let monitorTask;
let probeTask;
let auditTask;

function start() {
  if (!monitorTask) {
    monitorTask = cron.schedule(config.pollCron, async () => {
      const t0 = Date.now();
      try {
        const r = await monitor.runAll();
        log.info('cron.monitor', { count: r.length, ms: Date.now() - t0 });
      } catch (e) {
        log.error('cron.monitor.error', { error: e.message });
      }
    });
    log.info('cron.monitor.started', { expr: config.pollCron });
  }
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
  for (const t of [monitorTask, probeTask, auditTask]) {
    try { t?.stop?.(); } catch {}
  }
  monitorTask = probeTask = auditTask = undefined;
  pool.shutdown();
}

module.exports = { start, stop };
