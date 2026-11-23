# Backend Contracts For The New GUI

Proposed API additions and clarifications needed by [gui-concept.html](gui-concept.html) and [USER_STORIES.md](USER_STORIES.md). Nothing here is implemented. Each entry names the stories it unblocks. Existing endpoints (`/api/status`, `/api/planner/*`, `/api/schedule`, `/api/sessions`, `/api/messages`, `/api/winter/*`, `/api/command/*`) are kept; contracts below extend them additively so the current UI keeps working.

Conventions: timestamps are ISO 8601 with offset; durations are seconds unless the field name says otherwise; unknown values are `null`, never `0`.

## C-01 Status vocabulary

Three independent enums, so the UI never derives a label from free text.

| Field | Values |
| --- | --- |
| `activity` | `parked`, `mowing`, `charging`, `paused`, `returning`, `error`, `unknown` |
| `planner.state` | `idle`, `running`, `ok`, `zero_sessions`, `failed`, `invalid_setup`, `winter` |
| `planner.inhibit` | `null`, `paused_by_user`, `parked_until_resumed`, `parked_until`, `weather_hold`, `winter` |

Rules: `activity=paused` means stopped in place in the garden, never "parked". `planner.inhibit` is separate from `activity` so a paused planner is distinguishable from a paused mower. `zero_sessions` is a successful run with no suitable session; `invalid_setup` covers missing location or window.

Unblocks: US-03, US-07, US-08.

## C-02 Structured decision codes per day

`GET /api/planner/status` returns, per day, a machine code plus the numbers behind it, instead of only a text reason.

```json
{
  "date": "2026-11-18",
  "decision": "cold",
  "sessions": [],
  "detail": { "temp_c": 1.2, "min_temp_c": 5.0 }
}
```

