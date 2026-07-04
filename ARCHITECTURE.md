# Architecture — Kooroora Booking Agent

> **Version:** 3.5 · **Last updated:** 2026-07-04
> **Stack:** Node.js 20, Express, better-sqlite3 (WAL), undici, Playwright, node-cron, EJS, Caddy 2 + caddy-dns/cloudflare, Docker
> **Live deployment:** https://bookings.boomercheugys.com

This document describes how the system is wired together so a future session (or another engineer) can pick it up. It complements the user-facing `README.md` (how to use the dashboard), the operator-facing `DEPLOY.md` (how to run the server), and the dedicated design doc for the time-based booking logic at [`docs/recurring-bookings.md`](docs/recurring-bookings.md). The goal here is to explain **how it works under the hood** and **why each piece is the way it is**.

## v3 → v3.5 changelog (the big picture)

- **v3.1 — Court auto-allocation**: when the user picks "any court" the system picks the first non-conflicting court automatically. See `src/agent/courtAllocator.js`.
- **v3.2 — Unified Make Booking form**: removed Strategy, Lead days, Time end fields. Added AM/PM widget, single date picker, auto-generated label. Tooltips + field validation.
- **v3.2 — Account form spinner**: the Add & test login form shows a CSS spinner and status text while Playwright runs (15-30s). Friendly error explanations.
- **v3.3 — Auto-attempt for one-off bookings**: `POST /api/watches` now attempts the booking immediately if the date is within 7 days. Returns `{ watch, attempt }` so the form can show what happened.
- **v3.4 — Every booking is a weekly schedule**: removed the "recurring" toggle. The picked date is the schedule anchor. First fire is at the opening (T-7d). Fixed the chain (was using `slotUtc + 7d` which fired at the closing moment of the next slot). Fixed `slotForFire` to honour `first_slot_date` for the first fire and `fireMs + 7d` for subsequent. New `recurring_bookings.first_slot_date` column.
- **v3.4 — Self-healing Docker**: `tools/deploy.sh` chowns the host data dir if the container's uid doesn't match; `docker-entrypoint.sh` chowns on every container start.
- **v3.5 — Booking target on /recurring/:id**: shows what slot the next fire will book, not just when it'll fire.
- **v3.5 — Restored non-recurring bookings**: re-added the "Make this a recurring weekly booking" toggle. When OFF, the form posts to `/api/watches` (one-shot); when ON, it posts to `/api/recurring` (weekly). New `watches.fired_at` column + `fire-due-watches` cron (every 1 min) for one-shot watches > 7 days out.

---

## 1. High-level

```
                       ┌────────────────────────────────────────────┐
                       │                  Caddy                     │
                       │  (TLS via Cloudflare DNS-01, reverse proxy)│
                       └────────────────┬───────────────────────────┘
                                        │ :443
                       ┌────────────────▼───────────────────────────┐
                       │               Node.js app                 │
                       │  (Express + EJS + in-process scheduler)   │
                       └────┬──────────────────┬──────────────┬──────┘
                            │                  │              │
                ┌───────────▼──┐    ┌───────────▼─┐   ┌────────▼────────┐
                │  SQLite DB   │    │  Playwright  │   │  kooroora.asn  │
                │  data/*.sq*  │    │  (re-login)  │   │      .au       │
                └──────────────┘    └─────────────┘   └─────────────────┘
```

The app is a single Node.js process. It serves the dashboard (HTML + JSON API) and runs the booking scheduler in-process. The only outbound side effect is HTTPS calls to `kooroora.asn.au` (the WordPress + Tennis Plus Court Booking site). The only inbound dependencies are admin logins and Caddy proxying.

---

## 2. Module map

```
src/
  server.js                 Express entry, mounts routes, starts jobs
  config.js                 Typed env-var wrapper
  logger.js                 JSON-line logger
  db/
    index.js                better-sqlite3 singleton, idempotent migrate()
    schema.sql              CREATE TABLE statements
    repo.js                 Thin data-access functions
  kooroo/
    client.js               undici + tough-cookie, KoorooClient class
    auth.js                 login / probe / relogin (Playwright)
    availability.js         getDaySchedule parser
    booking.js              create / cancel
    endpoints.json          Discovered API contract (frozen)
  agent/
    pool.js                 Per-account client pool
    state.js                Account state machine
    time.js                 Sydney-time helpers (DST-aware)
    warmup.js               Token pre-warm + prebuilt request body
    fire.js                 fireOne / fireImmediate / fireCourts / categorize
    monitor.js              One-shot watches: runWatch, fireDueWatches, isWithinBookingWindow
    booker.js               Manual book / cancel
    recurring.js            v2/v3 — CRUD + chain + first-immediate + auto-label + first_slot_date
    scheduler.js            Per-recurring timer arm, prime, missed-fire recovery, slotForFire, nextBookingTarget
    jobs.js                 Crons: fire-due-watches (every 1 min), audit.prune (daily), backup.marker (daily)
    courtAllocator.js       v3.1 — auto-allocate "any" court to first non-conflicting slot
  routes/
    auth.js                 /login, /logout
    dashboard.js            /, /accounts, /watches, /bookings, /recurring, /booking-log, /fire-events, /audit, /settings
    api.js                  /api/recurring, /api/accounts, /api/watches, /api/monitor, /api/booking-log, /api/fire-events, /api/errors/active
    _mw.js                  requireAdmin() middleware (admin session only)
  views/
    overview.ejs, recurring.ejs, recurring_detail.ejs, accounts.ejs, watches.ejs, bookings.ejs, booking_log.ejs, fire_events.ejs, audit.ejs, settings.ejs, login.ejs, error.ejs
    partials/header.ejs      Top banner, nav, error banner
    partials/footer.ejs      JSON helper, countdowns, flash auto-dismiss
  lib/
    format.js               v3 — Sydney date/time, truncate, buildRecurringLabel, computeFallbackOrder
tools/
  spike-login.js            Playwright login + HAR + cookies capture
  extract-endpoints.js      HAR -> endpoints.json
  import-session.js         spike cookies -> DB
  probe-api.js              Live book/cancel smoke test
  cancel-my-bookings.js     Bulk-cancel your bookings on a date
  probe-error-responses.js  Probe server's error message vocabulary
  backup.sh                 v3 — hot SQLite backup + SHA256 + counts + prune
  restore.sh                v3 — SHA256-verify + restore from a backup
  deploy.sh                 v3 — snapshot -> build -> restart with health wait
  db-stats.sh               v3 — row counts + DB size + last backup age
test/
  smoke.test.js             Unit + (optionally) live API tests
```

