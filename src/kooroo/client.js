'use strict';

const endpoints = require('./endpoints.json');
const repo = require('../db/repo');
const log = require('../logger');
const config = require('../config');
const { fetch: undiciFetch, Agent } = require('undici');
const { CookieJar, Cookie } = require('tough-cookie');

const API = endpoints.api.endpoint;
const PROBE_PATH = endpoints.auth.sessionProbe.path;
const PROBE_EXPECTED = endpoints.auth.sessionProbe.expectedStatus;

const dispatcher = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });

function slotToTime(slot) {
  const slotN = parseInt(slot, 10);
  if (Number.isNaN(slotN)) return null;
  // Slot 1 == 00:30 (verified: slot 13 == 06:30, slot 17 == 08:30 → 8:30am match)
  const totalMin = slotN * endpoints.schedule.slotMinutes;
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToSlot(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;
  // Inverse of slotToTime: round to nearest 30-min slot, but slot 1 = 00:30
  // (so a 00:00 request should still map to slot 1, not slot 0).
  const totalMin = hours * 60 + mins;
  let slot = Math.round(totalMin / endpoints.schedule.slotMinutes);
  if (slot < 1) slot = 1;
  return slot;
}

class KoorooClient {
  constructor(account) {
    this.account = account;
    this.jar = new CookieJar();
    this.userId = null;
    this.contactId = null;
    this.maxHoursPerBooking = parseFloat(endpoints.schedule.maxHoursPerBooking);
  }

  async hydrateFromSession() {
    const session = repo.sessions.getByAccount(this.account.id);
    if (!session) return false;
    const cookies = JSON.parse(session.cookies_json || '[]');
    const targetHost = endpoints.baseUrl.replace(/^https?:\/\//, '');
    for (const c of cookies) {
      let name, value, domain, path, expires, secure, httpOnly, sameSite;
      if (typeof c === 'string') {
        const ck = Cookie.parse(c);
        if (!ck) continue;
        name = ck.key; value = ck.value; domain = ck.domain; path = ck.path || '/';
        expires = ck.expires && ck.expires !== 'Infinity' ? ck.expires : null;
        secure = !!ck.secure; httpOnly = !!ck.httpOnly;
        sameSite = ck.sameSite;
      } else {
        name = c.name; value = c.value; domain = c.domain; path = c.path || '/';
        expires = c.expires && c.expires > 0 ? new Date(c.expires * 1000) : null;
        secure = !!c.secure; httpOnly = !!c.httpOnly; sameSite = c.sameSite;
      }
      const d = domain && domain.startsWith('.') ? domain.slice(1) : domain;
      if (d !== targetHost) continue;
      let setCookieStr = `${name}=${value}; Domain=${domain}; Path=${path}`;
      if (expires) setCookieStr += `; Expires=${expires.toUTCString()}`;
      if (secure) setCookieStr += `; Secure`;
      if (httpOnly) setCookieStr += `; HttpOnly`;
      if (sameSite) setCookieStr += `; SameSite=${sameSite}`;
      try {
        await this.jar.setCookie(setCookieStr, endpoints.baseUrl);
      } catch (e) {
        this._manualCookies = this._manualCookies || new Map();
        this._manualCookies.set(name, `${name}=${value}`);
      }
    }
    if (session.user_json) {
      try {
        const u = JSON.parse(session.user_json);
        this.userId = u.user_id || u.id || null;
        this.contactId = u.contact_id || null;
        this.maxHoursPerBooking = parseFloat(u.max_hours_per_booking || endpoints.schedule.maxHoursPerBooking);
      } catch {}
    }
    return true;
  }

  persistSession() {
    const cookiesSync = this.jar.getCookiesSync(endpoints.baseUrl).map((c) => c.toString());
    repo.sessions.upsert({
      accountId: this.account.id,
      cookiesJson: cookiesSync,
      userJson: { user_id: this.userId, contact_id: this.contactId, max_hours_per_booking: this.maxHoursPerBooking },
      expiresAt: null,
    });
  }

  cookieHeader() {
    const fromJar = this.jar.getCookiesSync(endpoints.baseUrl).map((c) => `${c.key}=${c.value}`);
    const fromManual = this._manualCookies ? [...this._manualCookies.values()] : [];
    return [...fromJar, ...fromManual].join('; ');
  }

  async request({ method = 'POST', path, body, headers = {}, bodyTimeout, headersTimeout }) {
    const url = path.startsWith('http') ? path : `${endpoints.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const h = {
      'user-agent': 'kooroo-booking-agent/0.1 (+local)',
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      ...headers,
    };
    const ck = this.cookieHeader();
    if (ck) h.cookie = ck;
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
      h['content-type'] = h['content-type'] || 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(body).toString();
    }
    const fetchOpts = { method, headers: h, body, dispatcher, redirect: 'manual' };
    if (bodyTimeout != null) fetchOpts.bodyTimeout = bodyTimeout;
    if (headersTimeout != null) fetchOpts.headersTimeout = headersTimeout;
    const t0 = Date.now();
    let res, text, err = null;
    try {
      res = await undiciFetch(url, fetchOpts);
      text = await res.text();
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const ck = Cookie.parse(sc);
        if (ck) await this.jar.setCookie(ck, endpoints.baseUrl);
      }
    } catch (e) {
      err = e.message;
      repo.audit.add({ account_id: this.account.id, direction: 'out', method, url, error: err });
      throw e;
    }
    const latency = Date.now() - t0;
    const reqPreview = config.audit.fullBodies && body ? String(body).slice(0, 200_000) : null;
    const resPreview = config.audit.fullBodies && text ? text.slice(0, 200_000) : null;
    repo.audit.add({ account_id: this.account.id, direction: 'out', method, url, status: res.status, latency_ms: latency, request_body: reqPreview, response_body: resPreview });
    return { res, text, status: res.status, headers: res.headers };
  }

  async bootstrapParams() {
    const { status, text } = await this.request({ method: 'GET', path: PROBE_PATH });
    if (status !== PROBE_EXPECTED) {
      return { ok: false, status, reason: `expected ${PROBE_EXPECTED}, got ${status}` };
    }
    const m = /tpcb_court_params\s*=\s*(\{[\s\S]*?\});/m.exec(text);
    if (!m) return { ok: false, status, reason: 'tpcb_court_params not found in page' };
    let params;
    try { params = JSON.parse(m[1]); } catch (e) { return { ok: false, status, reason: 'tpcb_court_params not valid JSON: ' + e.message }; }
    this.userId = params.user_id || this.userId;
    this.contactId = params.contact_id || this.contactId;
    this.maxHoursPerBooking = parseFloat(params.max_hours_per_booking || this.maxHoursPerBooking);
    this.persistSession();
    return { ok: true, params };
  }

  async ensureReady() {
    await this.hydrateFromSession();
    const probe = await this.probe();
    if (probe.ok && this.userId) return probe;
    const boot = await this.bootstrapParams();
    if (!boot.ok) return { ok: false, reason: 'bootstrap failed: ' + boot.reason };
    return { ok: true, user_id: this.userId };
  }

  async probe() {
    try {
      const { status, text } = await this.request({ method: 'GET', path: PROBE_PATH });
      return { ok: status === PROBE_EXPECTED, status, hasParams: /tpcb_court_params/.test(text) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async ajaxAction(action, fields = {}, opts = {}) {
    const body = { action, ...fields };
    const { status, text } = await this.request({ method: 'POST', path: API.replace(endpoints.baseUrl, ''), body, ...opts });
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status, body: parsed, raw: text };
  }

  async getDaySchedule(date) {
    return this.ajaxAction(endpoints.api.actions.getDaySchedule.name, { date });
  }

  async createBooking({ date, from, to, court_id, first_day_of_week = null, last_day_of_week = null }, opts = {}) {
    return this.ajaxAction(endpoints.api.actions.createBooking.name, {
      date,
      from: String(from),
      to: String(to),
      court_id: String(court_id),
      user_id: String(this.userId),
      first_day_of_week: first_day_of_week || '',
      last_day_of_week: last_day_of_week || '',
    }, opts);
  }

  async updateBooking({ id, from, to, date, first_day_of_week = null, last_day_of_week = null }) {
    return this.ajaxAction(endpoints.api.actions.updateBooking.name, {
      id: String(id),
      from: String(from),
      to: String(to),
      date,
      first_day_of_week: first_day_of_week || '',
      last_day_of_week: last_day_of_week || '',
    });
  }

  async deleteBooking(id) {
    return this.ajaxAction(endpoints.api.actions.deleteBooking.name, { id: String(id) });
  }
}

module.exports = { KoorooClient, slotToTime, timeToSlot };
