# Repository overview

`calendar-peering-gas` is a Google Apps Script (GAS) project that "peers"
two Google Calendars — Work and Life — syncing events in both directions
with privacy masking (Life→Work events always appear under a mask title
such as 「休暇」). The entire application is a single file, `Code.js`,
running on the GAS V8 runtime with the script timezone pinned to
`Asia/Tokyo` (`appsscript.json`). It is deployed by pasting into the GAS
editor or via `clasp push`, and driven by a time-based trigger calling
`main()`.

There is no `package.json` and no npm dependency; the code uses only
built-in GAS services (`CalendarApp`, `PropertiesService`, `UrlFetchApp`,
`Utilities`). All configuration comes from Script Properties, read in
`loadConfig()`.

See `CLAUDE.md` (written in Japanese) for the authoritative architecture,
function inventory, and Script Property reference — read it before
reviewing changes to `Code.js`.

# Build & validate

There is **no CI in this repository** (no `.github/workflows/`), no linter,
no formatter, and no automated test framework. Verification is manual, as
documented in `CLAUDE.md`:

- set the `DRY_RUN=true` Script Property and run `main()` — logs the
  planned creates/updates/deletes without applying anything;
- `testAccess()` — confirms the script can resolve both calendar IDs;
- `setupProperties()` — seeds default Script Property slots.

The only machine check available locally is a syntax parse
(`node --check Code.js`); GAS globals such as `CalendarApp` resolve only at
runtime inside Google's environment. Review comments therefore cannot ask
for "add a unit test for this" — there is no test harness — and correctness
arguments have to come from reading the code.

# What to focus review on in this repo

## 1. `DRY_RUN` must gate every mutation

Every mutating call today — `deleteEvent()` in the duplicate-cleanup,
update, and orphan-delete paths, both `createTargetEvent()` call sites, and
the webhook sends in `sendNotifications()` — is guarded by
`CONFIG.DRY_RUN`. README tells users to do their first run with
`DRY_RUN=true`, so an unguarded mutation is a broken contract, not a style
issue. Flag any new or moved code path that creates, updates, or deletes a
calendar event (or posts to a webhook) without the DRY_RUN check.

## 2. The three tracking tags and the delete phase are the sync contract

Synced events are tracked with the tags `origin_id`, `origin_updated`, and
`source_calendar_id` (set in `createTargetEvent()`), not via description
text. Renaming, removing, or reformatting these breaks reconciliation with
events already sitting on users' calendars. Specific load-bearing lines in
`syncDirection()`:

- `if (sEvent.getTag('origin_id')) return;` — the loop breaker. Both sync
  directions run in the same `main()` pass; without this skip, events the
  tool itself created would ping-pong between the two calendars.
- `targetMap` only admits events whose `origin_id` is set **and** whose
  `source_calendar_id` tag equals the current `sourceId`. That filter is
  the only thing keeping the delete phase away from user-created events and
  from events synced in the other direction. Widening it can delete real
  appointments.
- `delete targetMap[originId]` inside the upsert loop — whatever remains in
  `targetMap` afterwards is deleted as an orphan. A refactor that drops
  that line deletes every synced event on every run.
- Change detection compares the stored `origin_updated` tag against
  `sEvent.getLastUpdated().toISOString()` as strings; changing the format
  on one side breaks update detection for every already-synced event.

## 3. Masking is a privacy boundary, and log lines leave the account

Life→Work sync is **always** masked (`mask: true` is hardcoded in
`main()`); Work→Life masking is optional (`MASK_WORK_TO_LIFE`). This
asymmetry is a documented design decision (CLAUDE.md 設計方針), not an
inconsistency to "fix". `LOG_BUFFER` lines are forwarded verbatim to
Discord and Google Chat webhooks by `sendNotifications()`, so every
`recordLog()` on a masked path deliberately logs `targetTitle` (the mask),
never the source title. Flag a diff that:

- logs `sTitle`, the source description, or guest data on a masked path;
- makes `createTargetEvent()` copy source fields (description, location,
  guests) into the target event — today it sets only a fixed description
  plus the three tags;
- makes Life→Work masking optional or defaults it off.

## 4. Secrets: webhook URLs and clasp credentials

`DISCORD_WEBHOOK_URL` and `GOOGLE_CHAT_WEBHOOK_URL` are capability URLs —
anyone holding one can post to the channel. They live in Script Properties
only. Flag any diff that hardcodes one, prints one, or includes one in a
notification payload. `.clasp.json` / `.clasprc.json` are gitignored on
purpose (clasp credentials and the script ID, per CLAUDE.md); flag any diff
that starts tracking them.

## 5. GAS platform constraints, timezone, and quota

- No `import`/`export`/`require`, no npm modules: `appsscript.json`
  declares no dependencies and GAS loads `Code.js` as one global-scope
  script. Don't suggest module systems, bundlers, or external libraries.
- Date logic must stay pinned to `Asia/Tokyo`: the off-hours check reads
  the event hour via `Utilities.formatDate(sStart, 'Asia/Tokyo', 'H')`
  rather than `Date.prototype.getHours()`. Keep new date/time logic on the
  same pattern.
- `checkHolidayOrWeekend()` caches per-day results in `HOLIDAY_CACHE`
  because it runs once per source event and each cache miss costs
  `getEventsForDay()` calls that count against GAS quotas. Flag new
  per-event `CalendarApp` calls inside the `sourceEvents` loop that could
  be cached or hoisted the same way.
- All-day handling in `createTargetEvent()` is deliberately fiddly: a
  start→end delta greater than `86400000` ms selects the multi-day
  `createAllDayEvent(title, start, end)` overload, otherwise the single-day
  one. Changes here need a `DRY_RUN` transcript in the PR description, not
  just a plausible-looking diff.

## 6. A new Script Property must land in four places

`loadConfig()` (parse + default), `setupProperties()` (default slot), the
README.md option table, and the CLAUDE.md property table — flag a diff that
touches some but not all of them. This has actually drifted before (README
vs `loadConfig()` defaults for `SYNC_KEYWORDS_TO_LIFE`). Numeric properties
additionally get range validation in `loadConfig()` —
`WORK_START_HOUR`/`WORK_END_HOUR` throw on out-of-range values; a new
numeric property should follow that pattern rather than silently producing
`NaN`.

# Out of scope for review comments

- Style/formatting nits: there is no linter or formatter in this repo;
  don't hold it to an ESLint/Prettier standard it hasn't opted into.
- "Add unit tests / add CI": there is no test framework or workflow here;
  manual `DRY_RUN` verification is the documented process. Introducing a
  test harness is a project decision, not a per-PR review comment.
- Japanese-language comments, log messages, error strings, and README —
  that is the repository convention (CLAUDE.md コーディング規約); don't ask
  for translations.
- The `let`-declared globals at the top of `Code.js` (`CONFIG`,
  `LOG_BUFFER`, `HOLIDAY_CAL`, `WORK_CAL`, `HOLIDAY_CACHE`): GAS has no
  module system, and per-execution globals are the established pattern
  here.
- The hardcoded Japanese national-holiday calendar ID
  (`ja.japanese#holiday@group.v.calendar.google.com`) — documented in
  CLAUDE.md as Japan-only by design.
- Emoji in log strings (✨/🔄/🗑️/🧹) — they are the user-facing Discord /
  Google Chat report format, not debug noise.
- `console.log` usage — this is GAS's standard logging (surfaced in the
  Apps Script execution log; `appsscript.json` sets `exceptionLogging:
  STACKDRIVER`), not a protocol channel.