---

## 3. Data model

SQLite (WAL mode) in `data/bookingagent.sqlite`. Six tables. See `src/db/schema.sql` for the canonical DDL. Migrations are idempotent in `src/db/index.js` (additive `ALTER TABLE` wrapped in try/catch so re-runs are safe).

```
accounts(id, label, username, password, enabled, last_login_at, last_check_at,
         last_login_ok, last_login_msg,
         state, state_msg, state_updated_at, session_expires_at,
         created_at, updated_at)

sessions(id, account_id UNIQUE, cookies_json, bearer_token, csrf_token,
         user_json, expires_at, created_at, updated_at)
  -- cookies_json is a JSON array of full cookie objects (domain, path, expires, secure, httpOnly)
  -- user_json is { user_id, contact_id, max_hours_per_booking }

watches(id, account_id, label, court, date_from, date_to, time_start, time_end,
        duration_mins, strategy, lead_days, enabled,
        fired_at,  -- v3.5: set after the first fire (success OR fail) so the
                   -- fire-due-watches cron doesn't re-attempt it. NULL = not yet
                   -- fired. A non-recurring booking is one-shot.
        last_run_at, last_status, last_msg,
        created_at, updated_at)
  -- one-shot watches: the Make Booking form's "non-recurring" path posts here
  -- when the recurring toggle is off. The API auto-attempts if the date is
  -- within 7 days; otherwise it sits in the DB until the fire-due-watches cron
  -- picks it up.

bookings(id, account_id, watch_id NULL, recurring_id NULL, court, date, start_time,
          end_time, status, external_id, raw_json, created_at)
  -- status: confirmed | cancelled | failed
  -- external_id: the booking ID returned by kooroora.asn.au (matched later for cancel)

recurring_bookings(id, account_id, label, court_pref, courts, day_of_week, time,
                    duration_mins, lead_minutes, enabled,
                    next_fire_at, last_fire_at, last_status, last_msg,
                    last_error_category, error_dismissed_at, first_occurrence_action,
                    first_slot_date,  -- v3.4: the date the user picked — the
                                       -- schedule anchor. First fire = this - 7d.
                                       -- Chain = previous slot's time.
                    created_at, updated_at)
  -- courts: JSON array, always starts with court_pref
  -- first_occurrence_action: book_now | schedule | resolved
  -- last_error_category: no_time_available | technical_error | auth_required | no_courts_available

fire_events(id, recurring_id NULL, account_id NULL,
            scheduled_at, fired_at NULL,
            status, attempt, court_attempted, court_booked,
            date, time, latency_ms, response_status, response_body, error,
            created_at)
  -- status: booked | no_time_available | technical_error | attempting | skipped
  -- records every attempt, success or failure

audit_log(id, ts, account_id, direction, method, url, status, latency_ms,
          request_body, response_body, error)
  -- one row per outbound HTTP call (kooroora + login probes)
  -- body capture controlled by AUDIT_FULL_BODIES
```

