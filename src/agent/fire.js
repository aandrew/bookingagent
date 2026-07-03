'use strict';

const endpoints = require('../kooroo/endpoints.json');
const { Agent, fetch: undiciFetch } = require('undici');
const repo = require('../db/repo');
const state = require('./state');
const log = require('../logger');
const { findBookingFor } = require('../kooroo/booking');
const { slotToTime, timeToSlot } = require('../kooroo/client');
const { waitUntilExact } = require('./time');

const dispatcher = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  connections: 16,
  pipelining: 1,
});

const API_PATH = endpoints.api.endpoint.replace(endpoints.baseUrl, '');

function categorize({ status, body, error }) {
  if (error) return { code: 'technical_error', reason: 'network', detail: error };
  if (status === 401 || status === 403) return { code: 'technical_error', reason: 'auth_required' };
  if (status >= 500) return { code: 'technical_error', reason: 'http_5xx', detail: body?.message };
  if (body?.message && /booking has been made/i.test(body.message)) return { code: 'booked' };
  // Server uses 404 for several non-success cases. Decode the message.
  if (body?.message) {
    const m = body.message;
    if (/already booked by a member/i.test(m))
      return { code: 'no_time_available', reason: 'already_booked' };
    if (/does not exist/i.test(m))
      return { code: 'technical_error', reason: 'court_invalid', detail: m };
    if (/cannot be made yet|wait until the time is allowed/i.test(m))
      return { code: 'technical_error', reason: 'window_not_open', detail: m };
    if (/unavailable|taken|not available|court is closed|is closed|conflict|double|slot/i.test(m))
      return { code: 'no_time_available', reason: m };
  }
  if (body?.status && body.status !== 200) return { code: 'no_time_available', reason: body?.message || 'slot_taken' };
  if (status === 404) return { code: 'no_time_available', reason: body?.message || 'slot_taken' };
  return { code: 'technical_error', reason: 'unexpected_response', detail: body };
}

async function postCreate(client, { body, signal, timeoutMs = 1500 }) {
  const url = endpoints.api.endpoint;
  const headers = {
    'user-agent': 'kooroo-booking-agent/0.2 (+local)',
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };
  const ck = client.cookieHeader();
  if (ck) headers.cookie = ck;
  const t0 = Date.now();
  let res, text, err = null;
  try {
    res = await undiciFetch(url, { method: 'POST', headers, body, dispatcher, signal, bodyTimeout: timeoutMs, headersTimeout: 1000 });
    text = await res.text();
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      try { const { Cookie } = require('tough-cookie'); const ck = Cookie.parse(sc); if (ck) await client.jar.setCookie(ck, endpoints.baseUrl); } catch {}
    }
  } catch (e) {
    err = e.message;
  }
  const latency = Date.now() - t0;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res ? res.status : 0, body: parsed, raw: text, latency_ms: latency, error: err };
}

function ac(body) {
  return body && typeof body === 'object' ? body : {};
}

// Try the courts in order, with a short timeout. Returns the first success
// or the most informative failure.
async function fireCourts(client, { date, from, to, courts, dateStr, timeStr, attempt = 1, onAttempt }) {
  let lastCat = null;
  for (let i = 0; i < courts.length; i++) {
    const courtId = String(courts[i]);
    const body = new URLSearchParams({
      action: endpoints.api.actions.createBooking.name,
      date, from: String(from), to: String(to), court_id: courtId,
      user_id: String(client.userId),
      first_day_of_week: '', last_day_of_week: '',
    }).toString();
    if (onAttempt) onAttempt({ courtId, attempt, idx: i });
    const r = await postCreate(client, { body });
    const cat = categorize(r);
    if (cat.code === 'booked') {
      return { ...r, courtId, category: cat };
    }
    lastCat = cat;
    // For 401/403 stop early — no point trying other courts with a dead session.
    if (cat.reason === 'auth_required') {
      return { ...r, courtId, category: cat, stopChain: true };
    }
  }
  return { status: lastCat?.code === 'no_time_available' ? 200 : 0, body: null, latency_ms: 0, courtId: null, category: lastCat, stopChain: lastCat?.reason === 'auth_required' };
}

// Scheduled fire at the exact targetMs. Tries courts in order, fast.
async function fireScheduled({ recurring, targetMs, client, primed }) {
  state.transition(recurring.account_id, state.STATES.FIRING, `fire at ${new Date(targetMs).toISOString()}`);
  const { date, from, to, courtId } = primed;
  const result = await fireCourts(client, {
    date, from, to,
    courts: [courtId, ...recurring.courts.filter(c => c !== courtId)],
    dateStr: date, timeStr: '',
    attempt: 1,
    onAttempt: ({ courtId: cid, attempt, idx }) => {
      repo.fireEvents.create({
        recurring_id: recurring.id, account_id: recurring.account_id,
        scheduled_at: new Date(targetMs).toISOString(),
        status: 'firing', attempt, court_attempted: cid,
        date, time: slotToTime(from),
      });
    },
  });
  const firedAt = new Date().toISOString();
  return { ...result, firedAt, recurring, primed };
}