Codes: `session`, `done`, `cold`, `rain`, `interval`, `growth`, `no_window`, `firmware`, `none`. Mapping from existing `plan_schedule` status codes: `weather` to `cold` or `rain` (split by cause), `past_window` and `short_window` to `no_window`; `hedgehog`, `dew`, `heat_stress` are kept and labeled in the UI (not in the concept's sample data). `growth` and `interval` are new and need the planner to emit them when a day is skipped for those reasons.

`detail` carries the measured value and threshold used (US-07, US-09, US-17). `done` marks completed sessions so they are not counted as upcoming.

Unblocks: US-07, US-09, US-17.

## C-03 Data freshness

Every status-like response gains:

```json
{ "fetched_at": "2026-11-16T09:41:07+01:00", "source": "live|cached|demo", "age_s": 4 }
```

`source=demo` drives the persistent demo label (US-15). Separate `fetched_at` for weather (`/api/planner/forecast`) and mower (`/api/status`). The UI marks data as stale when `age_s` exceeds a threshold it owns (proposed 120 s for mower, 3 h for weather).

Unblocks: US-02, US-03, US-09, US-15.

## C-04 Command lifecycle

Sent, accepted and observed are separate. Commands return immediately with an id; the UI polls or subscribes.

`POST /api/command/{mow|pause|resume|park|park_home|park_duration}` responds `202`:

```json
{ "command_id": "c-8f3a", "state": "sent" }
```

`GET /api/commands/{command_id}`:

```json
{
  "command_id": "c-8f3a", "command": "park_home",
  "state": "sent|accepted|observed|failed|timed_out",
  "sent_at": "...", "accepted_at": "...", "observed_at": null,
  "expected": { "activity": "parked" },
  "error": null
}
```

`observed` is set only when `/api/status` shows `expected`. Proposed observation timeout 120 s, after which `timed_out` (not `failed`). Repeated submissions of the same command while one is pending return the pending `command_id` (idempotent), which satisfies the duplicate-click rule.

Unblocks: US-03, US-04, US-05.

## C-05 Calendar backup and restore

Required for the Smart to Classic transition (US-06). Replaces any frontend-only warning.

- `POST /api/schedule/backup` reads the firmware calendar and stores it with a timestamp. Returns `{ "backup_id", "taken_at", "task_count" }`. Called by the server automatically before the first Smart write; the explicit route exists for the UI's visible "backup" step.
- `GET /api/schedule/backup` returns the latest backup, or `404` if none.
- `POST /api/schedule/restore` with `{ "backup_id" }` writes it back and reads the calendar again to verify. Returns `{ "verified": true|false, "task_count" }`.
- `GET /api/schedule` gains `"owner": "smart|classic"` and `"placeholder": true|false` so the UI can never present a placeholder as a restored calendar.

Mode switch is exposed as steps the UI can name when one fails: `backup`, `stop` (clear active planner session), `write`, `verify`. A failed step returns `{ "failed_step": "write", "recoverable": true, "backup_id": "..." }`.

Decision (Nov 2026): assume the firmware accepts a full calendar overwrite while mowing. This is untested; verify on hardware in spring 2027, after the winter pause. If the firmware rejects it, the `write` step must wait until the mower is docked or the active session is stopped first, and the UI must name that step when it fails.

Unblocks: US-06.

## C-06 Command and planner event records

`GET /api/events?since=&limit=&source=command|planner|mower` returns bounded history:

```json
{ "items": [ { "ts": "...", "source": "command", "kind": "park_home", "result": "observed", "detail": "..." } ], "next": "cursor|null" }
```

PINs and device addresses are never included. If history is not persisted, return `{ "supported": false }`; the UI then hides the Events tab rather than showing an empty list (US-11).

Unblocks: US-11, US-16.

## C-07 Capability metadata

`GET /api/capabilities`:

```json
{
  "commands": ["mow", "pause", "resume", "park", "park_home", "park_duration"],
  "max_manual_duration_min": 720
}
```

Decision (Nov 2026): no cutting-height control. The BLE library has no model-to-feature map, so support cannot be checked per model, and `web_app.py` has no route for it. The concept shows none. Revisit only if the library gains such a map.

Unblocks: US-12.

## C-08 Duration limits

Current validation is only `> 0` (for example `/api/runtime_estimate`). Proposed: 15 to 720 minutes for manual mow and park-duration, returned in C-07 and enforced with `422` and `{ "field": "duration_hours", "min": 0.25, "max": 12 }`. The concept uses these numbers. Confirmed for now (Nov 2026); the firmware may impose its own limit, which should replace these values if found.

Unblocks: US-04, US-12.

## C-09 Mowing versus elapsed duration

Session records (`/api/sessions`, `/api/sessions/{id}`) expose:

```json
{ "mowing_s": 5400, "charging_s": 2700, "searching_s": 300, "elapsed_s": 8400,
  "segments": [ { "kind": "mowing|charging|searching", "start": "...", "end": "..." } ] }
```

with `elapsed_s = mowing_s + charging_s + searching_s` computed on the server from segments, so list, detail and timeline agree by construction. Also `record_state`: `live|complete|incomplete|imported`, and `end_reason`.

Findings from reading the current code (not yet reproduced on live data; both local `automower.db` files hold only imported `legacy` sessions, where elapsed equals mowing by construction). Deferred to spring 2027, when the mower runs again; `deploy/automower.db` is a port of `planned_sessions.json`, not a recording:

- Two meanings of "duration" coexist. Wall-clock windows (plan `duration_sec`, manual `duration_hours`, estimator `duration_hours`) include charging; the planner converts a mowing target into a window in `planner.py` (charge-cycle math). Cutting time (`session.mow_sec`, the daily target, `get_mow_sec_today`) excludes charging. The UI must name which one it shows.
- `store.py` keeps `mow_sec`, `charge_sec` and `search_sec` as per-tick rollups and derives `elapsed_min` from `ended_ts - started_ts` in `web_app.py` (`_session_summary`). There are no stored segments, so the two can drift:
  1. `close_session` ends the session at `last_mow_ts`, but `charge_sec` and `search_sec` keep growing until the 90-minute idle close. The sum can exceed elapsed.
  2. `mow_sec` credit per tick is clamped to twice the sample interval, so a BLE gap lands in no bucket. Elapsed can exceed the sum.
  3. GPS-opened sessions credit mowing from fixes (30 s cap) and record no charging or searching.
  4. A session that crosses midnight is attributed entirely to its start date.
- The estimator timeline (`templates/index.html`, `Build alternating mow/charge segments`) is synthetic. With `source=statistics` the projection's cycle includes searching time, but the timeline alternates only mowing and charging, so the bar and the projected mowing hours can disagree.

Next step: pick a few real recorded sessions (source `sampler`) and compare `elapsed` with the sum of the three buckets. If the cause is 1 or 2, store segments at record time (the shape above); if it is the estimator timeline, derive the bar from the projection's own numbers.

Unblocks: US-02, US-11.

## C-10 Daily target: fixed versus adaptive

The planner config already has an adaptive flag. The status payload makes the active rule explicit so the UI never mixes the two:

```json
"daily_target": {
  "mode": "fixed|adaptive",
  "target_s": 5400,
  "growth": { "owed_s": 7200, "threshold_s": 8280, "informational": true }
}
```

- `fixed`: `target_s` is the user's configured value; `growth` is informational only.
- `adaptive`: the growth estimator replaces the target. `owed_s` is compared with `threshold_s` and `target_s` is derived from it.

Unblocks: US-07, US-09.

## C-11 Watchdog states

`GET /api/watchdog/status` returns `state`: `disabled`, `monitoring`, `weather_hold`, `drying_delay`, `unavailable`, plus `last_check` and `next_action_at` (null if unknown).

Decision (Nov 2026): keep the current behaviour, with no Classic-specific setting. `WeatherWatchdog` in `planner.py` runs whenever `watchdog_enabled` is on, in Smart and Classic mode alike. It parks with `mower_park_home()` (HOME mode) so the calendar cannot restart the mower in bad weather. When the weather clears and `watchdog_dry_delay_minutes` has passed, Smart mode re-issues the remaining session window, and Classic mode calls `mower_resume()`, which returns to the firmware calendar. In Classic mode that restarts mowing only if a calendar window is open at that moment; no make-up session exists. Both modes therefore use the same states (`weather_hold`, `drying_delay`). Add `"mode": "smart|classic"` to the status payload so the UI can word the outcome correctly.

Unblocks: US-09.

## C-12 Decisions and open items

| ID | Item | Status |
| --- | --- | --- |
| C-05 | Firmware accepts full calendar overwrite during mowing | Assumed yes; hardware test in spring 2027 |
| C-07 | Cutting-height control | Dropped |
| C-08 | Duration limits 15 to 720 min | Confirmed for now; firmware limit unchecked |
| C-09 | Source of session-duration discrepancy | Deferred to spring 2027: needs sessions recorded by a running mower |
| C-11 | Watchdog in Classic mode | Decided: keep current behaviour (park, then back to the calendar); no backend change |
