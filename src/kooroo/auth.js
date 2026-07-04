'use strict';

const { KoorooClient, slotToTime, timeToSlot } = require('./client');
const repo = require('../db/repo');
const log = require('../logger');

async function login(account, { username, password } = {}) {
  const client = new KoorooClient(account);
  await client.hydrateFromSession();
  // If we already have a session, just bootstrap params.
  const probe = await client.probe();
  if (probe.ok) {
    if (!client.userId) {
      const boot = await client.bootstrapParams();
      if (!boot.ok) throw new Error('session ok but param bootstrap failed: ' + boot.reason);
    }
    repo.accounts.recordLogin(account.id, true, 'session ok');
    return { status: 200, body: { ok: true, user_id: client.userId } };
  }
  // No session. The runtime path cannot defeat reCAPTCHA. The caller should
  // use tools/relogin-browser.js or the /api/accounts/:id/relogin route.
  repo.accounts.recordLogin(account.id, false, probe.status ? `HTTP ${probe.status}` : probe.error || 'no session');
  throw new Error('No usable session. Run `npm run spike` then `node tools/import-session.js --probe` to capture one.');
}

async function probeSession(client) {
  try {
    return await client.probe();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function reloginWithBrowser(account) {
  // Spawns Playwright in headless mode, drives the login form, and re-imports
  // the resulting session. Returns the same shape as login().
  const { spawnSync } = require('child_process');
  const path = require('path');
  const config = require('../config');
  // 90s is enough for the spike on a clean reCAPTCHA pass; this keeps the
  // scheduler sessionCheckTimer bounded so a stuck Playwright can't block
  // the warmup that follows.
  const SPIKE_TIMEOUT_MS = 90_000;
  const IMPORT_TIMEOUT_MS = 30_000;
  const env = {
    ...process.env,
    KOOROO_SPIKE_USER: account.username,
    KOOROO_SPIKE_PASS: account.password,
    DATA_DIR: config.dataDir,
    SPIKE_HEADED: '0',
  };
  const spike = path.join(__dirname, '..', '..', 'tools', 'spike-login.js');
  const res = spawnSync('node', [spike], { env, encoding: 'utf8', timeout: SPIKE_TIMEOUT_MS });
  if (res.status !== 0) {
    const errMsg = (res.stderr || '').slice(-500) || (res.stdout || '').slice(-500) || `exit ${res.status} signal ${res.signal}`;
    throw new Error(`spike failed: ${errMsg}`);
  }
  // Re-import the freshly captured session.
  const importer = path.join(__dirname, '..', '..', 'tools', 'import-session.js');
  const imp = spawnSync('node', [importer, '--label', account.label, '--username', account.username, '--probe'], {
    env, encoding: 'utf8', timeout: IMPORT_TIMEOUT_MS,
  });
  if (imp.status !== 0) {
    const errMsg = (imp.stderr || '').slice(-500) || (imp.stdout || '').slice(-500) || `exit ${imp.status} signal ${imp.signal}`;
    throw new Error(`import failed: ${errMsg}`);
  }
  return { status: 200, body: { ok: true, reloggedIn: true } };
}

module.exports = { login, probeSession, reloginWithBrowser };
