'use strict';

const { KoorooClient } = require('../kooroo/client');
const { login, probeSession, reloginWithBrowser } = require('../kooroo/auth');
const repo = require('../db/repo');
const log = require('../logger');

const clients = new Map();

async function clientFor(accountId) {
  if (clients.has(accountId)) return clients.get(accountId);
  const account = repo.accounts.get(accountId);
  if (!account) throw new Error(`No such account: ${accountId}`);
  const c = new KoorooClient(account);
  await c.hydrateFromSession();
  clients.set(accountId, c);
  return c;
}

function forget(accountId) {
  clients.delete(accountId);
}

async function ensureSession(accountId) {
  const account = repo.accounts.get(accountId);
  if (!account) throw new Error(`No such account: ${accountId}`);
  let client;
  try {
    client = await clientFor(accountId);
    const probe = await client.probe();
    if (probe.ok) {
      if (!client.userId) await client.bootstrapParams();
      return client;
    }
  } catch {}
  // Try a one-shot browser re-login (handles reCAPTCHA).
  log.info('pool.relogin', { account: account.username });
  await reloginWithBrowser(account);
  forget(accountId);
  return clientFor(accountId);
}

async function withClient(accountId, fn) {
  const c = await ensureSession(accountId);
  try {
    return await fn(c);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      log.warn('pool.session-stale', { accountId, status: e.status });
      forget(accountId);
      const c2 = await ensureSession(accountId);
      return fn(c2);
    }
    throw e;
  }
}

async function probeAll() {
  const out = [];
  for (const account of repo.accounts.list()) {
    if (!account.enabled) { out.push({ id: account.id, username: account.username, enabled: false }); continue; }
    try {
      const c = await clientFor(account.id);
      const probe = await probeSession(c);
      out.push({ id: account.id, username: account.username, ok: probe.ok, status: probe.status, reason: probe.reason || probe.error || null });
      repo.accounts.touchCheck(account.id);
      if (!probe.ok) {
        try {
          await reloginWithBrowser(account);
          forget(account.id);
          out[out.length - 1].reloggedIn = true;
        } catch (e) {
          out[out.length - 1].reloginError = e.message;
        }
      }
    } catch (e) {
      out.push({ id: account.id, username: account.username, ok: false, error: e.message });
    }
  }
  return out;
}

function shutdown() { clients.clear(); }

module.exports = { clientFor, ensureSession, withClient, probeAll, forget, shutdown };
