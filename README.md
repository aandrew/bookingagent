# Kooroo Booking Agent

Multi-account tennis-court booking agent for [kooroora.asn.au](https://kooroora.asn.au) with an admin dashboard.

**Version 3** — UI simplifications (auto-label, single toggle, pagination, Sydney time), global lead minutes, and a durable data tier with hot backups + restore scripts.

## Docs

- **`README.md`** (this file) — user-facing: how to run it, what each screen does, deploy guide links
- **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — engineering reference: module map, data model, scheduler internals, fire path, state machine, failure modes, where to start when picking it up
- **[`DEPLOY.md`](DEPLOY.md)** — operator: data tier, backup procedures, VPS setup, deploy/rollback

## What it does

Kooroora releases booking slots **exactly 7 days before the slot's start time, to the hour**. The agent holds an active session, primes a pre-built POST request minutes before the release, then fires at the exact millisecond to win the race against other bots. It chains successful fires to the following week automatically.

**v3 highlights**
- **Auto-generated labels** for recurring bookings (`Wed 7pm Crt 4` etc.) — no more typing labels
- **Single "fall back to other courts" toggle** — backend automatically iterates preferred first, then ascending
- **Pagination** on Upcoming bookings (6/page, max 5 pages)
- **Username truncated to 7 chars** in tables (e.g. "Andrew" for "Andrew Stevens")
- **Human-readable Sydney time** in tables (`3 Jul 7:00 PM AEST` / `15 Dec 7:00 PM AEDT`)
- **Global lead-minutes** — removed from the per-recurring form; configurable via `LEAD_MINUTES_BEFORE_FIRE`
- **Data tier** — SQLite on a bind mount (survives upgrades, `down -v`) + hot backups daily to a named volume + `tools/backup.sh`, `tools/restore.sh`, `tools/deploy.sh`, `tools/db-stats.sh`

**v2.1 highlights** (still in place)
- Recurring bookings (e.g. "Wed 7pm, Court 5, every week")
- First-occurrence detection — first slot always inside 7d window, so always book_now
- Per-account state machine (`waiting → tested_ok → token_ready → primed → firing → booked/failed`)
- Two error categories: `no_time_available` vs `technical_error`
- Manual-dismiss banner for unacknowledged errors
- Booking history with scheduled-vs-actual drift, latency, response excerpts
- Court restriction: only Courts 4, 5, 6 (C-numbers) can be selected

## How it works

**Auth.** WordPress + Ultimate Member. Login is at `/login/` (form id 5426). Sessions are cookie-based: `wordpress_sec_*` (path `/wp-admin` and `/wp-content/plugins`) and `wordpress_logged_in_*` (path `/`). The login form is gated by Google reCAPTCHA v2 (site key `6LcaD4EUAAAAACcSCzAtYen8ahC6hEIEh6EbJsF6`). New accounts are verified by Playwright re-login at add-time, so credentials are tested before they're saved as "ready".

**API.** Everything is `POST https://www.kooroora.asn.au/wp-admin/admin-ajax.php` with an `action` param. After login the agent loads `/members-court-booking/` once to extract `tpcb_court_params` (a JS global) which contains `user_id`, `contact_id`, and the booking rules.

**Actions (Tennis Plus Court Booking plugin):**

| Action | Purpose | Params |
|---|---|---|
| `tpcb_get_day_schedule` | List courts + bookings for a date | `date` |
| `tpcb_create_booking` | Book a slot | `date, from, to, court_id, user_id` |
| `tpcb_update_booking` | Move/resize | `id, date, from, to` |
| `tpcb_delete_booking` | Cancel | `id` |

**Server error messages (for the categoriser):**
- `"Your booking has been made."` → booked
- `"Please reserve a different court. This one is already booked by a member."` → `no_time_available`
- `"The court you are trying to book does not exist."` → `technical_error / court_invalid`
- `"This booking cannot be made yet. Please wait until the time is allowed under the Court Booking Rules."` → `technical_error / window_not_open`

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

## Adding a recurring booking

1. Open **Recurring** in the nav.
2. Fill the form: account, label, day-of-week, time (Sydney), court preference (4/5/6), fallback checkboxes.
3. Click **Add**. The system computes the first occurrence:
   - If the first slot is within 7 days, the state moves to `book_now` and the fire happens within a few seconds.
   - Otherwise, the state moves to `schedule` and a timer is armed for the 7-day-out release moment.
4. The dashboard shows a live countdown to the next fire. Pre-warming starts at T-(lead_minutes).
5. After each fire, the system chains to the following week automatically.

## Adding an account

1. Open **Accounts** → **Add account**.
2. Enter label, username, password.
3. The system runs a Playwright re-login immediately to verify the credentials. If it works, the state moves to `tested_ok`. If it fails, you'll see the error in the state column and the account stays `waiting` until you fix the password.

## Speed budget for a scheduled fire

| Step | Time | Notes |
|---|---|---|
| Warm-up (T-10 min) | ~1s | Probe session, bootstrap params, pre-build POST body |
| Final probe (T-5 min) | ~0.5s | Ensures session is still alive |
| `waitUntilExact` | drift ≤ 10ms | `setTimeout` + busy-wait last 5ms |
| Fire (preferred court) | ~200-500ms | First POST |
| Fallback to court 5 | +200ms | If preferred is taken |
| Fallback to court 6 | +200ms | If preferred and 5 are taken |
| Total | < 1s in optimistic case | |

## Daily operation
- **Recurring scheduler** runs in-process, holds `setTimeout` timers for each upcoming fire.
- **Session probe** every 10 min pings `/members-court-booking/`; on 302 it triggers a Playwright re-login.
- **Audit prune** at 03:00 trims `audit_log` rows older than `AUDIT_RETENTION_DAYS`.
- **First-immediate retry** on the immediate path: 3 attempts, 15s apart, then writes `"3 bookings failed to succeed"` and chains to next week.

## API (JSON, admin session required)
- `GET/POST /api/recurring` / `PATCH /api/recurring/:id` / `DELETE /api/recurring/:id`
- `POST /api/recurring/:id/fire-now` — manual trigger (useful for tests)
- `POST /api/recurring/:id/dismiss-error` — hides the banner
- `GET /api/recurring/:id/fire-events` — full history for one recurring
- `GET /api/fire-events?recurring_id=N&account_id=N&status=no_time_available`
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
  server.js                 Express app + cron startup
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
    time.js                 v2.1 — Sydney-time helpers, waitUntilExact
    state.js                v2.1 — account state machine
    warmup.js               v2.1 — token pre-warm + prebuilt request
    fire.js                 v2.1 — fireOne, categorize, fireCourts, fireImmediate
    recurring.js            v2.1 — CRUD + chain
    scheduler.js            v2.1 — sub-second timer arm, prime, missed-fire recovery
    pool.js                 per-account client pool
    monitor.js              legacy one-shot watch
    booker.js               manual book / cancel
    jobs.js                 startup
  routes/                   auth, dashboard, api
  views/                    EJS templates (recurring, recurring_detail, fire_events, ...)
tools/
  spike-login.js            one-off Playwright login + HAR capture
  extract-endpoints.js      HAR -> endpoints.json
  import-session.js         spike-cookies.json -> DB
  probe-api.js              read schedule + book/cancel smoke test
  cancel-my-bookings.js     bulk cancel your bookings on a date
  probe-error-responses.js  v2.1 — capture the server's error messages for the categoriser
  backup.sh                 v3 — hot backup (SQLite .backup API), SHA256 + counts + prune
  restore.sh                v3 — rehydrate from a backup, verifies SHA256 first
  deploy.sh                 v3 — snapshot → build → restart (use for upgrades)
  db-stats.sh               v3 — row counts + DB size + last backup age
test/smoke.test.js          unit + live API tests
```

## Security
- `.env` is chmod 600 and gitignored. Never commit it.
- `data/spike.har` may contain session cookies — gitignored.
- The audit log persists full request/response bodies. Toggle off with `AUDIT_FULL_BODIES=false`.
- **You shared your kooroo.asn.au password in chat. Rotate it once we're done.**

## Known constraints
- `tpcb_create_booking` does not return a booking id, so cancellation re-fetches the day's schedule and matches by `(date, court_id, from, to, contact_id)`. Reliable because `contact_id` is unique per member.
- The session is short-lived (WordPress default ~2 days). When it expires, `reloginWithBrowser` re-runs Playwright with stored creds and the reCAPTCHA. Account passwords are stored in the DB in plaintext (encryption at rest is a future improvement).
- Times are stored as `HH:MM` 24h strings; only the 30-min grid is supported.
- The `nextWeekdayAt` helper returns the *next* occurrence (0-7 days away). The first fire of a recurring is therefore always `book_now` (the slot is already inside the 7-day window). Subsequent fires are scheduled for the slot time we just booked.
- Multi-account parallel firing is intentionally NOT supported (per design decision). Each recurring uses exactly one account.
