# Kooroo Booking Agent

Multi-account tennis-court booking agent for [kooroora.asn.au](https://kooroora.asn.au) with an admin dashboard.

**Version 3.5** — simplified Make Booking flow, court auto-allocation, per-recurring session checks, non-recurring one-shot watches, and a durable data tier with hot backups.

## Docs

- **`README.md`** (this file) — user-facing: how to run it, what each screen does, deploy guide links
- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — engineering reference: module map, data model, scheduler internals, fire path, state machine, failure modes
- **[`docs/recurring-bookings.md`](docs/recurring-bookings.md)** — the dedicated design doc for the recurring + one-shot booking logic: time math, slot model, scenarios, edge cases, debugging
- **[`DEPLOY.md`](DEPLOY.md)** — operator: data tier, backup procedures, VPS setup, deploy/rollback

## What it does

Kooroora releases booking slots **exactly 7 days before the slot's start time, to the hour**. The agent holds an active session, primes a pre-built POST request minutes before the release, then fires at the exact millisecond to win the race against other bots. It chains successful fires to the following week automatically.

**v4 highlights** — Live push updates
- **Server-Sent Events** stream every state change to every open browser tab: account state transitions, fire events, booking creation, recurring updates, error appeared/dismissed.
- **Smart heartbeat** scales between 2s (when a fire is imminent or in flight) and 30s (default). Detects dead connections within 2s of a fire but stays quiet between fires.
- **Defensive by design**: every push handler is wrapped in try/catch, malformed JSON is logged + ignored, the page renders its initial state from EJS so it works with no JS, events UPDATE rows in place (no whole-view replace, no form wipe). The "Live" indicator in the footer is purely cosmetic.

**v3.6 highlights**
- **Faster fire path** — all pre-POST work (session probe, body build, cookie hydration) now happens at T-leadMs via `warmup.prepareForFire`. The fire callback at T is just `setTimeout(POST)`, not 2-3 seconds of setup. A regression test enforces the < 50ms budget.
- **`booked_unverified` + 30s reconciliation** — when the server confirms a booking but the immediate day-schedule lookup misses it (cache / eventual consistency), the row is recorded as `booked_unverified` and a cron fills in `external_id` within 30s. The dashboard shows a "reconciling…" pill until then; Cancel is disabled because we have no id to send to the server.
- **Audit log no longer stores 147KB HTML pages** — `client.request` only captures request/response bodies for non-GET requests. Shrinks `audit_log` by ~95%. Set `AUDIT_FULL_BODIES=1` for the old behaviour.
- **`booked_on_fallback_court` warning** — when a booking lands on a non-preferred court (the preferred court was taken between warmup and fire), the dashboard shows a "last booking on fallback court" pill on the recurring list, detail, and overview.

**v3.5 highlights**
- **Unified Make Booking form** with a "recurring" toggle:
  - **Off (one-off)**: form posts to `/api/watches`. The agent attempts the booking now if the date is within 7 days, or sets a watcher to fire once when the 7-day window opens. The watcher is one-shot (won't repeatedly reschedule).
  - **On (weekly)**: form posts to `/api/recurring`. The schedule is "every 7 days from the picked date". The first fire is 7 days before the picked date (the opening moment). Each subsequent fire is at the previous slot's time (also the opening of the next slot).
- **Booking target on `/recurring/:id`** — shows the slot the next attempt will book, e.g. "Next attempt: 8 Jul 7:00 PM AEST → Booking target: Wed 7pm (2026-07-15 19:00)".
- **Court auto-allocation** — when you pick "any", the system picks the first court not already taken on that day_of_week+time by another recurring. If all 3 are taken, you get a "no courts available" error pill.
- **Slot model fix** — the chain no longer fires at the closing moment of the next slot (which would book the wrong date). It fires at the opening.
- **Self-healing Docker** — `tools/deploy.sh` chowns the host data dir if the container's uid doesn't match. A new `docker-entrypoint.sh` chowns on every container start.
- **Hardened Playwright** — `playwright` is pinned to 1.47.2 to match the base image's chromium; the base image is `mcr.microsoft.com/playwright:v1.47.2-jammy` so the in-prod re-login works.

**v3 highlights**
- **Auto-generated labels** (`Wed 7pm Crt 4` etc.)
- **Single "fall back to other courts" toggle** — backend iterates preferred first, then ascending
- **Pagination** on Upcoming bookings (6/page, max 5 pages)
- **Username truncated to 7 chars** in tables
- **Human-readable Sydney time** in tables (`3 Jul 7:00 PM AEST` / `15 Dec 7:00 PM AEDT`)
- **Global lead-minutes** — configurable via `LEAD_MINUTES_BEFORE_FIRE`
- **Data tier** — SQLite on a bind mount + daily hot backups to a named volume + `tools/backup.sh`, `tools/restore.sh`, `tools/deploy.sh`, `tools/db-stats.sh`

**v2.1 highlights** (still in place)
- Recurring bookings
- Per-account state machine (`waiting → tested_ok → token_ready → primed → attempting → booked/failed`)
- Manual-dismiss banner for unacknowledged errors
- Booking history with scheduled-vs-actual drift, latency, response excerpts
- Court restriction: only Courts 4, 5, 6 (C-numbers) can be selected

## How it works

**Auth.** WordPress + Ultimate Member. Login is at `/login/` (form id 5426). Sessions are cookie-based: `wordpress_sec_*` (path `/wp-admin` and `/wp-content/plugins`) and `wordpress_logged_in_*` (path `/`). The login form is gated by Google reCAPTCHA v2. New accounts are verified by Playwright re-login at add-time.

**API.** Everything is `POST https://www.kooroora.asn.au/wp-admin/admin-ajax.php` with an `action` param. After login the agent loads `/members-court-booking/` once to extract `tpcb_court_params` (a JS global) which contains `user_id`, `contact_id`, and the booking rules.

**Time slots.** 30-minute slots, `slot 1 = 00:30`, `slot 13 = 06:30`, `slot 17 = 08:30`, `slot 38 = 19:00`, `slot 45 = 22:30`. Use `slotToTime()` / `timeToSlot()` in `src/kooroo/client.js`.

**Court mapping.** UI says "Court 4/5/6" (the C-number). API receives `court_id` = `5/6/7`.

## Quick start (local)
```bash
cp .env.example .env
# edit .env: ADMIN_USER, ADMIN_PASS, SESSION_SECRET, KOOROO_SPIKE_USER, KOOROO_SPIKE_PASS
npm install
npm run migrate
npm run spike
node tools/import-session.js --label "Andrew" --probe
npm start
```

## Data tier

SQLite, kept simple and durable:
- **Active DB**: `data/bookingagent.sqlite` (bind mount → container `/app/data`). Survives container rebuilds, image upgrades, and `docker compose down`. Not removed by `docker compose down -v`.
- **Backups**: a separate named Docker volume `bookingagent_backups` (mapped to `/app/backups` in the container). Daily at 02:30 UTC, 30-day retention, SHA256 + row-count sidecars. `tools/backup.sh` does a hot backup via SQLite's `.backup()` API (no downtime).
- **Restore**: `tools/restore.sh` (default = latest, or pass a specific filename). Verifies SHA256 first.
- **Pre-deploy snapshot**: `tools/deploy.sh` runs `tools/backup.sh --label=pre-deploy` before rebuilding, so you can always roll back.
- **Stats**: `tools/db-stats.sh` for row counts, DB size, and backup state.

## Adding a booking

Open **Make Booking** in the nav. Fill the form (account, court, date, start time, duration). Optionally tick **"Make this a recurring weekly booking"** for a weekly schedule.

The system routes to the right path based on the toggle:
- **Toggle off** (one-off): auto-attempts the booking now (date ≤ 7 days) or sets a watcher (date > 7 days). The watcher fires once when the window opens and never again.
- **Toggle on** (recurring): the schedule is "every 7 days from the picked date". The first fire is at the opening (T-7d). Each subsequent fire is at the previous slot's time = the opening of the next slot.

Live countdowns on the dashboard show when each recurring fires. The recurring detail page (`/recurring/:id`) shows both the next attempt time AND the booking target (the slot that will be booked).

## Adding an account

1. Open **Accounts** → **Add account**.
2. Enter label, username, password.
3. The system runs a Playwright re-login immediately to verify the credentials (15-30s; the dashboard shows a spinner with status text). If it works, the state moves to `tested_ok`. If it fails, you'll see the error in the state column and the account stays `waiting` until you fix the password.

## Speed budget for a scheduled fire (v3.6)

| Step | Time | Notes |
|---|---|---|
| Session probe (T-10 min) | ~1s | Verifies the session is still alive (per-recurring, only for accounts with an upcoming fire) |
| **Pre-stage (T-5 min, v3.6)** | ~1s | `warmup.prepareForFire` does ensureFreshSession + bootstrapParams + builds the prebuilt form fields, stashes a fire-ready context in `fireContexts` Map |
| **Fire (v3.6: at T)** | < 50ms | `popFireContext` + `waitUntilExact` + `tryCreateBooking`. The `setTimeout` callback is just the POST. |
| Server response | 200ms - 8s | Varies by load. The Koorora server is the bottleneck under load, not us. `bodyTimeout` bumped to 10s in v3.6. |
| `findBookingFor` (day-schedule re-fetch) | ~2s | Looks up the just-made booking's external_id. May miss on server cache → `booked_unverified` → 30s reconciliation |
| Fallback to next court | +2-8s | If preferred is taken, sequentially try the rest of the apiCourts |
| **Total pre-POST drift** | **< 50ms (v3.6)** | was 2-3s before v3.6 |

A regression test (`v3.6: executeScheduledBooking — regression guard`) enforces that `prepareForFire` is NOT called in the fire path when a context is stashed. If anyone re-introduces async setup work in the hot path, the test fails.

## Daily operation
- **Recurring scheduler** runs in-process, holds `setTimeout` timers for each upcoming fire.
- **Per-recurring session check** is the model — the scheduler arms a session probe at T-10min (5min before warmup). No more 24/7 cron polling.
- **Pre-stage at T-5min (v3.6)** does the session check, the cookie refresh, and the body build. The fire callback at T is just `setTimeout(POST)`.
- **Fire-due-watches cron** (every 1 minute) picks up any non-recurring watches whose `date_from` is now within the 7-day window. Watches that have already fired (`fired_at IS NOT NULL`) are skipped — non-recurring bookings are one-shot.
- **Reconcile cron (v3.6, every 30s)** fills `external_id` for `booked_unverified` bookings.
- **Audit prune** at 03:00 trims `audit_log` rows older than `AUDIT_RETENTION_DAYS`.
- **First-immediate retry** on the immediate path: 3 attempts, 15s apart, then writes `"3 bookings failed to succeed"` and chains to next week.

## API (JSON, admin session required)
- `GET/POST /api/recurring` / `PATCH /api/recurring/:id` / `DELETE /api/recurring/:id`
- `POST /api/recurring/:id/book-now` / `POST /api/recurring/:id/fire-now` — manual trigger
- `POST /api/recurring/:id/dismiss-error` — hides the banner
- `GET /api/recurring/:id/fire-events` — full history for one recurring
- `GET /api/watches` / `POST /api/watches` / `DELETE /api/watches/:id`
- `POST /api/monitor/run` — run all due non-recurring watches now
- `GET /api/booking-log` (or `/api/fire-events`) — full attempt log
- `GET /api/errors/active` — what's currently on the banner
- `GET /api/scheduler/status` — what timers are armed
- `GET /api/accounts/:id/state` — current state pill
- `POST /api/accounts/:id/relogin` — Playwright re-login
- `POST /api/accounts/:id/probe` — session probe

## Deploy (VPS)
```bash
# One-shot
docker compose up -d --build

# Subsequent updates (auto-snapshots DB first, then rolls forward)
tools/deploy.sh

# Roll back
tools/restore.sh           # latest backup
```
See `DEPLOY.md` for the full data-tier story.

## Project layout
```
src/
  server.js                 Express entry, mounts routes, starts jobs
  config.js                 env → typed config
  logger.js                 JSON-line logger
  db/                       schema.sql + better-sqlite3 repo (incl. v2.1 recurring + fire_events)
  kooroo/
    client.js               undici + tough-cookie, slot<->time
    auth.js                 login / probe / relogin (Playwright)
    availability.js         getDaySchedule parser
    booking.js              create / cancel
    endpoints.json          discovered contract
  agent/
    time.js                 Sydney-time helpers, waitUntilExact
    state.js                account state machine
    warmup.js               token pre-warm + prebuilt request
    fire.js                 fireOne, categorize, fireCourts, fireImmediate
    recurring.js            CRUD + chain + first-immediate + auto-label + first_slot_date
    scheduler.js            per-recurring timer arm, prime, missed-fire recovery
    pool.js                 per-account client pool
    monitor.js              legacy one-shot watches (runWatch, fireDueWatches, isWithinBookingWindow)
    booker.js               manual book / cancel
    jobs.js                 crons: fire-due-watches, audit.prune, backup.marker
    courtAllocator.js       v3.1 — court auto-allocation on the recurring
  routes/                   auth, dashboard, api
  views/                    EJS templates (overview, accounts, make_booking, bookings, recurring, recurring_detail, ...)
tools/
  spike-login.js            one-off Playwright login + HAR capture
  extract-endpoints.js      HAR -> endpoints.json
  import-session.js         spike-cookies.json -> DB
  probe-api.js              read schedule + book/cancel smoke test
  cancel-my-bookings.js     bulk cancel your bookings on a date
  probe-error-responses.js  capture the server's error messages for the categoriser
  backup.sh                 hot backup (SQLite .backup API), SHA256 + counts + prune
  restore.sh                rehydrate from a backup, verifies SHA256 first
  deploy.sh                 snapshot → build → restart with health wait
  db-stats.sh               row counts + DB size + last backup age
test/
  smoke.test.js             57 unit tests
  multi_account_smoke.js    end-to-end: pick 4 same-time slots, verify auto-allocation
docs/
  recurring-bookings.md     design doc for the time-based booking logic
docker-entrypoint.sh        container entrypoint: chown data dir, then exec node
```

## Security
- `.env` is chmod 600 and gitignored. Never commit it.
- `data/spike.har` may contain session cookies — gitignored.
- The audit log persists full request/response bodies. Toggle off with `AUDIT_FULL_BODIES=false`.
- Account passwords are stored in the DB in plaintext (encryption at rest is a future improvement).

## Known constraints
- `tpcb_create_booking` does not return a booking id, so cancellation re-fetches the day's schedule and matches by `(date, court_id, from, to, contact_id)`. Reliable because `contact_id` is unique per member.
- The session is short-lived (WordPress default ~2 days). When it expires, `reloginWithBrowser` re-runs Playwright with stored creds and the reCAPTCHA.
- Times are stored as `HH:MM` 24h strings; only the 30-min grid is supported.
- Multi-account parallel firing is intentionally NOT supported (per design decision). Each recurring uses exactly one account.
- Only Courts 4, 5, 6 (C-numbers) can be selected. These map to API `court_id` = `5, 6, 7`.
- The 7-day booking window is hard-coded. Look for `7 *` in `monitor.isWithinBookingWindow` and the recurring time math if you need to change it.
