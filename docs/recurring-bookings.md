# Recurring Booking Logic — Design

> **Version:** 3.6 · **Last updated:** 2026-07-11
> **Owns:** weekly schedule model, fire-time computation, court auto-allocation, chain, fire-path timing, booked_unverified reconciliation
> **Files:** `src/agent/recurring.js`, `src/agent/scheduler.js`, `src/agent/courtAllocator.js`, `src/agent/fire.js`, `src/agent/monitor.js` (one-shot watches), `src/agent/jobs.js` (crons), `src/views/make_booking.ejs`, `src/views/recurring_detail.ejs`, `src/db/schema.sql`

This document describes the time-based booking logic end-to-end so the next session can pick it up. It's deliberately scenario-driven because the edge cases are where this code lives or dies.

## 1. Mental model

Koorora releases booking slots **exactly 7 days before the slot's start time, to the hour**. So:

- A 15 Jul 19:00 slot opens for booking at **8 Jul 19:00**.
- At 8 Jul 19:00, the agent POSTs to `tpcb_create_booking` with `date=2026-07-15`.
- The agent's recurring model says: "Every Wed 19:00" — so the schedule is 15 Jul, 22 Jul, 29 Jul, …
- Each fire happens at the **opening** (T-7d) of its target slot. Not at the slot time, not "today + 7d".

Three things the agent must compute:

1. **When to fire** — `next_fire_at` is the opening moment of the next slot we want to book.
2. **What to book** — `slot.date` and `slot.from`/`slot.to` (30-min slot range derived from `time`).
3. **Which court** — auto-allocate the first free court, or use the user's preference.

**v3.6 timing contract:** the POST goes out within ~50ms of the target time, not the 2-3s late it used to be. See §11 for the pre-staging design.

## 2. The data

### `recurring_bookings` row

| Column | What it stores | Notes |
|---|---|---|
| `day_of_week` | 0–6 (Sun–Sat) | The schedule's weekday |
| `time` | "HH:MM" Sydney | The schedule's start time |
| `duration_mins` | e.g. 60 | Slot length; end time = start + duration |
| `court_pref` | "4" / "5" / "6" / null | Preferred court; null = auto-allocate |
| `courts` | JSON array | Fallback order (always starts with `court_pref`) |
| `first_slot_date` | "YYYY-MM-DD" Sydney | The slot the user picked — the schedule anchor |
| `next_fire_at` | ISO 8601 UTC | When the next fire should happen |
| `last_fire_at` | ISO 8601 UTC | When the last fire happened |
| `last_status`, `last_msg`, `last_error_category` | last fire's result | |
| `first_occurrence_action` | "book_now" | Always book_now on first fire (slot is already in 7d window) |

### `bookings` row status values

| Status | Meaning | Set by |
|---|---|---|
| `confirmed` | Server confirmed AND `findBookingFor` returned the booking id | `fire.recordAndPersistScheduledFire` / `booker.book` |
| `booked_unverified` (v3.6) | Server confirmed ("booking has been made") but the immediate `findBookingFor` lookup didn't see the new row in the day schedule (server cache / eventual consistency). The 30s `reconcileUnverifiedBookings` cron will fill in `external_id` and flip to `confirmed`. The dashboard shows a "reconciling…" pill and disables Cancel until the id is known. | `fire.recordAndPersistScheduledFire` / `booker.book` |
| `cancelled` | Cancel POST succeeded | `booker.cancel` |
| `cancel-failed` | Cancel POST returned non-2xx | `booker.cancel` |
| `failed` | POST returned non-2xx or non-bookable error | `fire.recordAndPersistScheduledFire` / `booker.book` |

### Two kinds of "watches" (legacy vs v3.5)