### Cascade-delete chains
- `accounts` → `sessions`, `watches`, `bookings`, `recurring_bookings`, `fire_events`, `audit_log`
- `recurring_bookings` → `fire_events`, `bookings` (sets the FK to NULL, doesn't delete)

### Why SQLite, not Postgres
- Single user, single writer, no concurrent reads that need MVCC
- The whole DB is a single file — easy to back up, easy to inspect, easy to ship
- WAL mode gives us safe concurrent reads + a single writer, which is exactly what we need
- better-sqlite3 is sync, which fits the scheduler model: `await db.backup(path)` is the only async we use, and it's just for snapshots
- A named Docker volume (`bookingagent_backups`) for daily snapshots + the bind mount (`./data:/app/data`) for the live DB means the data tier is simple and inspectable

---

## 4. The booking site API (koorora.asn.au)

Captured by `tools/spike-login.js` (Playwright + HAR) and frozen in `src/kooroo/endpoints.json`. All booking operations are `POST https://www.kooroora.asn.au/wp-admin/admin-ajax.php` with an `action` param. The site is a WordPress + Ultimate Member installation with a custom plugin called "Tennis Plus Court Booking" (tpcb).

| Action | Purpose | Body params |
|---|---|---|
| `tpcb_get_day_schedule` | List courts + bookings for a date | `date` |
| `tpcb_create_booking` | Book a slot | `date, from, to, court_id, user_id` |
| `tpcb_update_booking` | Move/resize | `id, date, from, to` |
| `tpcb_delete_booking` | Cancel | `id` |

`user_id` and `contact_id` are extracted from a global JS object `tpcb_court_params` that the booking page exposes after login. The KoorooClient bootstraps these by GETting `/members-court-booking/` and parsing with a regex.

### Time slot model
- 30-minute slots numbered from 1
- Slot 1 = 00:30, slot 13 = 06:30, slot 17 = 08:30, slot 38 = 19:00, slot 45 = 22:30
- `slotToTime()` and `timeToSlot()` in `src/kooroo/client.js` handle the conversion

### Court mapping
- The UI exposes **Court 4, 5, 6** (the C-numbers). Members can only book these three.
- Internally they map to API `court_id` = `5, 6, 7` (see `COURT_TO_API` in `src/agent/recurring.js`)

### Auth model
- Login: `POST /login/` (form id 5426), with `_wpnonce` and `username-5426` / `user_password-5426` fields
- Session: cookies `wordpress_sec_*` (path `/wp-admin` and `/wp-content/plugins`) + `wordpress_logged_in_*` (path `/`)
- The login form is gated by Google reCAPTCHA v2 (site key `6LcaD4EUAAAAACcSCzAtYen8ahC6hEIEh6EbJsF6`) — this is why we can't re-login from raw HTTP and need Playwright

### Error vocabulary
The server uses HTTP 404 for almost all error cases. The categoriser in `src/agent/fire.js` decodes the body:
- `"Your booking has been made."` → `booked`
- `"Please reserve a different court. This one is already booked by a member."` → `no_time_available`
- `"The court you are trying to book does not exist."` → `technical_error / court_invalid`
- `"This booking cannot be made yet. Please wait until the time is allowed under the Court Booking Rules."` → `technical_error / window_not_open`
- 401/403 → `technical_error / auth_required`

---

## 5. State machine

### Per-account (`src/agent/state.js`)
```
                ┌────────────┐
                │  waiting   │   credentials added, not yet tested
                └─────┬──────┘
                      │ /api/accounts (Playwright re-login) OR probe ok
                ┌─────▼──────┐
                │ tested_ok │   logged in, params bootstrapped
                └─────┬──────┘
                      │ scheduler warmup T-(lead_minutes)
                ┌─────▼──────┐
                │ token_    │   fresh session, ready to fire
                │  ready    │
                └─────┬──────┘
                      │ warmup finishes (T - 5 min)
                ┌─────▼──────┐
                │  primed   │   session + primed body ready
                └─────┬──────┘
                      │ T+0 (waitUntilExact)
                ┌─────▼──────┐
                │ attempting│   POST in flight
                └─────┬──────┘
                      │ response
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
   ┌────────┐   ┌────────┐   ┌──────────────┐
   │ booked │   │ failed │   │ login_       │
   └────┬───┘   └────┬───┘   │  required    │
        │            │       └──────────────┘
        │            │
        └────► token_ready   (next attempt or next week)
```

A banner appears on every page when an account is in any "bad" state (`failed`, `no_time_available`, `technical_error`, `session_expired`, `login_required`, `error`) within the last 7 days and the error hasn't been dismissed.

### Per-recurring
- `first_occurrence_action` starts as `book_now` (always — see below)
- After the first fire resolves, it becomes `resolved`
- The scheduler writes the result via `recurring.setLastResult()` → `last_status`, `last_msg`, `last_error_category`, `last_fire_at`
- `error_dismissed_at` is set when the user clicks "Dismiss" on the banner; banner reappears when a new error occurs (compared on `last_fire_at > error_dismissed_at`)

---

## 6. Time handling

`src/agent/time.js` is the single source of truth for time. It uses `Intl.DateTimeFormat` with `timeZone: 'Australia/Sydney'` — no external tz library, no system-ICU dependency for AEST/AEDT (the helper `sydneyTzAbbrev()` derives AEST vs AEDT by computing the offset).

Key functions:
- `nextWeekdayAt(dayOfWeek, hhmm, { after })` — UTC ms of the next occurrence at or after `after`
- `sydneyWallToUtc(dateStr, hhmm)` — exact UTC ms of a Sydney wall-clock time
- `sydneyDateString(utcMs)` / `sydneyTimeString(utcMs)` — formatted in Sydney tz
- `waitUntilExact(targetMs)` — setTimeout + tight sleep + 5ms busy-wait, ≤10ms drift
- `partsInSydney(d)` / `sydneyTzAbbrev(d)` — building blocks for the formatters

DST is automatic: `Intl.DateTimeFormat` knows the Sydney rules, and the offset-based AEST/AEDT detection doesn't depend on a system tz database.

The Kooroo server enforces a 7-day advance window: you can only book a slot that's within 7 days of now. So the **release moment** for a target slot is exactly 7 days before the slot's start time, to the hour. The scheduler fires at that exact millisecond.

---

## 7. The scheduler

`src/agent/scheduler.js` is the brain. It's a single in-process timer pool.

```
schedule(recurringId):
  rec = repo.recurring.get(recurringId)
  if not rec.enabled → clearTimers, return
  nextUtc = rec.next_fire_at (ms)
  delta = nextUtc - now
  isImmediate = (delta <= 1000 ms)
  leadMs = config.defaultLeadMinutesBeforeFire * 60_000  (default 5 min)

  if isImmediate:
    setTimeout(executeImmediateBooking, 200ms)
  else:
    setTimeout(warmup.warm, delta - leadMs)     # ~T-5 min
    setTimeout(executeScheduledBooking, delta)   # T+0
```

### Why two paths: immediate vs scheduled

- **Immediate** (`< 1s away`): the slot we want to book is right now, OR the recurring was just created and the first occurrence is within 7 days. `executeImmediateBooking` does the 3-attempt retry (preferred court → 4 → 5 → 6) with 15s gaps between attempts. After 3 attempts it writes `"3 bookings failed to succeed"` and chains to next week.
- **Scheduled** (`>= 1s away`): the fire time is the release moment (7 days before the target). `executeScheduledBooking` waits for the exact millisecond via `waitUntilExact`, then tries the 3 courts in quick succession (no 15s gaps) because at the release moment every other bot is also firing.

### Lead minutes

`LEAD_MINUTES_BEFORE_FIRE=5` (env, default 5). The warmup at T-lead runs `warmup.warm()` which:
1. Probes the session (probe.members-court-booking/ → 200?)
2. If expired, triggers a Playwright re-login (slow: 15-30s)
3. Bootstraps `tpcb_court_params` if not loaded
4. Builds the prebuilt POST body (`URLSearchParams` → string) and stores it on the in-memory client

So by T+0, the agent has a fresh session and a pre-built request — no string-concat or dict-lookup work during the fire itself.

### Chaining

After a fire (success or failure), `recurring.chainToNextWeek(id)`:
1. Find the most recent `fire_event` with a `date` + `time` for this recurring
2. Compute that slot's UTC time = next fire time (v3.4: NOT + 7 days)
3. Write it to `next_fire_at`

The intuition: "I just attempted to book slot T. The next slot I want to book is T+7d. The release window for T+7d opens at T. So my next fire should be at T." This is exact because the chain uses the actual slot time of the previous attempt, not a computation from "now".

**Why not `slotUtc + 7d`?** The earlier v3 chain was `slotUtc + 7d`, which set the next fire to the **closing** moment of the next slot (too late). For a 15 Jul 19:00 slot booked at 8 Jul 19:00, the old chain would set the next fire to 15 Jul 19:00 — which is the closing of the 15 Jul slot, not the opening of the 22 Jul slot. The fire at 15 Jul 19:00 would then try to book 15 Jul 19:00 again. The v3.4 fix uses just `slotUtc` (the opening of the next slot).

### `slotForFire` — what slot does a given fire attempt to book?

`src/agent/scheduler.js`:
```js
function slotForFire(rec, fireMs) {
  if (!rec.last_fire_at && rec.first_slot_date) {
    // First fire: the user-picked slot date.
    return { date: rec.first_slot_date, from, to };
  }
  // Subsequent fires: the next slot is 7 days after the fire time.
  return { date: sydneyDateString(fireMs + 7 * 86_400_000), from, to };
}
```

The `last_fire_at` is set after the first fire (by `setLastResult`), so the same `slotForFire` correctly handles both cases. The `from` and `to` are the 30-min slot range derived from `rec.time` (e.g. 19:00 → 38, 20:00 → 40).

### `nextBookingTarget` — what the next fire will book

For the recurring detail page (`/recurring/:id`):
```js
function nextBookingTarget(rec) {
  if (!rec.next_fire_at) return null;
  return slotForFire(rec, new Date(rec.next_fire_at).getTime());
}
```

The route handler pre-formats the target so the view doesn't need to call `slotToTime` (EJS in production doesn't expose `require`). The view shows e.g. "Next attempt: 8 Jul 7:00 PM AEST" → "Booking target: Wed 7pm (2026-07-15 19:00)".

