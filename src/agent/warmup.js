'use strict';

const repo = require('../db/repo');
const { KoorooClient } = require('../kooroo/client');
const endpoints = require('../kooroo/endpoints.json');
const state = require('./state');
const log = require('../logger');

const primed = new Map(); // accountId -> { headers, body, expiresAt, builtAt }

async function ensureFreshSession(accountId) {
  const account = repo.accounts.get(accountId);
  if (!account) throw new Error(`No such account: ${accountId}`);
  const client = new KoorooClient(account);
  await client.hydrateFromSession();
  const probe = await client.probe();
  if (!probe.ok) {
    state.transition(accountId, state.STATES.SESSION_EXPIRED, 'probe failed during warmup');
    const { reloginWithBrowser } = require('../kooroo/auth');
    try {
      await reloginWithBrowser(account);
      // re-hydrate with the new cookies
      const c2 = new KoorooClient(account);
      await c2.hydrateFromSession();
      const boot = await c2.bootstrapParams();
      if (!boot.ok) throw new Error('bootstrap failed after relogin: ' + boot.reason);
      state.transition(accountId, state.STATES.TESTED_OK, 'relogged in');
      return c2;
    } catch (e) {
      state.transition(accountId, state.STATES.LOGIN_REQUIRED, e.message);
      throw e;
    }
  }
  if (!client.userId) {
    const boot = await client.bootstrapParams();
    if (!boot.ok) throw new Error('bootstrap failed: ' + boot.reason);
  }
  return client;
}

// Parse the wordpress_logged_in_* cookie to extract the session expiry.
// Cookie value (URL-decoded): username|expiration|token|hash
function parseCookieExpiry(cookiesJson) {
  try {
    const cookies = JSON.parse(cookiesJson || '[]');
    for (const c of cookies) {
      if (typeof c.name === 'string' && c.name.startsWith('wordpress_logged_in_')) {
        const v = decodeURIComponent(c.value);
        const parts = v.split('|');
        if (parts.length >= 2) {
          const exp = parseInt(parts[1], 10);
          if (Number.isFinite(exp)) return new Date(exp * 1000).toISOString();
        }
      }
    }
  } catch {}
  return null;
}

function buildPrebuiltRequest({ date, from, to, court_id, user_id }) {
  const fields = {
    action: endpoints.api.actions.createBooking.name,
    date, from: String(from), to: String(to), court_id: String(court_id),
    user_id: String(user_id),
    first_day_of_week: '', last_day_of_week: '',
  };
  const body = new URLSearchParams(fields).toString();
  return body;
}

async function warm(accountId, opts = {}) {
  const { date, from, to, courtId, force = false } = opts;
  if (!date || !from || !to || !courtId) throw new Error('warm requires date, from, to, courtId');
  // existing primed entry? skip if fresh
  const existing = primed.get(accountId);
  if (existing && !force) {
    const ageMs = Date.now() - existing.builtAt;
    if (ageMs < 5 * 60_000) return existing; // fresh enough
  }
  const client = await ensureFreshSession(accountId);
  const body = buildPrebuiltRequest({ date, from, to, court_id: courtId, user_id: client.userId });
  // Best-effort parse cookie expiry for the UI
  const sess = repo.sessions.getByAccount(accountId);
  if (sess) {
    const exp = parseCookieExpiry(sess.cookies_json);
    if (exp) repo.accounts.setSessionExpiry(accountId, exp);
  }
  const entry = {
    accountId,
    body,
    date, from: String(from), to: String(to), courtId: String(courtId),
    userId: client.userId,
    contactId: client.contactId,
    builtAt: Date.now(),
  };
  primed.set(accountId, entry);
  state.transition(accountId, state.STATES.PRIMED, `armed for ${date} ${from}-${to} on court ${courtId}`);
  log.info('warm.primed', { accountId, date, from, to, courtId });
  return entry;
}

function getPrimed(accountId) {
  return primed.get(accountId) || null;
}

function clearPrimed(accountId) {
  primed.delete(accountId);
}

module.exports = { warm, getPrimed, clearPrimed, ensureFreshSession, buildPrebuiltRequest, parseCookieExpiry };
