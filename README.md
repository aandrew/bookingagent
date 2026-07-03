# Kooroo Booking Agent

Multi-account tennis-court booking agent for [kooroora.asn.au](https://kooroora.asn.au) with an admin dashboard.

## How it works

**Auth.** WordPress + Ultimate Member. Login is at `/login/` (form id 5426). Sessions are cookie-based: `wordpress_sec_*` (path `/wp-admin` and `/wp-content/plugins`) and `wordpress_logged_in_*` (path `/`). The login form is gated by Google reCAPTCHA v2 (site key `6LcaD4EUAAAAACcSCzAtYen8ahC6hEIEh6EbJsF6`) plus a reCAPTCHA v3 script. This means a raw HTTP login from the agent isn't possible — the spike + import flow is used to capture a session once, and `tools/relogin-browser.js` (called by the dashboard "Re-login" button) re-runs the Playwright login when the session expires.

**API.** Everything is `POST https://www.kooroora.asn.au/wp-admin/admin-ajax.php` with an `action` param. After login the agent loads `/members-court-booking/` once to extract `tpcb_court_params` (a JS global) which contains `user_id` (e.g. `76`), `contact_id` (e.g. `10001891`), and the booking rules.

**Actions (Tennis Plus Court Booking plugin):**
| Action                  | Purpose                                  | Params |
|-------------------------|------------------------------------------|--------|
| `tpcb_get_day_schedule` | List courts + bookings for a date        | `date` |
| `tpcb_create_booking`   | Book a slot                              | `date, from, to, court_id, user_id, first_day_of_week, last_day_of_week` |
| `tpcb_update_booking`   | Move/resize a booking                    | `id, date, from, to, first_day_of_week, last_day_of_week` |
| `tpcb_delete_booking`   | Cancel a booking                         | `id` |

**Time slots.** 30-minute slots numbered from 1, where slot `1 = 00:30`. Slot `13 = 06:30`, `17 = 08:30`, `45 = 22:30`. Use `slotToTime()` / `timeToSlot()` in `src/kooroo/client.js`.

## Quick start (local)
```bash
cp .env.example .env
# edit .env: ADMIN_USER, ADMIN_PASS, SESSION_SECRET, KOOROO_SPIKE_USER, KOOROO_SPIKE_PASS
npm install
npm run migrate               # creates data/bookingagent.sqlite
npm run spike                 # Playwright login → captures spike.har + spike-cookies.json
node tools/import-session.js --label "Andrew Stevens" --probe
#   Creates the account, imports cookies, bootstraps tpcb_court_params.
npm start                     # http://localhost:3000
```

## Daily operation
- **Cron monitor** (`POLL_CRON`) runs every enabled watch and books a slot if its criteria match. Defaults to every 2 minutes.
- **Session probe** (`SESSION_PROBE_CRON`) pings `/members-court-booking/` to verify the session; if it 302s to `/login/`, the agent runs a browser re-login.
- **Audit prune** (daily 03:00) trims `audit_log` rows older than `AUDIT_RETENTION_DAYS`.

## API (JSON, admin session required)
- `GET /api/accounts` / `POST /api/accounts` / `PATCH /api/accounts/:id` / `DELETE /api/accounts/:id`
- `POST /api/accounts/:id/relogin` — Playwright re-login
- `POST /api/accounts/:id/probe` — session probe
- `GET /api/watches` / `POST /api/watches` / `PATCH /api/watches/:id` / `DELETE /api/watches/:id`
- `POST /api/watches/:id/book-now` — manual trigger
- `POST /api/monitor/run` — run all enabled watches once
- `GET /api/bookings` / `POST /api/bookings` (manual book) / `POST /api/bookings/:id/cancel`
- `GET /api/audit?account_id=N&limit=200`

## Deploy (VPS)
```bash
docker compose up -d --build
```
- App: `:3000` (no public port — fronted by Caddy)
- Caddy: `:80/:443` with auto-TLS via Cloudflare DNS challenge
- Update `Caddyfile` to use your real domain (`boomercheugys.com` by default) and set `CF_API_TOKEN` in `.env`.

## Project layout
```
src/
  server.js                 Express app + cron startup
  config.js                 env → typed config
  logger.js                 JSON-line logger
  db/                       schema.sql + better-sqlite3 repo
  kooroo/
    client.js               undici + tough-cookie, slot<->time
    auth.js                 login / probe / relogin (Playwright)
    availability.js         getDaySchedule parser
    booking.js              create / cancel
    endpoints.json          discovered contract
  agent/
    pool.js                 per-account client pool
    monitor.js              poll + book
    booker.js               manual book / cancel
    jobs.js                 cron registration
  routes/                   auth, dashboard, api
  views/                    EJS templates
tools/
  spike-login.js            one-off Playwright login + HAR capture
  extract-endpoints.js      HAR -> endpoints.json
  import-session.js         spike-cookies.json -> DB
  probe-api.js              read schedule + book/cancel smoke test
  cancel-my-bookings.js     bulk cancel your bookings on a date
test/smoke.test.js          unit + live API tests
```

## Security
- `.env` is chmod 600 and gitignored. Never commit it.
- `data/spike.har` may contain session cookies — gitignored.
- The audit log persists full request/response bodies. Toggle off with `AUDIT_FULL_BODIES=false`.
- **You shared your kooroo.asn.au password in chat. Rotate it once we're done.**

## Known constraints
- `tpcb_create_booking` does not return a booking id, so cancellation re-fetches the day's schedule and matches by `(date, court_id, from, to, contact_id)`. This is reliable because `contact_id` is unique per member.
- The session is short-lived (WordPress default ≈ 2 days). When it expires, `reloginWithBrowser` re-runs Playwright with stored creds and the reCAPTCHA. Account passwords are stored in the DB (encrypted at rest is a future improvement — use a strong disk + container).
- Times are stored as `HH:MM` 24h strings; only the 30-min grid is supported.