### Missed fires (boot recovery)

`rescanAll()` runs every 5 minutes and on startup. For every enabled recurring:
- If `next_fire_at < now - 60s`, we treat the fire as missed:
  - Write a `skipped` `fire_event` with the original scheduled time
  - Compute the next target via `nextWeekdayAt()` from now
  - Update `next_fire_at` to the new release time
  - This means a server restart doesn't lose the schedule, but a 1+ hour downtime does mean a week is skipped

### Why sub-second precision

`setTimeout()` in Node has a 1ms resolution but can be delayed by the event loop. To fire at the exact millisecond:
```js
function waitUntilExact(targetMs) {
  return new Promise((resolve) => {
    const tick = () => {
      const remaining = targetMs - Date.now();
      if (remaining <= 0) return resolve(Date.now());
      if (remaining > 50) return setTimeout(tick, remaining - 25);   // long sleep
      if (remaining > 5) return setTimeout(tick, remaining - 1);    // tight sleep
      const end = process.hrtime.bigint() + BigInt(remaining) * 1_000_000n;
      const spin = () => {
        if (process.hrtime.bigint() >= end) return resolve(Date.now());
        setImmediate(spin);
      };
      spin();                                                       // busy-wait last 5ms
    };
    tick();
  });
}
```

Tested to ≤10ms drift. The whole fire sequence (waitUntilExact + 3 court POSTs) is well under 1s in the optimistic case.

---

## 8. The fire path in detail

