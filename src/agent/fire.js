'use strict';

const endpoints = require('../kooroo/endpoints.json');
const repo = require('../db/repo');
const state = require('./state');
const log = require('../logger');
const { findBookingFor } = require('../kooroo/booking');
const { slotToTime, timeToSlot } = require('../kooroo/client');
const { waitUntilExact } = require('./time');
const recurring = require('./recurring');

const FIRE_CONTEXT_TTL_MS = 6 * 60_000;
const CREATE_BOOKING_BODY_TIMEOUT_MS = 10_000;
const CREATE_BOOKING_HEADERS_TIMEOUT_MS = 2_000;

const fireContexts = new Map();

function stashFireContext(recurringId, ctx) {
  fireContexts.set(recurringId, { ...ctx, stashedAt: Date.now() });
}

function popFireContext(recurringId) {
  const ctx = fireContexts.get(recurringId);
  if (!ctx) return null;
  fireContexts.delete(recurringId);
  if (Date.now() - ctx.stashedAt > FIRE_CONTEXT_TTL_MS) return null;
  return ctx;
}

function peekFireContext(recurringId) {
  const ctx = fireContexts.get(recurringId);
  if (!ctx) return null;
  if (Date.now() - ctx.stashedAt > FIRE_CONTEXT_TTL_MS) return null;
  return ctx;
}

function dropFireContext(recurringId) {
  fireContexts.delete(recurringId);
}