async function recordAndPersistScheduledFire({ recurring, targetMs, client, primed, result }) {
  const cat = result.category;
  const externalId = cat.code === 'booked' ? (await findBookingFor(client, {
    date: primed.date, from: primed.from, to: primed.to, court_id: primed.courtId,
  }))?.id : null;
  repo.fireEvents.create({
    recurring_id: recurring.id, account_id: recurring.account_id,
    scheduled_at: new Date(targetMs).toISOString(),
    fired_at: result.firedAt,
    status: cat.code,
    attempt: 1,
    court_attempted: result.courtId,
    court_booked: cat.code === 'booked' ? primed.courtId : null,
    date: primed.date, time: slotToTime(primed.from),
    latency_ms: result.latency_ms,
    response_status: result.status,
    response_body: JSON.stringify(ac(result.body)).slice(0, 8000),
    error: cat.detail || cat.reason,
  });
  if (cat.code === 'booked') {
    repo.bookings.create({
      account_id: recurring.account_id,
      recurring_id: recurring.id,
      court: primed.courtId,
      date: primed.date,
      start_time: slotToTime(primed.from),
      end_time: slotToTime(primed.to),
      status: 'confirmed',
      external_id: externalId,
      raw_json: result.body,
    });
    state.transition(recurring.account_id, state.STATES.BOOKED, `booked court ${primed.courtId} on ${primed.date}`);
  } else if (cat.reason === 'auth_required') {
    state.transition(recurring.account_id, state.STATES.SESSION_EXPIRED, cat.detail || 'auth required');
  } else {
    state.transition(recurring.account_id, state.STATES.FAILED, cat.detail || cat.reason);
  }
  repo.recurring.setLastResult(recurring.id, { status: cat.code, msg: cat.detail || cat.reason, category: cat.code === 'booked' ? null : (cat.code === 'no_time_available' ? 'no_time_available' : 'technical_error') });
  return { category: cat, externalId, result };
}

// First-immediate: book now, retry up to 2 more times (15s gap) on failure.
// On full failure, write "3 bookings failed to succeed".
async function fireImmediate({ recurring, client, primed, onProgress }) {
  const { date, from, to } = primed;
  const courts = [recurring.court_pref, ...recurring.courts.filter(c => c !== recurring.court_pref)];
  const attempts = [];
  let booked = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    state.transition(recurring.account_id, state.STATES.FIRING, `immediate attempt ${attempt}/3`);
    if (onProgress) onProgress({ attempt, phase: 'firing' });
    const result = await fireCourts(client, { date, from, to, courts, attempt, onAttempt: ({ courtId }) => {
      repo.fireEvents.create({
        recurring_id: recurring.id, account_id: recurring.account_id,
        scheduled_at: new Date().toISOString(),
        status: 'firing', attempt, court_attempted: courtId,
        date, time: slotToTime(from),
      });
    }});
    const cat = result.category;
    const firedAt = new Date().toISOString();
    attempts.push({ attempt, category: cat, courtId: result.courtId, latency_ms: result.latency_ms });
    if (cat.code === 'booked') {
      const externalId = (await findBookingFor(client, { date, from, to, court_id: result.courtId }))?.id;
      repo.fireEvents.create({
        recurring_id: recurring.id, account_id: recurring.account_id,
        scheduled_at: firedAt, fired_at: firedAt, status: 'booked', attempt,
        court_attempted: result.courtId, court_booked: result.courtId,
        date, time: slotToTime(from),
        latency_ms: result.latency_ms, response_status: result.status,
        response_body: JSON.stringify(ac(result.body)).slice(0, 8000),
        error: null,
      });
      repo.bookings.create({
        account_id: recurring.account_id, recurring_id: recurring.id,
        court: result.courtId, date,
        start_time: slotToTime(from), end_time: slotToTime(to),
        status: 'confirmed', external_id: externalId, raw_json: result.body,
      });
      repo.recurring.setLastResult(recurring.id, { status: 'booked', msg: `booked court ${result.courtId} on ${date}`, category: null });
      state.transition(recurring.account_id, state.STATES.BOOKED, `booked court ${result.courtId} on ${date}`);
      booked = { category: cat, externalId, attempt, courtId: result.courtId };
      break;
    }
    // Record the failed attempt
    repo.fireEvents.create({
      recurring_id: recurring.id, account_id: recurring.account_id,
      scheduled_at: firedAt, fired_at: firedAt, status: cat.code, attempt,
      court_attempted: result.courtId,
      date, time: slotToTime(from),
      latency_ms: result.latency_ms, response_status: result.status,
      response_body: JSON.stringify(ac(result.body)).slice(0, 8000),
      error: cat.detail || cat.reason,
    });
    if (cat.reason === 'auth_required') {
      state.transition(recurring.account_id, state.STATES.SESSION_EXPIRED, cat.detail || 'auth required');
      break;
    }
    if (attempt < 3) {
      if (onProgress) onProgress({ attempt, phase: 'sleeping' });
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
  if (!booked) {
    const lastCat = attempts[attempts.length - 1]?.category;
    const category = lastCat?.code === 'no_time_available' ? 'no_time_available' : 'technical_error';
    const msg = '3 bookings failed to succeed';
    repo.recurring.setLastResult(recurring.id, { status: 'failed', msg, category });
    state.transition(recurring.account_id, state.STATES.FAILED, msg);
  }
  return { booked, attempts };
}

module.exports = { fireScheduled, fireImmediate, categorize, recordAndPersistScheduledFire, postCreate, fireCourts, API_PATH, dispatcher };