```
executeScheduledBooking(rec, fireMs):
  prepared = prepareForFire(rec, fireMs)        # 1. warm
    ├─ build slotForFire(rec, fireMs)           #    date + from + to in Sydney tz
    ├─ warmup.warm(accountId, {date, from, to, courtId})
    │   ├─ ensureFreshSession → probe → if expired, relogin
    │   ├─ bootstrapParams if not loaded
    │   ├─ parse cookie expiry → save to accounts.session_expires_at
    │   └─ buildPrebuiltRequest → URLSearchParams to string, stored on client
  
  await waitUntilExact(fireMs)                  # 2. drift-corrected wait
  
  result = fireScheduled({rec, targetMs, client, primed})
    ├─ state.transition(accountId, ATTEMPTING)
    ├─ fireCourts(client, {date, from, to, courts, attempt: 1})
    │   ├─ for each court in [pref, ...ascending others]:
    │   │   ├─ build POST body (URLSearchParams)
    │   │   ├─ write fire_event(status: 'attempting', attempt, court_attempted)
    │   │   └─ postCreate(client, body)        # undici POST to admin-ajax.php
    │   │       ├─ categorize(status, body, error)
    │   │       └─ if 'booked' → return success
    │   │       └─ if 'auth_required' → stop chain
    │   │       └─ else → try next court
    │   └─ return {status, body, category, courtId}
    └─ return {...}
  
  recordAndPersistScheduledFire(...)            # 3. log
    ├─ write fire_event(status, attempt, fired_at, latency_ms, response_status, response_body, error)
    ├─ if 'booked' → write bookings row, find external_id from re-fetched schedule
    ├─ state.transition(accountId, BOOKED or FAILED or SESSION_EXPIRED)
    └─ recurring.setLastResult(id, {status, msg, category})
  
   recurring.chainToNextWeek(rec.id)            # 4. chain
     └─ find latest fire_event, set next_fire_at = slotUtc  (v3.4: NOT + 7d)
   
   repo.recurring.update(id, {first_occurrence_action: 'resolved'})
   schedule(rec.id)                              # 5. re-arm
```

Total budget in the optimistic case: 5s warmup at T-5min + ≤10ms drift-corrected wait + ~200ms first POST. Worst case: 5s warmup + drift + 600ms first POST (timeout) + 600ms second + 600ms third = ~2.4s total.

---

## 9. First-occurrence: how `next_fire_at` is computed

For a new recurring with `first_slot_date="2026-07-15"`, `time="19:00"`:

```js
// src/agent/recurring.js: add()
let firstFireUtc = sydneyWallToUtc(first_slot_date, time) - 7 * 86_400_000;  // opening
if (firstFireUtc <= Date.now()) {
  firstFireUtc = sydneyWallToUtc(first_slot_date, time);                       // closing
}
```

- **Picked date > 7 days out**: `firstFireUtc = picked_date - 7d` (the opening). The fire happens then.
- **Picked date within 7 days**: the opening is in the past, so we fall back to the picked date itself (the closing). The slot can still be booked up to its start time, and the Koorora API will accept or reject.

For a new recurring WITHOUT `first_slot_date` (legacy path), the first fire is `nextWeekdayAt(day_of_week, time, { after: now })` — the next occurrence of that weekday+time, which is always 0-7 days away. This is the v2.1 behavior.

The "schedule" path is only meaningful for second-and-later fires (via `chainToNextWeek`), where the target slot is 7 days in the future from the previous fire.

---

## 10. Non-recurring (one-shot) watches

The Make Booking form's "Make this a recurring weekly booking" toggle, when OFF, posts to `/api/watches`. The API auto-detects:

```js
const target = new Date(date_from + 'T00:00:00');
const diffDays = (target - today) / 86_400_000;
const strategy = diffDays <= 7 ? 'watch' : 'scheduled';
```

- **Within 7 days**: create the watch AND immediately call `monitor.runWatch` to attempt the booking. Return the attempt result in the response.
- **> 7 days**: create the watch with `strategy='scheduled'`. The new `fire-due-watches` cron (every 1 minute) picks it up.

### `fire-due-watches` cron (`src/agent/jobs.js`)

```
Every minute:
  for each enabled watch with fired_at IS NULL:
    if isWithinBookingWindow(date_from):
      runWatch(watch)             # attempts the booking
      setFired(watch)            # marks fired_at = now()
```

The `fired_at` column is the one-shot guarantee. After firing (success OR fail), `monitor.runWatch` sets `watches.fired_at`. The cron filters `fired_at IS NULL`, so a fired watch is never re-attempted.

The user must create a new watch to retry a failed attempt.

### Why a separate path from recurring

Watches are a one-shot, while recurrings are a weekly schedule. Watches:
- Don't chain (no next-week timer)
- Don't have a `day_of_week` (they have a specific `date_from`)
- Don't have `first_slot_date` (they have the date itself)

The legacy `monitor.js` is the watches path. The `scheduler.js` is the recurring path. Both call into `fire.js` to actually attempt the booking.

---

## 11. Authentication & sessions

### Admin (dashboard) session
- `express-session` with `MemoryStore` (fine for single-user; the warning in startup logs is acknowledged)
- `SESSION_SECRET` env var, 32+ bytes, falls back to a dev value with a console warning
- `ADMIN_USER` / `ADMIN_PASS` from env, bcrypt-hashed in memory at startup (not stored in the DB)
- Cookie: `httpOnly`, `sameSite=lax`, 12h max age
- Login form posts to `/login`; bad creds → 401 with the form re-rendered