| | Legacy `watches` table | `recurring_bookings` table |
|---|---|---|
| Schedule | Single date_from | Weekly via day_of_week + time |
| Chain | Manual — `fired_at` marks it done | Auto — every week forever |
| User intent | "Book this one slot" | "Book this every week" |
| Created via | `/api/watches` (POST without recurring toggle) | `/api/recurring` |
| Fires via | `monitor.runWatch` + `fire-due-watches` cron | `scheduler.schedule` (per-recurring timers) |

Both live in the same DB. The Make Booking form picks one based on the recurring toggle.

## 3. Fire-time computation

### 3.1 First fire (when the recurring is created)

```
firstFireUtc = sydneyWallToUtc(first_slot_date, time) - 7 days
if firstFireUtc <= now:
  # Opening has already passed (picked date is within 7 days).
  # Fall back to the picked date itself — the slot can still be
  # booked up to its start time.
  firstFireUtc = sydneyWallToUtc(first_slot_date, time)
```

**Why this matters:** if the user picks a date within 7 days, the opening moment has already passed, but the slot can still be booked (the booking window closes at the slot's start time). So we fire at the picked date itself and let the Koorora server accept or reject.

`firstFireUtc` is then stored as `next_fire_at` and the scheduler arms timers against it.

### 3.2 Chain (after each fire)

After a fire books slot T (date + time), the next slot is T+7d. Its opening is T. So:

```
nextFireUtc = slotUtc          # the just-booked slot's time, NOT + 7d
```

**Why this matters:** the OLD code did `slotUtc + 7d`, which set the next fire to the closing moment of the next slot — too late. The fire at 22 Jul 19:00 would try to book 22 Jul (the LAST moment to do so). The user observed this as "the booking agent went ahead and secured a time at 7pm on the 11th Saturday" when they picked 15 Jul: the chain was using the wrong date.

### 3.3 What slot does the fire book?

```
function slotForFire(rec, fireMs):
  if !rec.last_fire_at and rec.first_slot_date:
    return { date: rec.first_slot_date, from, to }    # first fire → picked slot
  else:
    return {
      date: sydneyDateString(fireMs + 7 days),       # subsequent → next slot
      from, to
    }
```

`last_fire_at` is set after the first fire (by `setLastResult`), so this correctly distinguishes the two cases.

## 4. Court auto-allocation

The user picks a court preference (or "any"). When the recurring is created, the allocator picks the court:

```js
allocateCourt(preferred, conflicts):
  if preferred is null/''/'any':   // "any" from the form
    return first ALLOWED_COURT not in conflicts
  if preferred not in ALLOWED_COURTS:
    return no_courts_available
  if preferred not in conflicts:
    return preferred
  return first ALLOWED_COURT not in conflicts  # auto-allocate alternative
```

`conflicts` is the set of `court_pref`s of all OTHER enabled recurrings on the same `(day_of_week, time)`. So if Wed 7pm already has a recurring on C4, a new Wed 7pm will be allocated to C5 (or C6, then `no_courts_available`).

If `no_courts_available`, the recurring is created anyway with `last_status='failed'` and `last_error_category='no_courts_available'`, surfaced as an error pill on the dashboard.

## 5. Scenarios

### Scenario 1: User picks 15 Jul 19:00 (outside 7d window)

- **Form submits** to `/api/recurring` with `day_of_week=3, time="19:00", first_slot_date="2026-07-15"`.
- **API**: allocator picks a free court. `firstFireUtc = 8 Jul 19:00 - 7d = 1 Jul 19:00? No — 15 Jul 19:00 - 7d = 8 Jul 19:00`. Future, so use it. `next_fire_at = 2026-07-08T09:00:00Z` (8 Jul 19:00 Sydney AEST).
- **Scheduler** arms `sessionCheckTimer` for T-5min-5min, `warmTimer` for T-5min, `fireTimer` for T+0.
- **At 8 Jul 19:00**, the fire runs. `slotForFire` sees `last_fire_at=null` and `first_slot_date="2026-07-15"`, so `slot.date = "2026-07-15"`. The agent POSTs `date=2026-07-15, from=38, to=40` and Koorora books it.
- **After fire**: `chainToNextWeek` runs. `slotUtc = 15 Jul 19:00`. `next_fire_at = 15 Jul 19:00`. `last_fire_at = 8 Jul 19:00:00.500Z`. `last_status = 'booked'`.
- **Next fire** at 15 Jul 19:00. `slotForFire` sees `last_fire_at` set, so `slot.date = sydneyDateString(15 Jul 19:00 + 7d) = "2026-07-22"`. Books 22 Jul 19:00.

### Scenario 2: User picks 4 Jul 19:00 (today, within 7d)

- **Form submits** to `/api/recurring` with `first_slot_date="2026-07-04"`.
- **API**: `firstFireUtc = 4 Jul 19:00 - 7d = 27 Jun 19:00`. That's in the past. Fall back: `firstFireUtc = 4 Jul 19:00`. `next_fire_at = 4 Jul 19:00`.
- **Scheduler** detects `delta <= 1000` if now is past 19:00, OR if now is before 19:00, `delta > 0`. Either way, the fire happens at 4 Jul 19:00.
- **At 4 Jul 19:00**, the fire runs. `slotForFire` uses `first_slot_date="2026-07-04"`. The agent POSTs `date=2026-07-04, from=38, to=40`. Koorora books it (slot is still in window).
- **After fire**: chain sets `next_fire_at = 4 Jul 19:00 + ... no wait, just slotUtc = 4 Jul 19:00`. Next slot is 11 Jul 19:00. Next fire at 4 Jul 19:00 — that's in the past now, so the rescan will pick it up.

### Scenario 3: User picks 5 Jul 19:00 (tomorrow, but it's already 8pm)

- `firstFireUtc = 5 Jul 19:00 - 7d = 28 Jun 19:00` → past. Fall back to `5 Jul 19:00`. Future. Fire at 5 Jul 19:00. Books 5 Jul.

### Scenario 4: User picks 15 Jul 19:00 but the slot is taken by a member

- Fire at 8 Jul 19:00 → POST to Koorora → returns 404 with body "Please reserve a different court. This one is already booked by a member."
- The categoriser in `fire.js` maps this to `last_status='failed', last_error_category='no_time_available'`.
- The chain STILL runs (it's based on the slot we tried to book, not whether it succeeded). `next_fire_at = 15 Jul 19:00` (the opening of 22 Jul).
- The recurring stays enabled. Next week, the agent tries again.

### Scenario 5: User picks a date that is "today" but the slot is taken

- Fire at today 19:00 → POST → `no_time_available`. Chain fires at today 19:00 + 7d = today 19:00 (a week later) for next week's slot.

## 6. The non-recurring (one-shot) flow

The Make Booking form has a "Make this a recurring weekly booking" checkbox. When UNCHECKED, the form submits to `/api/watches` (legacy path).

### How `/api/watches` decides

```
dateFrom = body.date_from
strategy = (dateFrom is within 7 days of today) ? 'watch' : 'scheduled'
```

- If `strategy='watch'` (within 7d): create the watch AND immediately call `monitor.runWatch` to attempt the booking. The watch is the one-shot record. The attempt result is returned.
- If `strategy='scheduled'` (>7d): create the watch. The `fire-due-watches` cron (every 1 minute) will pick it up when the date enters the 7-day window.

### Why a one-shot doesn't repeatedly schedule

When `monitor.runWatch` fires (success OR fail), it sets `watches.fired_at = now()`. The `fire-due-watches` cron filters:

```sql
SELECT * FROM watches WHERE enabled = 1 AND fired_at IS NULL
```

So a fired watch is never re-attempted. The user must create a new watch to retry.

### Edge case: a scheduled watch with date_from far in the future

The watch sits in the DB with `fired_at=null` and `strategy='scheduled'`. Every minute the cron checks: is `isWithinBookingWindow(date_from)` true? Once yes, it fires. After firing, `fired_at` is set and the watch is done.

## 7. Critical files

| File | What it does |
|---|---|
| `src/agent/recurring.js` | `add()`, `update()`, `chainToNextWeek()`, `bookNow()`. Owns the first-fire computation and the chain. |
| `src/agent/scheduler.js` | `slotForFire(rec, fireMs)`, `nextBookingTarget(rec)`, `schedule(recurringId)`. Per-recurring timer pool + `inFlight` set. |
| `src/agent/fire.js` | v3.6 — `fireScheduledFromContext`, `recordAndPersistScheduledFire`, `fireCourts`, `toApiCourts`, `stashFireContext`/`popFireContext`. The hot path. |
| `src/agent/warmup.js` | v3.6 — `prepareForFire(rec, fireMs)` builds and stashes the fire-ready context at T-leadMs. The OLD `warm()` is kept for the immediate path. |
| `src/agent/courtAllocator.js` | `allocateCourt`, `findConflictingCourts`, `resolveForRecurring`. Owns the "any" → specific-court logic. |
| `src/agent/monitor.js` | `runWatch` (legacy one-shot), `fireDueWatches`, `isWithinBookingWindow`, `pickTargetDate`, `reconcileUnverifiedBookings` (v3.6). The watch path + reconciliation. |
| `src/agent/jobs.js` | Crons: `fire-due-watches` (every 1 min), `reconcile` (v3.6, every 30s), `audit.prune` (daily 03:00), `backup.marker` (daily 02:30). |
| `src/db/schema.sql` | Table DDL. v3.6+: `bookings.status` accepts `booked_unverified`. |
| `src/views/make_booking.ejs` | The unified booking form. Recurring toggle decides /api/recurring vs /api/watches. |
| `src/views/recurring_detail.ejs` | Shows `next_fire_at`, `booking_target` (pre-computed by the route), `last result`, `booked_on_fallback` warning pill, `booking history`. |
| `src/views/bookings.ejs` | Confirmed bookings table. v3.6: `booked_unverified` is a distinct pill, Cancel is replaced with "reconciling…". |
| `src/views/recurring.ejs` | Recurring list. v3.6: shows `booked_on_fallback` warning pill. |
| `src/views/overview.ejs` | Dashboard landing. v3.6: shows `booked_on_fallback` warning pill on the upcoming list. |

## 8. Edge cases checklist

- [x] **Picked date is in the past** — form validation rejects.
- [x] **Picked date is today and time has already passed** — `firstFireUtc` falls back to the picked date's wall-clock time, which is in the past. The scheduler detects this and fires immediately (or marks the slot as missed on rescan). The Koorora API will reject the booking, so `last_status='failed', last_error_category='technical_error'`.
- [x] **All 3 courts are taken by other recurrings on the same slot** — `no_courts_available`, error pill on dashboard.
- [x] **Session expired at fire time** — `warmup.prepareForFire()` runs `ensureFreshSession` which spawns Playwright re-login (15-30s) at T-leadMs. The fire then proceeds. If re-login fails, `login_required` state and error banner.
- [x] **Koorora returns `no_time_available` mid-week** — `last_status='failed'`, recurring stays enabled, chain fires next week.
- [x] **User changes the schedule via PATCH** — `update()` re-anchors `next_fire_at` to the new day_of_week+time, and re-allocates court.
- [x] **Two accounts both have a recurring for Wed 7pm C4** — allocator puts one on C4 and the other on C5 (auto-allocates). Both fire concurrently. The multi-account smoke test verifies this.
- [x] **Recurring is disabled** — `clearTimers` removes all timers. `schedule` is a no-op. `fireDueWatches` skips `enabled=0` watches.
- [x] **Watch is enabled but `fired_at` is set** — `fireDueWatches` skips. The watch is effectively dead; user can delete it.
- [x] **System restart / container recreate** — `scheduler.start()` calls `rescanAll()` which walks all enabled recurrings. If `next_fire_at < now - 60s`, it writes a `skipped` event and re-anchors. For watches, `fire-due-watches` cron resumes on the next tick. Any stashed fire context is dropped (TTL = 6 min, so by the time a restart happens they're all stale). The fire path falls back to a fresh `prepareForFire` (with a `scheduler.fire.noContext.fallback` warning).
- [x] **DST boundary** — `time.js` uses `Intl.DateTimeFormat` with `timeZone: 'Australia/Sydney'`, which handles AEDT↔AEST transitions automatically. `sydneyWallToUtc` adjusts for the offset at the target time.
- [x] **Server says "booked" but day-schedule lookup misses (v3.6)** — booking recorded as `booked_unverified`. 30s reconciliation cron re-fetches the day schedule, fills `external_id`, flips to `confirmed`. If reconciliation never finds it, the user sees a "reconciling…" pill in the dashboard and Cancel is disabled (since we have no id to send to the server).
- [x] **Booking lands on a non-preferred court (v3.6)** — `fire.booked_on_fallback_court` warning logged with preferred and actual courts. Dashboard shows a "last booking on fallback court" pill on the recurring list, detail, and overview. This means another account (or an external human) took the preferred court between the warmup and the fire; the bot fell through to the next court in the fallback order.
- [x] **`rescanAll` runs while a fire is in progress (v3.6)** — `inFlight` set prevents the duplicate fire callback from running.

## 9. Tuning knobs (env vars)

| Env | Default | What |
|---|---|---|
| `LEAD_MINUTES_BEFORE_FIRE` | 5 | How long before the fire the warmup runs (T-5min). |
| `SESSION_CHECK_OFFSET_MINUTES` | 5 | How long before the warmup the session probe runs (T-5min-5min). |
| `AUDIT_RETENTION_DAYS` | 30 | Old audit rows pruned daily at 03:00. |
| `AUDIT_FULL_BODIES` | 0 | v3.6 — set to 1 to capture GET request/response bodies in `audit_log`. Default 0 (saves ~95% DB space). |
| `BACKUP_CRON` | `30 2 * * *` | Daily 02:30 hot backup marker. |

## 10. Known quirks (and why)

- **First fire for `nextWeekdayAt`** is always `book_now` because the picked date is 0–7 days out and Koorora's 7-day window guarantees the slot is bookable.
- **Chain fires at the slot's closing moment, not the opening**, if you set up the recurring the old way (`chainToNextWeek` doing `slotUtc + 7d`). The v3.4 fix uses just `slotUtc`.
- **`fire-due-watches` cron runs every minute** — fast enough that the system can react to a slot opening within a minute. The spec says "in production we need these tasks to happen within a minute to be functional."
- **Multi-account parallel firing (v3.6: 2-3 accounts tested)** — each recurring uses exactly one account, but multiple recurrings can fire at the same time. The court allocation at create time prevents two recurrings from claiming the same court, but the runtime fallback can still cause "stealing" if the preferred court is taken. The v3.6 `booked_on_fallback_court` warning surfaces this in the dashboard.
- **`watches.fired_at` is set even on failure** — so a doomed slot (e.g. wrong date, session dead) doesn't get retried indefinitely. User must create a new watch.
- **Fire-context TTL is 6 minutes** — longer than the max `LEAD_MINUTES_BEFORE_FIRE + 1`, so a normally-armed warmup will still be valid at fire time. If the context is stale (e.g., a reschedule changed the slot), the fire path falls back to a fresh `prepareForFire` (with a `scheduler.fire.noContext.fallback` warning).
- **30s reconciliation can be too slow for a user clicking Cancel** — the `reconciling…` pill is shown until the next 30s tick. If the user really needs to cancel a stuck `booked_unverified`, they can wait up to 30s. In practice, reconciliation usually finds the booking on the first try because the day-schedule cache flushes within seconds.

## 11. v3.6 timing fix — why pre-stage at T-leadMs

Before v3.6, the fire callback at T did:
1. `prepareForFire` — calls `warmup.warm`, which calls `ensureFreshSession` → HTTP probe, possibly Playwright relogin
2. `await waitUntilExact(fireMs)` — no-op (fireMs already past)
3. `repo.accounts.get` — DB read
4. `new KoorooClient` — sync
5. `client.hydrateFromSession` — DB read
6. `fireScheduled` → `fireCourts` → `postCreate` — the actual POST

Steps 1-5 took 100ms-2s in production, making the actual POST land 2-3s after the target time. Other members firing on the hour would beat us to the slot.

v3.6 moves steps 1-5 to a `warmTimer` at T-leadMs, which stashes a fire-ready context in a `Map<recurringId, ctx>`. The fire callback at T just:
1. `popFireContext(rec.id)` — Map.get, sub-ms
2. `await waitUntilExact(fireMs)` — sub-ms if target is now
3. `tryCreateBooking` via `client.createBooking` — the actual POST

The pre-stage does all the slow work at T-leadMs (5 min before the fire, by default), where there's plenty of time. The fire callback at T is just `setTimeout(POST)`.

A regression test (`v3.6: executeScheduledBooking — regression guard, prepareForFire NOT called when context is stashed`) verifies that `prepareForFire` is NOT called in the fire path when a context is stashed. If anyone re-introduces async setup work in the hot path, this test fails.

## 12. How to debug

1. **Recurring didn't fire**: `GET /api/recurring/:id` — check `next_fire_at`, `last_status`, `last_msg`. Then `GET /api/scheduler/status` — are timers armed?
2. **Recurring fired but didn't book**: `GET /api/recurring/:id/fire-events` — what was the response? Check `status` and `error`.
3. **Recurring fired late**: compare `scheduled_at` to `fired_at` in `fire_events`. The v3.6 fix should keep this < 50ms. If you see > 1s, the warmup didn't pre-stage the context (look for `scheduler.fire.noContext.fallback` in the logs).
4. **Booking confirmed in our DB but the user can't see it on the website**: check `bookings.status`. If `booked_unverified`, the 30s reconciliation cron is in flight. If it's been hours, the day-schedule lookup is failing — check the `fire_events.response_body` for that booking.
5. **One-shot watch stuck**: `GET /api/watches` — find it. If `fired_at` is null and `date_from` is within 7 days, the next `fire-due-watches` tick (within 1 min) will fire it.
6. **Court auto-alloc conflict**: `GET /api/recurring` with the same day_of_week + time — see if all 3 courts are taken.
7. **Session expired**: `GET /api/accounts/:id/state` — if `login_required`, click "Re-login" on the Accounts page (this runs Playwright in the container).
8. **Cancel refuses with 409**: the booking has `external_id = null` (status = `booked_unverified` or `failed`). Wait for reconciliation, or check the audit log to see why `external_id` was never filled.

## 13. What to do when adding new behavior

- **New scheduled recurring trigger?** Add a cron in `jobs.js`. Use the existing `recurring.schedule(id)` to arm timers.
- **New booking action type?** Add it to `fire.categorise()`. Make sure the chain handles the new status (don't break on unknown).
- **Change the 7-day window?** It's hardcoded in `monitor.isWithinBookingWindow`. Search for `7 *` and `7 days` — every assumption lives there.
- **Change "any" court semantics?** Update `courtAllocator.allocateCourt` AND the make_booking form's help text. The form sends `null` for "any" — keep that contract.
- **Change the fire-path timing contract?** Don't. The regression test (`v3.6: executeScheduledBooking — regression guard`) will catch any regression. The 50ms budget is enforced by the test.
