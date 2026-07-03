'use strict';

// Formatting helpers shared by views and tests.

const SYDNEY = 'Australia/Sydney';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function partsInSydney(d) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SYDNEY,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour, minute: +out.minute,
  };
}

function sydneyTzAbbrev(d) {
  // Detect DST by checking Sydney's UTC offset on the target date.
  // AEST = UTC+10 (no DST), AEDT = UTC+11 (DST in effect).
  // We compute the offset by formatting the same instant as UTC and Sydney
  // and comparing. Avoids depending on the system's ICU tz data.
  const utcMs = d.getTime();
  const utc = new Date(utcMs);
  const sydney = new Date(utcMs);
  // Shift by an offset derived from formatted parts
  const fmtUtc = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtSy = new Intl.DateTimeFormat('en-GB', { timeZone: SYDNEY, hour: '2-digit', minute: '2-digit', hour12: false });
  const u = fmtUtc.format(utc).split(':');
  const s = fmtSy.format(sydney).split(':');
  const uMin = parseInt(u[0], 10) * 60 + parseInt(u[1], 10);
  const sMin = parseInt(s[0], 10) * 60 + parseInt(s[1], 10);
  // diff is the Sydney offset in minutes (typically 600 or 660)
  let diff = sMin - uMin;
  if (diff < 0) diff += 24 * 60;
  return diff >= 11 * 60 ? 'AEDT' : 'AEST';
}

function formatSydneyDateTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const p = partsInSydney(d);
  const hour12 = ((p.hour + 11) % 12) + 1;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  const mon = MONTH_NAMES[p.month - 1] || '';
  return `${p.day} ${mon} ${hour12}:${String(p.minute).padStart(2, '0')} ${ampm} ${sydneyTzAbbrev(d)}`;
}

function formatSydneyDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const p = partsInSydney(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Truncate a string to at most `n` characters and trim trailing whitespace.
function truncate(str, n) {
  if (str == null) return '';
  const s = String(str);
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd();
}

// Convert HH:MM (24h) to a short 12h form like "7pm", "7:30am", "12pm", "12am".
function formatTime12h(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return String(hhmm || '');
  const h = parseInt(m[1], 10);
  const mins = m[2];
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  if (mins === '00') return `${h12}${ampm}`;
  return `${h12}:${mins}${ampm}`;
}

// Day index (0-6) → 3-letter code, e.g. "Wed".
function dayCode(dow) {
  return DAY_NAMES[((dow % 7) + 7) % 7] || '';
}

// Build a label like "Wed 7pm Crt 4" from the recurring fields.
function buildRecurringLabel({ day_of_week, time, court_pref }) {
  return `${dayCode(day_of_week)} ${formatTime12h(time)} Crt ${court_pref}`;
}

// Build the fallback court order given a preferred court and a toggle.
// Order: preferred first, then the rest in ascending 4 → 5 → 6 order.
function computeFallbackOrder(courtPref, enabled) {
  if (!enabled) return [String(courtPref)];
  const all = ['4', '5', '6'];
  const pref = String(courtPref);
  const rest = all.filter(c => c !== pref);
  return [pref, ...rest];
}

module.exports = {
  SYDNEY,
  formatSydneyDateTime,
  formatSydneyDate,
  truncate,
  formatTime12h,
  dayCode,
  buildRecurringLabel,
  computeFallbackOrder,
  partsInSydney,
  sydneyTzAbbrev,
  DAY_NAMES,
  MONTH_NAMES,
};