### Kooroo (target site) session
- Captured by Playwright (`tools/spike-login.js`) into `data/spike-cookies.json` (filtered to `kooroora.asn.au` only)
- Imported into the DB via `tools/import-session.js --probe` which:
  1. Creates the `accounts` row
  2. Hydrates `sessions` with the cookies (full cookie objects, not a serialized string)
  3. Probes `/members-court-booking/` to confirm the session is alive
  4. Bootstraps `user_id` and `contact_id` from the booking page
- The `KoorooClient` re-hydrates from the DB on every request (no in-memory cache; cold restart is fine)
- WordPress sessions are short-lived (a few days). When `ensureSession` detects a 302 from the booking page, it falls back to a Playwright re-login via `reloginWithBrowser()` — slow (15-30s) but reliable
- The re-login flow: `tools/relogin-browser.js` style is inlined into the `reloginWithBrowser()` function in `src/kooroo/auth.js`, which spawns `tools/spike-login.js` as a child process and then runs `import-session.js --probe` to save the new cookies

---

## 12. Data tier (v3)

Three pieces, with different lifecycles:

```
┌────────────────────────────────────┐
│ ./data/bookingagent.sqlite          │   bind mount -> container /app/data
│ + .shm + .wal (WAL mode)           │   survives container rebuilds
│                                    │   survives image upgrades
│                                    │   survives `docker compose down`
│                                    │   NOT removed by `docker compose down -v`
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ bookingagent_backups (named vol)   │   container /app/backups
│ - bookingagent-YYYYMMDDTHHMMSSZ.  │   daily via tools/backup.sh
│   sqlite                          │   30-day retention (prune)
│ - .sha256 sidecar                  │   survives host rm -rf backups/
│ - .counts sidecar (row counts)     │
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ caddy_data (named vol)              │   TLS cert + ACME account
└────────────────────────────────────┘
```

### Why a bind mount for the DB
- The user can `ls -la data/`, `sqlite3 data/bookingagent.sqlite`, even `rm -rf node_modules` and reinstall without losing data
- `docker compose down -v` doesn't touch bind mounts (only named volumes), which is the common "I thought I was just removing containers" mistake
- Trade-off: bind mounts are slightly less portable (the path is hardcoded in `docker-compose.yml`) — for fully portable production you'd switch to a named volume (see `DEPLOY.md` for the migration steps)

### Why a named volume for backups
- If you accidentally `rm -rf backups/`, the daily snapshots still exist
- Backups are an output, not a working file — they're a "I have my own lifecycle"

### Backup strategy (`tools/backup.sh`)

```
1. Try hot backup via the app container:
   docker compose exec -T app node -e "
     const Database = require('better-sqlite3');
     const db = new Database('/app/data/bookingagent.sqlite');
     await db.backup('/tmp/backup.sqlite');
     db.close();
   "
   docker compose cp app:/tmp/backup.sqlite backups/...

2. If hot backup fails (container down), use a one-shot container to do the backup
   in the same user context as the DB file (uid 100), so the WAL can be checkpointed.

3. Compute SHA256 of the backup, write .sha256 sidecar
4. Compute row counts via the app's bundled sqlite, write .counts sidecar
5. Prune backups older than BACKUP_RETENTION_DAYS (default 30)
```

The hot backup is the right way to snapshot a SQLite DB in WAL mode: it gets a consistent view of all committed transactions, even if writes are happening concurrently. A raw `cp` of the main file would miss anything still in `bookingagent.sqlite-wal`.

### Restore (`tools/restore.sh`)

```
1. Find backup (default = latest by mtime)
2. Verify SHA256 against the sidecar
3. Stop the app container
4. Snapshot the current DB to a "pre-restore" backup (in case the restore is bad)
5. Copy the chosen backup to data/bookingagent.sqlite
6. Restart the app
7. Wait for /healthz to come up
```

### Deploy (`tools/deploy.sh`)

```
1. tools/backup.sh --label=pre-deploy   # snapshot before rebuild
2. docker compose build app             # rebuild image
3. docker compose up -d                 # restart (rolling)
4. Wait for /healthz
5. Print container status
```

To roll back: `tools/restore.sh` (or pick a specific file).

---

## 13. Cron jobs (`src/agent/jobs.js`)

Three in-container cron tasks. None of them are user-facing; they're for housekeeping.

| Cron | What |
|---|---|
| `*/1 * * * *` (`fire-due-watches`) | `monitor.fireDueWatches()` — picks up non-recurring watches whose `date_from` is now within the 7-day Koorora window and fires them. Skips watches with `fired_at IS NOT NULL` so non-recurring bookings are one-shot. |
| `*/10 * * * *` (`SESSION_PROBE_CRON`, legacy — v3.5 removed) | `pool.probeAll()` — checks every account's session. The v3.5 model uses per-recurring session checks in the scheduler instead. |
| `0 3 * * *` | `repo.audit.prune(30)` — drop `audit_log` rows older than 30 days |
| `30 2 * * *` (`BACKUP_CRON`) | Touches `/app/backups/.last-run` (the actual backup file is written by the host-side `tools/backup.sh`, which should also be in a host cron) |

The backup marker is a small JSON file with `ran_at` + `host`. The dashboard can read it to show "last backup ran X minutes ago", but currently we don't surface it in the UI — it's there for the operator.

