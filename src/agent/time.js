'use strict';

// Time helpers. Uses native Intl.DateTimeFormat — no external tz library.
// All "Sydney" times are Australia/Sydney (handles AEDT/AEST automatically).

const SYDNEY = 'Australia/Sydney';

const dow = (d) => new Date(d).getUTCDay();

function partsInTz(date, tz = SYDNEY) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  // "24" hour fix: en-US sometimes returns hour="24" for midnight
  if (o.hour === '24') o.hour = '00';
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +o.hour, minute: +o.minute, second: +o.second,
    weekday: o.weekday,
  };
}

const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function sydneyNow() { return partsInTz(Date.now(), SYDNEY); }

// Compute the next UTC ms timestamp where Sydney is at the given day-of-week
// and time. If the computed time is in the past or too close, advance one week.
function nextWeekdayAt(dayOfWeek, hhmm, { tz = SYDNEY, after = Date.now() } = {}) {
  const [hh, mm] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) throw new Error(`bad time: ${hhmm}`);
  const now = new Date(after);
  const cur = partsInTz(now.getTime(), tz);
  const curDow = DOW_MAP[cur.weekday];
  let diff = (dayOfWeek - curDow + 7) % 7;
  if (diff === 0) {
    const curMins = cur.hour * 60 + cur.minute;
    const targetMins = hh * 60 + mm;
    if (curMins >= targetMins) diff = 7;
  }
  // Construct a Sydney-local date string for (today + diff days) at hh:mm,
  // then convert to UTC. If that UTC is <= after, advance by 7 days and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = new Date(now.getTime() + diff * 86_400_000);
    const bp = partsInTz(base.getTime(), tz);
    const dateStr = `${bp.year}-${String(bp.month).padStart(2, '0')}-${String(bp.day).padStart(2, '0')}`;
    const utcMs = sydneyWallToUtc(dateStr, hhmm);
    if (utcMs > after) return utcMs;
    diff += 7;
  }
  throw new Error('could not resolve nextWeekdayAt');
}

// Sydney "wall clock" → UTC ms. The wall clock string is interpreted as
// Australia/Sydney. Useful for one-off bookings (e.g. "2026-07-08 19:00").
function sydneyWallToUtc(dateStr, hhmm) {
  // dateStr is YYYY-MM-DD; hhmm is HH:MM
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  // Approximate by guessing UTC, then adjust based on tz offset at that time.
  let guess = Date.UTC(Y, M - 1, D, h, m, 0);
  for (let i = 0; i < 4; i++) {
    const p = partsInTz(guess, SYDNEY);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const diff = Date.UTC(Y, M - 1, D, h, m, 0) - got;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

// Return a date string (YYYY-MM-DD) in Sydney tz for a given UTC ms.
function sydneyDateString(utcMs) {
  const p = partsInTz(utcMs, SYDNEY);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}

// "HH:MM" in Sydney tz for a given UTC ms.
function sydneyTimeString(utcMs) {
  const p = partsInTz(utcMs, SYDNEY);
  return `${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`;
}

// Sleep until the wall clock reaches `targetMs`. Uses setTimeout for the bulk,
// then a short busy-wait for sub-ms precision.
function waitUntilExact(targetMs) {
  return new Promise((resolve) => {
    const tick = () => {
      const now = Date.now();
      const remaining = targetMs - now;
      if (remaining <= 0) return resolve(Date.now());
      if (remaining > 50) return setTimeout(tick, remaining - 25);
      if (remaining > 5) return setTimeout(tick, remaining - 1);
      // busy-wait the last 5 ms
      const end = process.hrtime.bigint() + BigInt(remaining) * 1_000_000n;
      const spin = () => {
        if (process.hrtime.bigint() >= end) return resolve(Date.now());
        setImmediate(spin);
      };
      spin();
    };
    tick();
  });
}

module.exports = {
  SYDNEY,
  nextWeekdayAt,
  sydneyWallToUtc,
  sydneyDateString,
  sydneyTimeString,
  sydneyNow,
  waitUntilExact,
  partsInTz,
  DOW_MAP,
};
