'use strict';

const repo = require('../db/repo');
const log = require('../logger');

const STATES = {
  WAITING:        'waiting',         // credentials added, not yet tested
  TESTED_OK:      'tested_ok',       // logged in, params bootstrapped
  TOKEN_READY:    'token_ready',     // fresh session, ready to attempt
  PRIMED:         'primed',          // token fresh + prebuilt request ready
  FIRST_IMMEDIATE:'first_immediate', // first-occurrence is inside 7d window, attempting now
  ATTEMPTING:     'attempting',      // POST in flight
  BOOKED:         'booked',          // last attempt was successful
  FAILED:         'failed',          // last attempt failed
  SESSION_EXPIRED:'session_expired', // probe failed, needs relogin
  LOGIN_REQUIRED: 'login_required',  // couldn't relogin during warmup
  ERROR:          'error',           // unrecoverable error
};

const TRANSITIONS = {
  waiting: ['tested_ok', 'session_expired', 'error'],
  tested_ok: ['token_ready', 'session_expired', 'error'],
  token_ready: ['primed', 'attempting', 'first_immediate', 'session_expired', 'error'],
  primed: ['attempting', 'session_expired', 'error'],
  first_immediate: ['attempting', 'booked', 'failed', 'error'],
  attempting: ['booked', 'failed', 'session_expired', 'error', 'login_required'],
  booked: ['token_ready', 'primed', 'first_immediate'],
  failed: ['token_ready', 'primed', 'first_immediate'],
  session_expired: ['tested_ok', 'token_ready', 'login_required', 'error'],
  login_required: ['tested_ok', 'error'],
  error: ['tested_ok', 'error'],
};

function isValidTransition(from, to) {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

function transition(accountId, newState, msg = null) {
  const account = repo.accounts.get(accountId);
  if (!account) throw new Error(`No such account: ${accountId}`);
  const cur = account.state || STATES.WAITING;
  if (!isValidTransition(cur, newState)) {
    log.warn('state.invalid-transition', { accountId, from: cur, to: newState });
  }
  repo.accounts.setState(accountId, newState, msg);
  log.info('state.transition', { accountId, username: account.username, from: cur, to: newState, msg });
  return { from: cur, to: newState };
}

function get(accountId) {
  const a = repo.accounts.get(accountId);
  if (!a) return null;
  return { state: a.state || STATES.WAITING, msg: a.state_msg, updatedAt: a.state_updated_at };
}

function listAll() {
  return repo.accounts.list().map(a => ({ id: a.id, username: a.username, label: a.label, state: a.state, state_msg: a.state_msg, state_updated_at: a.state_updated_at }));
}

module.exports = { STATES, transition, get, listAll, isValidTransition };