The per-recurring session check is what keeps long-lived recurring bookings from failing when the WordPress session quietly expires. v3.5 removed the 24/7 cron (`SESSION_PROBE_CRON`) in favour of "probe only when needed, only for the accounts that have an upcoming fire" — much less network traffic.

---

## 14. API surface

All endpoints require an admin session (except `/healthz` and `/login`).

### Accounts
- `GET /api/accounts` — list
- `POST /api/accounts` — add (triggers Playwright re-login to verify)
- `PATCH /api/accounts/:id` — update
- `DELETE /api/accounts/:id` — delete
- `POST /api/accounts/:id/relogin` — manual Playwright re-login
- `POST /api/accounts/:id/probe` — session probe, updates state
- `GET /api/accounts/:id/state` — current state pill

### Recurring
- `GET /api/recurring?enabled=true|false` — list (optionally filtered)
- `POST /api/recurring` — add (label is auto-generated; `fallback_enabled` is a boolean). v3.4+: accepts `first_slot_date` (YYYY-MM-DD) to anchor the weekly schedule. Court is auto-allocated when `court_pref` is null/empty/`"any"`.
- `PATCH /api/recurring/:id` — update
- `DELETE /api/recurring/:id`
- `POST /api/recurring/:id/book-now` (alias: `fire-now`) — manual trigger
- `POST /api/recurring/:id/dismiss-error` — hide the error banner for this recurring
- `GET /api/recurring/:id/attempts` (alias: `fire-events`) — full history

### Watches (non-recurring, one-shot)
- `GET /api/watches` — list (including `fired_at`)
- `POST /api/watches` — add. v3.5: auto-detects strategy based on `date_from` (within 7 days = immediate attempt, > 7 days = scheduled). The response includes `{ watch, attempt }` so the form can show what happened.
- `DELETE /api/watches/:id`
- `POST /api/monitor/run` — run all enabled non-fired watches now (useful for testing)

### Booking log (audit of attempts)
- `GET /api/booking-log?status=...&recurring_id=...&account_id=...&limit=...` (alias: `/api/fire-events`)
- `GET /api/recurring/:id/attempts` — same query scoped to one recurring

### Health / errors
- `GET /healthz` — `{ok:true, ts:...}` (no auth)
- `GET /api/errors/active` — unacknowledged errors (drives the dashboard banner)
- `GET /api/scheduler/status` — armed timers
- `GET /api/audit?account_id=...&limit=...` — raw outbound HTTP log

### Legacy (v1, still functional)
- `GET/POST /api/bookings` — manual bookings (the "Bookings" page)
- `POST /api/bookings/:id/cancel`

---

## 15. UI layer

`src/views/` is plain EJS. No build step. The CSS is a single block in `partials/header.ejs` (dark theme, ~200 lines).

### Per-request locals
Every render goes through `dashboard.js#withLocals(extra)` which adds:
- `activeErrors` — the unacknowledged errors (drives the top banner)
- `format` — the v3 formatter (Sydney time, truncate, buildRecurringLabel)
- `query` — the request query object (for pagination)

### Countdown + flash
`partials/footer.ejs` runs two tiny loops every 1s:
- `tickCountdowns()` — walks every `[data-fire-at]` element and updates the text to "Nd HH:MM:SS"
- `autoDismissFlashes()` — removes `.flash.auto-dismiss` elements after 4.1s

### Pagination
The overview.ejs computes `currentPage` from `query.page`, clamps to `[1, MAX_PAGES=5]`, and renders page numbers with prev/next. The URL is shareable (`?page=N`).

### Sydney time everywhere
All `ts` and `scheduled_at` / `fired_at` columns are rendered via `format.formatSydneyDateTime()` which gives e.g. `3 Jul 11:50 PM AEST`.

---

## 16. Configuration (env vars)

| Var | Default | Used in |
|---|---|---|
| `KOOROO_BASE_URL` | `https://www.kooroora.asn.au` | `src/config.js` |
| `KOOROO_SPIKE_USER`, `KOOROO_SPIKE_PASS` | (required for spike) | `tools/spike-login.js` |
| `ADMIN_USER`, `ADMIN_PASS` | `admin` / `change-me-please` | `src/server.js` |
| `SESSION_SECRET` | (required in prod) | `src/server.js` |
| `CF_API_TOKEN` | (required) | `Caddyfile` (TLS via Cloudflare) |
| `PORT` | `3000` | `src/server.js` |
| `BIND` | `0.0.0.0` | `src/server.js` |
| `POLL_CRON` | `*/2 * * * *` | (legacy, not used by v2+ scheduler) |
| `SESSION_PROBE_CRON` | `*/10 * * * *` | `src/agent/jobs.js` |
| `LEAD_MINUTES_BEFORE_FIRE` | `5` | `src/agent/scheduler.js` (via config) |
| `DEFAULT_LEAD_DAYS` | `7` | (legacy) |
| `BACKUP_CRON` | `30 2 * * *` | `src/agent/jobs.js` (writes marker) |
| `BACKUP_RETENTION_DAYS` | `30` | `tools/backup.sh` |
| `AUDIT_FULL_BODIES` | `true` | `src/kooroo/client.js` |
| `AUDIT_RETENTION_DAYS` | `30` | `src/agent/jobs.js` (prune) |
| `BACKUP_DIR` | `/app/backups` (in container) | `src/config.js` |
| `DATA_DIR` | `/app/data` | `src/config.js` |

---

## 17. Failure modes & mitigations