function toApiCourts(rec) {
  const userCourts = Array.isArray(rec.courts) ? rec.courts : [];
  const api = userCourts
    .map(c => recurring.COURT_TO_API[String(c)] || String(c))
    .filter(Boolean);
  const prefApi = recurring.COURT_TO_API[String(rec.court_pref)] || String(rec.court_pref);
  const seen = new Set();
  const out = [];
  for (const c of [prefApi, ...api]) {
    if (!c) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

function categorize({ status, body, error }) {
  if (error) return { code: 'technical_error', reason: 'network', detail: error };
  if (status === 401 || status === 403) return { code: 'technical_error', reason: 'auth_required' };
  if (status >= 500) return { code: 'technical_error', reason: 'http_5xx', detail: body?.message };
  if (body?.message && /booking has been made/i.test(body.message)) return { code: 'booked' };
  if (body?.message) {
    const m = body.message;
    if (/already booked by a member/i.test(m))
      return { code: 'no_time_available', reason: 'already_booked' };
    // v3.6: user-side quota — the member has already booked the maximum
    // number of hours they're allowed today (e.g. they booked other
    // slots directly on the Koorora site). This is NOT a "slot taken
    // by someone else" — retrying won't help until the user frees up
    // their quota. We tag it distinctly so the dashboard / SQL can
    // tell it apart from real "slot taken" cases.
    if (/over the maximum number of hours|push you over|max.*hours.*day|quota|hour limit/i.test(m))
      return { code: 'no_time_available', reason: 'user_quota_exceeded', detail: m };
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

function ac(body) {
  return body && typeof body === 'object' ? body : {};
}

async function tryCreateBooking(client, { date, from, to, courtId }) {
  const t0 = Date.now();
  let result;
  try {
    result = await client.createBooking(
      { date, from, to, court_id: String(courtId) },
      { bodyTimeout: CREATE_BOOKING_BODY_TIMEOUT_MS, headersTimeout: CREATE_BOOKING_HEADERS_TIMEOUT_MS }
    );
  } catch (e) {
    return { status: 0, body: null, raw: null, latency_ms: Date.now() - t0, error: e.message };
  }
  return {
    status: result.status,
    body: result.body,
    raw: result.raw,
    latency_ms: Date.now() - t0,
    error: null,
  };
}

async function fireCourts(client, { date, from, to, courts, onAttempt }) {
  let lastCat = null;
  for (let i = 0; i < courts.length; i++) {
    const courtId = String(courts[i]);
    if (onAttempt) onAttempt({ courtId, idx: i });
    const r = await tryCreateBooking(client, { date, from, to, courtId });
    const cat = categorize(r);
    if (cat.code === 'booked') {
      return { ...r, courtId, category: cat, courtIdx: i };
    }
    lastCat = cat;
    if (cat.reason === 'auth_required') {
      return { ...r, courtId, category: cat, courtIdx: i, stopChain: true };
    }
  }
  return {
    status: lastCat?.code === 'no_time_available' ? 200 : 0,
    body: null,
    raw: null,
    latency_ms: 0,
    courtId: null,
    category: lastCat,
    courtIdx: -1,
    stopChain: lastCat?.reason === 'auth_required',
  };
}

async function fireScheduledFromContext({ ctx, onAttempt }) {
  const { client, recurring: rec, slot, apiCourts } = ctx;
  state.transition(rec.account_id, state.STATES.ATTEMPTING, `book at ${new Date(ctx.targetMs).toISOString()}`);
  const result = await fireCourts(client, {
    date: slot.date,
    from: slot.from,
    to: slot.to,
    courts: apiCourts,
    onAttempt,
  });
  return { ...result, firedAt: new Date().toISOString(), ctx };
}

async function recordAndPersistScheduledFire({ ctx, result, onAttempt }) {
  const { recurring: rec, slot, apiCourts } = ctx;
  const cat = result.category;
  let externalId = null;
  if (cat.code === 'booked') {
    const bookedApiCourt = result.courtId;
    const found = await findBookingFor(ctx.client, {
      date: slot.date, from: slot.from, to: slot.to, court_id: bookedApiCourt,
    });
    externalId = found?.id || null;
  }
  const responseBody = result.raw != null ? String(result.raw).slice(0, 8000)
    : (result.body ? JSON.stringify(ac(result.body)).slice(0, 8000) : null);

  repo.fireEvents.create({
    recurring_id: rec.id,
    account_id: rec.account_id,
    scheduled_at: new Date(ctx.targetMs).toISOString(),
    fired_at: result.firedAt,
    status: cat.code,
    attempt: 1,
    court_attempted: result.courtId,
    court_booked: cat.code === 'booked' ? apiCourts[result.courtIdx] || null : null,
    date: slot.date,
    time: slotToTime(slot.from),
    latency_ms: result.latency_ms,
    response_status: result.status,
    response_body: responseBody,
    error: cat.detail || cat.reason,
  });

  let booking = null;
  if (cat.code === 'booked') {
    const bookedOnPrimary = result.courtIdx === 0;
    const bookedCourtApi = apiCourts[result.courtIdx] || null;
    const status = externalId ? 'confirmed' : 'booked_unverified';
    booking = repo.bookings.create({
      account_id: rec.account_id,
      recurring_id: rec.id,
      court: bookedCourtApi,
      date: slot.date,
      start_time: slotToTime(slot.from),
      end_time: slotToTime(slot.to),
      status,
      external_id: externalId,
      raw_json: result.body,
    });
    if (!bookedOnPrimary) {
      log.warn('fire.booked_on_fallback_court', {
        recurring: rec.id,
        account: rec.account_id,
        preferred_api_court: apiCourts[0],
        booked_api_court: bookedCourtApi,
        date: slot.date,
        time: slotToTime(slot.from),
        message: 'booking succeeded on a fallback court — the preferred court was unavailable',
      });
    }
    state.transition(rec.account_id, state.STATES.BOOKED, `booked court ${bookedCourtApi} on ${slot.date}`);
  } else if (cat.reason === 'auth_required') {
    state.transition(rec.account_id, state.STATES.SESSION_EXPIRED, cat.detail || 'auth required');
  } else {
    state.transition(rec.account_id, state.STATES.FAILED, cat.detail || cat.reason);
  }
  repo.recurring.setLastResult(rec.id, {
    status: cat.code,
    msg: cat.detail || cat.reason,
    // v3.6: prefer the specific reason (e.g. 'user_quota_exceeded',
    // 'already_booked') over the coarse code. Only fall back to the
    // code-derived category for 'booked' (null) and unrecognized cases.
    category: cat.code === 'booked' ? null : (cat.reason || (cat.code === 'no_time_available' ? 'no_time_available' : 'technical_error')),
  });
  return { category: cat, externalId, result, booking };
}

async function fireImmediate({ recurring: rec, client, primed, onProgress }) {
  const slot = { date: primed.date, from: primed.from, to: primed.to };
  const apiCourts = toApiCourts(rec);
  const attempts = [];
  let booked = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    state.transition(rec.account_id, state.STATES.ATTEMPTING, `immediate attempt ${attempt}/3`);
    if (onProgress) onProgress({ attempt, phase: 'attempting' });
    const result = await fireCourts(client, {
      date: slot.date, from: slot.from, to: slot.to, courts: apiCourts,
      onAttempt: ({ courtId }) => {
        repo.fireEvents.create({
          recurring_id: rec.id, account_id: rec.account_id,
          scheduled_at: new Date().toISOString(),
          status: 'attempting', attempt, court_attempted: courtId,
          date: slot.date, time: slotToTime(slot.from),
        });
      },
    });
    const firedAt = new Date().toISOString();
    const cat = result.category;
    attempts.push({ attempt, category: cat, courtId: result.courtId, latency_ms: result.latency_ms });
    if (cat.code === 'booked') {
      const bookedCourtApi = result.courtId;
      const found = await findBookingFor(client, { date: slot.date, from: slot.from, to: slot.to, court_id: bookedCourtApi });
      const externalId = found?.id || null;
      repo.fireEvents.create({
        recurring_id: rec.id, account_id: rec.account_id,
        scheduled_at: firedAt, fired_at: firedAt, status: 'booked', attempt,
        court_attempted: result.courtId, court_booked: bookedCourtApi,
        date: slot.date, time: slotToTime(slot.from),
        latency_ms: result.latency_ms, response_status: result.status,
        response_body: result.raw != null ? String(result.raw).slice(0, 8000) : JSON.stringify(ac(result.body)).slice(0, 8000),
        error: null,
      });
      const status = externalId ? 'confirmed' : 'booked_unverified';
      repo.bookings.create({
        account_id: rec.account_id, recurring_id: rec.id,
        court: bookedCourtApi, date: slot.date,
        start_time: slotToTime(slot.from), end_time: slotToTime(slot.to),
        status, external_id: externalId, raw_json: result.body,
      });
      repo.recurring.setLastResult(rec.id, { status: 'booked', msg: `booked court ${bookedCourtApi} on ${slot.date}`, category: null });
      state.transition(rec.account_id, state.STATES.BOOKED, `booked court ${bookedCourtApi} on ${slot.date}`);
      booked = { category: cat, externalId, attempt, courtId: bookedCourtApi };
      break;
    }
    repo.fireEvents.create({
      recurring_id: rec.id, account_id: rec.account_id,
      scheduled_at: firedAt, fired_at: firedAt, status: cat.code, attempt,
      court_attempted: result.courtId,
      date: slot.date, time: slotToTime(slot.from),
      latency_ms: result.latency_ms, response_status: result.status,
      response_body: result.raw != null ? String(result.raw).slice(0, 8000) : JSON.stringify(ac(result.body)).slice(0, 8000),
      error: cat.detail || cat.reason,
    });
    if (cat.reason === 'auth_required') {
      state.transition(rec.account_id, state.STATES.SESSION_EXPIRED, cat.detail || 'auth required');
      break;
    }
    if (attempt < 3) {
      if (onProgress) onProgress({ attempt, phase: 'sleeping' });
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
  if (!booked) {
    const lastCat = attempts[attempts.length - 1]?.category;
    // v3.6: prefer the specific reason over the coarse code (so
    // 'user_quota_exceeded' shows up as its own category, not as
    // a generic 'no_time_available').
    const category = lastCat?.code === 'booked' ? null
      : lastCat?.reason || (lastCat?.code === 'no_time_available' ? 'no_time_available' : 'technical_error');
    const msg = '3 bookings failed to succeed';
    repo.recurring.setLastResult(rec.id, { status: 'failed', msg, category });
    state.transition(rec.account_id, state.STATES.FAILED, msg);
  }
  return { booked, attempts };
}

module.exports = {
  categorize,
  fireCourts,
  fireScheduledFromContext,
  recordAndPersistScheduledFire,
  fireImmediate,
  tryCreateBooking,
  stashFireContext,
  popFireContext,
  peekFireContext,
  dropFireContext,
  toApiCourts,
  FIRE_CONTEXT_TTL_MS,
  CREATE_BOOKING_BODY_TIMEOUT_MS,
};