| Failure | Detection | Mitigation |
|---|---|---|
| WordPress session expired | `client.probe()` returns 302 to `/login/` | `ensureFreshSession` triggers Playwright re-login (15-30s, then resumes) |
| reCAPTCHA blocks re-login | Playwright reports error | `state.transition(..., LOGIN_REQUIRED)` + banner; user must re-trigger manually |
| Slot already taken | Server returns 404 with "already booked by a member" | Fallback to next court (preferred, then ascending 4 → 5 → 6) |
| All 3 courts taken | All POSTs return no_time_available | Write `"3 bookings failed to succeed"`, chain to next week |
| Server > 7d advance error | 404 with "cannot be made yet" | Categorise as `technical_error / window_not_open`; chain to next week (the fire was a hair too early) |
| Token expires during the fire window | `client.request` returns 401 | Stop the court chain, mark `auth_required`, surface in the banner |
| Server downtime during fire | `fetch` throws | Catch, mark `technical_error / network`, chain to next week |
| `setTimeout` drift | `waitUntilExact` busy-wait | ≤10ms drift measured in tests |
| NTP clock skew | `Intl.DateTimeFormat` uses the server clock | If the server clock is off by > 1s, the fire lands late and the slot is taken; offset against `Date` header in server responses is a future improvement |
| Container restart | `rescanAll()` on startup | Each enabled recurring is re-armed; past-due fires (within 60s grace) are treated as missed, anything older is treated as a fire-from-now |
| 1+ hour downtime | `rescanAll()` skips past due | The week is skipped; chain resumes for the next week |
| Long-running Playwright re-login (reCAPTCHA) | `reloginWithBrowser` throws | `state.transition(..., LOGIN_REQUIRED)`; dashboard shows a banner; user clicks "Re-login" to retry |
| Two server instances running | (out of scope v2) | Both instances would fire — recommend single instance; could add a file-based lock later |
| Disk full | `repo.fireEvents.create()` throws | The error propagates, the fire fails, the chain advances; the error is logged |
| `data/` accidentally deleted | `db.init()` throws on startup | Container restart loop, visible in `docker compose ps`; restore from backup |

---

## 18. What's deliberately NOT in v3

Documented here so a future session doesn't accidentally re-implement them.

- **Multi-account parallel firing** — each recurring uses exactly one account. The user confirmed this.
- **Public holiday detection** — if a Wed is a public holiday, the system still tries to book it; kooroora's own rules will reject it.
- **End date / number of occurrences** — recurring goes on forever until disabled.
- **Email / push notifications** — v1 only.
- **Per-recurring lead minutes** — global default of 5 minutes, configurable via `LEAD_MINUTES_BEFORE_FIRE`.
- **Encryption of stored passwords** — passwords are in plaintext in the `accounts` table (the `cookie_value` for the WordPress session is encrypted by TLS, but the literal `password` field is not). Documented as a known gap.
- **A second factor for admin login** — the admin password is the only barrier. Mitigated by: a long password in `.env` (chmod 600), Caddy rate limiting (not yet configured), and the fact that the dashboard is the only thing at `https://bookings.boomercheugys.com`.

---

## 19. Where to start when picking this up

1. **Read `README.md`** for the user-facing view.
2. **Read `docs/recurring-bookings.md`** for the dedicated design doc on the time-based booking logic (scenarios, edge cases, the math). If you're touching the recurring or watches flow, START HERE.
3. **Read `DEPLOY.md`** for the operator view.
4. **Read `src/server.js`** — the entry point, ~80 lines, mounts routes and starts jobs.
5. **Read `src/agent/recurring.js`** — the recurring CRUD + chain logic, ~230 lines. This is the heart of the time math.
6. **Read `src/agent/scheduler.js`** — the in-process timer pool, ~190 lines. Owns `slotForFire` and `nextBookingTarget`.
7. **Read `src/agent/fire.js`** — the actual POST + categorise, ~240 lines.
8. **Read `src/agent/monitor.js`** — the watches path (`runWatch`, `fireDueWatches`), ~150 lines.
9. **Read `src/agent/courtAllocator.js`** — the court auto-allocation, ~50 lines.
10. **Read `src/kooroo/client.js`** — the undici + tough-cookie client, ~170 lines.
11. **Read `src/db/repo.js`** — the data layer, ~300 lines.
12. **Read `tools/backup.sh`** — the data-tier durability story in 100 lines of bash.

For a feature change:
- New endpoint → edit `src/routes/api.js`, then add the view in `src/views/`
- New cron job → edit `src/agent/jobs.js`
- New scheduler behaviour → edit `src/agent/scheduler.js` and possibly `recurring.js`
- New kooroora API → edit `src/kooroo/endpoints.json` (or regenerate via `tools/spike-login.js` + `tools/extract-endpoints.json`)
- Touching the recurring time math → edit `docs/recurring-bookings.md` first to capture the design, then update the code, then update the tests in `test/smoke.test.js`.

For a deployment:
- `tools/deploy.sh` (auto-snapshots)
- `tools/restore.sh` (rollback)
- `tools/db-stats.sh` (sanity check)

For a data investigation:
- `sqlite3 data/bookingagent.sqlite ".schema"` for tables
- `sqlite3 data/bookingagent.sqlite "SELECT * FROM fire_events ORDER BY id DESC LIMIT 10"` for recent attempts
- `tools/db-stats.sh` for row counts + backup state
