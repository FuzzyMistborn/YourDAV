# AGENTS.md

Monorepo: `shared` (types) / `server` (Fastify API) / `client` (Vue 3 SPA),
npm workspaces. Package/workspace names are `yourdav` / `@yourdav/*`. YourDAV
is a calendar (CalDAV) and contacts (CardDAV) client in one app, formerly two
projects (YourCal and YourContacts). The DAV server is the sole identity
provider — no local user store.

Verification discipline throughout: features are driven against a real
CalDAV server with curl, not just typechecked. Automated tests
(`server/src/**/*.test.ts`, `npm test` / vitest, run in CI) cover the
mapper, recurrence, edit scopes, import/export, bounds, SSRF, privileges,
the SQLite store, and route handlers — but they don't exercise the CalDAV
server's own RRULE/ETag validation, which is still only checked by hand.

## Open items

- **Conflict-handling UX** — built for event edit/delete (`ConflictDialog`) and,
  as of 2026-10, contact edit/delete: a 412 reloads the book and offers
  "Discard my changes" / "Reapply my changes" (or "Delete anyway") against the
  fresh etag, last-write-wins, no field-level merge. A card deleted elsewhere
  also lands there ("deleted elsewhere", OK only): `DavContactStore.getCard`
  throws `ContactNotFoundError` (confirmed with a `HEAD` -- tsdav only says
  "incomplete response"), the PUT route turns it into a 412, and
  `deleteCard` treats a 404 as already done. Browser-tested against Baikal by
  editing the card behind the open editor. **Not covered**: contact
  move/copy, batch group/delete and merge still just show the 412 message
  ("Reload and try again") and leave the stale etag cached until the next
  reload; event drag/resize conflicts reuse the calendar dialog but only the
  edit-dialog path was driven in a browser.
- **`GET /api/calendars/:id/sync`** — `DavCalendarStore.syncCalendar()` is
  implemented but no route exposes it and it's never been tested against a
  real server.
- **VTODO/task list UI** — deliberately out of scope. `Calendar.supportsTasks`
  is discovered and plumbed through the store layer but has no UI and should
  stay that way. Attendees/attachments are also out of scope.
- **Baikal coverage** — done for share management and recurrence/timezone
  (see "Verified against Baikal 0.11.1: sharing and recurrence"). Still
  untested on Baikal: `EXDATE`s written by *other* clients, and the cache-on
  (SQLite sync) path.
- **Calendar UI browser coverage** — dark mode on every calendar view and the
  event edit dialog have been driven in a browser. Not yet exercised in one:
  the undo toast, duplicate / copy-paste, the print view, agenda / year views
  and the mini-month, drag/resize paths beyond the edit dialog, the "+more"
  popover, and the FullCalendar v7 views in both themes.
- **Contacts UI** is driven in headless Chromium for login, the combined view,
  create/delete, group rename, selection, move/copy, batch group/delete,
  merge and the CardDAV URL panel (see "Browser testing"), and at the
  API level against Radicale and Baikal (Basic and Digest). Also driven
  (2026-10, against Baikal): the photo file picker (set, saved as `PHOTO`,
  removed on re-edit), `.vcf` import (2 cards) and Export (browser download),
  the edit form beyond create (prefill, nickname/org/birthday edits, the
  bad-date guard disabling Save, raw card checked afterwards), the
  address-format setting (US <-> International in both detail and form), dark
  mode, and nav between the two halves. Still untested: a CalDAV-only server
  (the `hasContacts: false` path is unit-tested only). Cosmetic: "Import
  .vcf" wraps to two lines in the narrow sidebar; the emoji icons render as
  boxes only because the headless browser has no emoji font.
- **Contacts: address-book sharing, address-book rename, and automatic
  duplicate detection** are out of scope; create/delete exist, and merging
  is manual (tick exactly two contacts).
- **Docker** image is unbuilt/unrun (no Docker on this host) — see
  "Docker packaging".

## Toolchain pins

**`typescript` is pinned to `^7.0.2`** (dependabot PR #9). Two parts of the
toolchain didn't support TS7:

- **Lint is Oxlint, not ESLint.** typescript-eslint can't load on TS7 (it
  needs the JS API TS 7.0 doesn't have; targeting TS 7.1). `npm run lint` is
  `oxlint --type-aware`, configured in `.oxlintrc.json` (typescript/unicorn/
  oxc/vue plugins, `correctness` category as errors). Type-aware rules run
  through `oxlint-tsgolint`, which is built on typescript-go, so it works on
  TS7. Covers `.ts` and the `<script>` blocks of `.vue` files -- **not** Vue
  template rules. CI runs it before build. The script builds `shared` first:
  its types resolve from `shared/dist`, and without them type-aware rules see
  `error` types and fail. `npm ci` doesn't need `--legacy-peer-deps`.
- **`vue-tsc`** hard-crashes on TS7 (`ERR_PACKAGE_PATH_NOT_EXPORTED` for
  `./lib/tsc`): TS 7.0 ships **no JS API**, and vue-tsc drives the JS
  compiler. Workaround: `client`'s `typescript` devDependency is aliased to
  `npm:typescript@~6.0.3` (nested under `client/node_modules`; the root/server
  TS7 stays hoisted), and `client/scripts/vue-tsc.cjs` calls `vue-tsc`'s
  `run()` with an explicit path to that TS6 `tsc` -- a bare `vue-tsc` is
  hoisted to the root and would resolve TS7 (npm `overrides` can't redirect
  it: `typescript` is a *peer* of vue-tsc). `client`'s `build` is
  `typecheck && vite build`, so CI type-checks the client. Vite never uses
  `tsc`, so TS6 only affects type-checking.

**Revisit** when vue-tsc ships TS7 support (tracked in
[vuejs/language-tools#6170](https://github.com/vuejs/language-tools/pull/6170)):
drop the alias and the wrapper script, and go back to plain `vue-tsc -b`.

**FullCalendar is on v7** (`@fullcalendar/vue3@^7.1.2` + its required
`temporal-polyfill` peer). v7 folded the plugins into the framework
package -- `@fullcalendar/vue3/{daygrid,timegrid,interaction,list,multimonth}`
-- so the standalone `@fullcalendar/daygrid` etc. are no longer dependencies.

- Callback types are renamed `*Arg` -> `*Info` and imported from
  `@fullcalendar/vue3`.
- v7 injects no CSS: `CalendarView.vue` imports `skeleton.css` plus the
  classic theme's `theme.css`/`palette.css` and registers
  `classicThemePlugin`.
- Rendered class names are hashed atomics, so `.fc-button` and friends are
  gone. Overrides hang off our own classes attached via `*Class` options
  (`buttonClass`, `dayCellTopInnerClass`, ...; v7 joins them with the
  theme's), and the `--fc-classic-*` palette is remapped onto the app's
  tokens under `:root:root` so dark mode follows `<html data-theme>`
  without FullCalendar's own `colorScheme` option.

## Dev CalDAV servers (no Docker on this host)

Both `.dev-radicale/` and `.dev-baikal/` are git-untracked scratch state.

### Radicale (3.7.7)

```
python3 -m venv .dev-radicale/venv
.dev-radicale/venv/bin/pip install radicale bcrypt
.dev-radicale/venv/bin/python -m radicale --config .dev-radicale/config/config
```

Binds `127.0.0.1:5232`, serves DAV at the root. htpasswd auth
(`.dev-radicale/config/users`), filesystem storage under
`.dev-radicale/data/`. A calendar must be created per user with a raw
`MKCALENDAR` (Radicale doesn't auto-create one).

Sharing config (git-untracked): a `[rights]` section (custom `from_file`
rights reimplementing `owner_only` for every user) and a `[sharing]` section
(`type = files`, `collection_by_map = true`, `permit_create_map = true`, db
under `.dev-radicale/data/collection-db/`). Users: `testuser`/`testuser`,
`shareduser`/`shareduser`.

Reusable fixtures — two fully-accepted map shares from `testuser` to
`shareduser`: Personal at `/shareduser/testuser-personal/`, Work at
`/shareduser/testuser-work-pending/` (the `-pending` is a stale label). Both
`Permissions: "rw"`. If sharing/rights behavior looks wrong, check
`.dev-radicale/config/rights` and `[sharing]` first.

### Baikal (0.11.1)

Needs PHP with `mbstring`, `xml`/`dom`/`simplexml`, `pdo_sqlite` (PHP 8.3 here
has all of them). Baikal is installed and configured under
`.dev-baikal/baikal/` -- just start it (it isn't left running):

```
php -S 127.0.0.1:8080 -t .dev-baikal/baikal/html
```

CalDAV base URL for the login form: `http://127.0.0.1:8080/dav.php` (Baikal
serves DAV under `/dav.php`, not the root). Users `testuser`/`testuser` and
`shareduser`/`shareduser` (email `shareduser@example.com`) exist; admin is
`admin`/`bAikalAdmin1!`. Baikal auto-creates one calendar per user.

`dav_auth_type` defaults to `Basic`; flip it to `Digest` in
`.dev-baikal/baikal/config/baikal.yaml` and restart `php -S` to test Digest
(both users have a stored `users.digesta1` hash). The `php -S` access log
prints one `[status]: METHOD /path` line per request, which is the easiest way
to count round trips / 401s. No `sqlite3` CLI on this host -- use Python's
`sqlite3` module.

Install from scratch (only if `.dev-baikal/` is gone):

```
curl -sL -o .dev-baikal/baikal.zip \
  https://github.com/sabre-io/Baikal/releases/download/0.11.1/baikal-0.11.1.zip
unzip -q .dev-baikal/baikal.zip -d .dev-baikal && rm .dev-baikal/baikal.zip
```

`vendor/` ships prebuilt (no `composer install`). First run needs the
install wizard at `/admin/install/` — a multi-step form, scriptable via
curl (grab `PHPSESSID` + `CSRF_TOKEN` from each GET, POST each step).
**Gotcha**: the wizard's hidden `refreshed` field must stay `0` on a real
submit; `refreshed=1` silently re-renders the empty form instead of
persisting. Config lands in `.dev-baikal/baikal/config/baikal.yaml`, db in
`.dev-baikal/baikal/Specific/db/db.sqlite`. Users are created via
`/admin/?/users/new/1/` (same CSRF pattern). `baikal.yaml`'s `sqlite_file` is
an absolute path and goes stale if the checkout directory is renamed (Baikal
then answers "DB folder not writable").

## API notes: tsdav / ical.js (non-obvious, from `dist/*.d.ts`)

- **`createDAVClient(...)`** (the standalone fn) returns an anonymous
  object type, not the `DAVClient` class. We use `new DAVClient({...});
  await client.login()` (`server/src/dav/client.ts`) because the class
  exposes `.account` after login, which proves the credentials are valid.
- **`client.smartCollectionSync({ detailedResult: true })`** nests the
  arrays under `.objects` (`{ ...collection, objects: { created, updated,
  deleted } }`), not top-level.
- **`smartCollectionSync({ method: 'webdav' })`** throws unless you pass
  `collection.objectMultiGet` — sync-collection REPORT only returns changed
  hrefs+etags, not bodies. Use `objectMultiGet: client.calendarMultiGet.bind(client)`.
- **`ICAL.Event.getOccurrenceDetails(time)`** → `{ item, startDate,
  endDate, recurrenceId }`. Always use the returned `startDate`/`endDate`,
  never `item.startDate` — `item` is the master for non-exception
  occurrences, so `item.startDate` is the *series* start. Easiest mistake
  to reintroduce in `recurrence.ts`.
- Override wiring for expansion: `event.relateException(overrideVevent)`
  per non-master VEVENT sharing a UID, before `.iterator()` /
  `.getOccurrenceDetails()`.
- **`ICAL.Recur.until`** is a plain writable property (`Time | null`), and
  setting it requires also clearing `.count` (no COUNT+UNTIL together). See
  `editScope.ts`'s `truncateRrule()`.
- **ical.js accessors return live references, not snapshots.**
  `getFirstPropertyValue('rrule')` hands back the master's actual `Recur`
  instance — `.clone()` it before mutating anything you also read
  elsewhere in the same function.
- **`updatePropertyWithValue('rrule', string)` silently corrupts the
  value** — ical.js iterates the string char-by-char
  (`RRULE:0=F;1=R;...`). Always `ICAL.Recur.fromString(...)` first. RDATE
  is the same trap: pass a real `ICAL.Time`, never a string. VALARM
  `TRIGGER` is the *exception* — a raw `-PT15M` string round-trips fine as
  an `ICAL.Duration`.
- **`ICAL.Time` zone reassignment**: setting `.zone` relabels without
  converting (14:00 UTC "becomes" 14:00 local). Use `.convertToZone(zone)`.
  For all-day values, build with `ICAL.Time.fromDateString(...)` — no
  JS-Date/timezone round trip.
- **`addPropertyWithValue` doesn't derive `TZID` from the value's zone** —
  only the `startDate`/`endDate` setters do. A zoned `RDATE` was once written
  floating because of this; `buildVeventComponent` now sets the `tzid`
  parameter itself.

## Architecture reminders

- **`CalendarStore`** (`server/src/store/CalendarStore.ts`) is the seam a
  cache/mirror slots into. It includes `getRawObject()` because recurring
  writes need the current ICS before an edit-scope transform runs — a
  mirror must serve this from its local copy or the mirror is pointless.
- **`CalendarObject.href`** is an opaque locator the frontend echoes back
  verbatim on every write (never parse/construct it). It's what lets
  `updateObject`/`deleteObject` work with no server-side state beyond the
  session cookie.
- The frontend does **not** patch its event cache after a write —
  `useEventsStore`'s create/update/delete await the API then refetch the
  visible range. Exception: drag/resize gets optimistic UX from
  FullCalendar's `revert()`.
- `getRawObject()` passes the object's own href as `calendar.url` to
  `fetchCalendarObjects({ calendar: { url: href }, objectUrls: [href] })`.
  Works against Radicale and Baikal.
- A `calendar-query` REPORT against a freshly-written object occasionally
  404s once, then succeeds on retry; the app's polling is retry-tolerant.

## Sessions

`POST/GET/DELETE /api/session`. Lifetime configurable via
`SESSION_TTL_DAYS` (default 1; `server/src/config.ts`, days for
readability, converted to seconds), applied to both
`@fastify/secure-session`'s `expiry` (baked into the encrypted payload,
checked every request) and the cookie `maxAge` (`server/src/session.ts`).

**Auth scheme** is auto-detected at login (`dav/auth.ts` `detectAuthMethod`
— one unauthenticated PROPFIND, reads `WWW-Authenticate`) and stored on the
session (`DavContext.authMethod`, absent ⇒ Basic). All CalDAV traffic goes
through `dav/auth.ts` `davFetch`: Basic just attaches the header; Digest
(RFC 2617/7616, MD5/`-sess`/SHA-256, `qop=auth`) does the 401
challenge/response and **caches the negotiated challenge per credentials +
origin** (sha256 of origin/username/password, 10-minute idle TTL), reusing
it with an incrementing `nc`, so a Digest request normally costs one round
trip. A refused cached nonce (stale, expired, server lost its nonce state) is
dropped and renegotiated **exactly once** from that 401's own challenge; if
the renegotiated one is refused too, that's a `DavAuthError`, never another
retry. `-sess` algorithms keep the entry's cnonce fixed. The cache is keyed
on the password (not just origin) because a per-origin cache let a nonce
left over from a failed login cause an unrecoverable 401 loop. Without a
cached challenge it falls back to the handshake: a bodyless probe for
body-optional methods, else the real request unauthenticated first. It's
wired in as tsdav's `fetch` override and used directly by the raw
sharing/PROPPATCH fetches.

Baikal (sabre) appears not to expire nonces, so the refused-cached-nonce path
is covered only by unit tests (`dav/auth.test.ts`), not by a real server.
(Each Baikal listing also sends one `POST` it answers 501 -- the
Radicale-only `/.sharing/v1/map/list` lookup; wasted but harmless.)

**`createClient` uses tsdav's `authMethod: 'Custom'`** with an
`authFunction` returning no headers. tsdav ≥ 2.4.0 has its own Digest support
and, with `'Basic'`/`'Digest'`, wraps the `fetch` override in it -- which
retried rejected credentials on top of `davFetch`. With `'Custom'`, `davFetch`
is the only auth layer. Letting tsdav do Digest was tried and rejected: it
can't cover the raw calls (tsdav doesn't export its Digest fetch), its auth
failures are untyped errors, and it would mean two Digest implementations.

**Rejected credentials mid-session** (password changed, account
disabled): `davFetch` throws `DavAuthError` when an authenticated request
still gets a 401 (or a Digest session gets a 401 with no Digest
challenge). `createClient` rethrows it from `login()` too -- tsdav's
discovery swallows fetch errors and would otherwise surface a generic
"cannot find principalUrl". The app error handler (`index.ts`, no unit test
-- it builds the app inline) maps it to a **401** `dav_auth_failed`, evicts
the cached client and deletes the app session, so the client's
`SESSION_EXPIRED_EVENT` fires and a reload doesn't land back on a dead
session. Verified against Digest Baikal (including parallel and stale-cookie
requests) and Basic Radicale.

Digest is verified end-to-end against Baikal 0.11.1 with
`dav_auth_type: Digest` (login, calendar discovery, event create/fetch/delete,
raw PROPFIND privilege-set, raw PROPPATCH rename).

Client handles mid-tab expiry: `api.ts`'s `request()` dispatches a
`SESSION_EXPIRED_EVENT` on any non-`/session` 401; `App.vue` clears the
store and routes to `/login?expired=1`, where `LoginView.vue` shows a
"session expired" message.

## Pitfalls found the hard way

These don't fail loudly — curl alone wouldn't catch some of them.

- **SSRF / credential leak via `calendarId`.** `assertHrefSameHost()`
  guards `href`, but `calendarId` also `decodeId()`s to a client-controlled
  URL — a forged `:id` could make `getEvents` / `createObject` /
  `syncCalendar` send Basic-auth credentials off-host. Each asserts right
  after `decodeId()` (`DavCalendarStore.ts`), and a global `setErrorHandler`
  maps `DisallowedHostError` → 403. Do the same for any new store method that
  decodes an id.
- **`RECURRENCE-ID` value type** must follow the *master's* DTSTART type
  (`masterIsAllDay()`), not the edit's new `fields.allDay`.
- **All-day events**: build with `ICAL.Time.fromDateString()`; setting
  `.isDate = true` after the fact yields a floating `DTSTART` that reads back
  as timed.
- **`crypto.randomUUID()` is `undefined` over plain HTTP + a non-`localhost`
  host.** Client IDs use a `generateId()` fallback; check for secure-context
  APIs before adding any other client-side `crypto.*` call.
- **`parseIcalUntil()`** must use the event's own zone, not `.toLocal()`, or a
  recurring `UNTIL` shows (and re-saves) off by a day.
- **`reloadLastRange(calendarIds?)`** refetches only the touched calendar(s)
  (source + destination on a cross-calendar move) so a single-event write
  doesn't bypass the 30s freshness cache for everything. Error-recovery paths
  still do a full refresh. Calendar/subscription toggles are picked up by
  `watch()`es on `enabledCalendarIds` / `enabledSubscriptionIds`.

**General lesson (from the CRITICAL sharing bug below):** "operation A
failed, therefore condition X is false" is not a safe basis for a
destructive fallback B. Confirm X independently first — especially when B
is irreversible and A can fail for many reasons.

## Timezone handling

ical.js registers only `UTC`/`GMT`/`Z` by default — no IANA data.

- `server/src/ical/timezones.ts`: `ensureTimezoneRegistered(tzid)` pulls
  real VTIMEZONE data from `@touch4it/ical-timezones` and registers it on
  first use. `registerEmbeddedTimezones(comp)` handles the read side — a
  raw `new ICAL.Component(ICAL.parse(ics))` does **not** auto-register an
  embedded VTIMEZONE, so this is called at every ICS-parse entry point
  (`icsToCalendarObject`, `expandCalendarObject`, `editScope.ts`'s
  `parseCalendar()`), making reads correct for any server's VTIMEZONE.
- Every VCALENDAR the app writes calls `ICAL.helpers.updateTimezones(comp)`
  before `.toString()`, so a matching VTIMEZONE always travels with the
  event.
- `EventEditDialog.vue` has a timezone picker
  (`Intl.supportedValuesOf('timeZone')`); `EventDetailPopover.vue` shows
  the event's zone when it differs from the viewer's.

Verified: a weekly `America/New_York` series holds 9am wall-clock across
the March DST transition, and (on Baikal) so do `America/Phoenix`,
`Asia/Kolkata`, `BYDAY=2TU`, an override edit and a deleted occurrence
(`EXDATE`, written in UTC). Not tested: a VTIMEZONE authored by a different
server. Events stored with a floating RDATE (an old bug) stay floating until
next saved.

## Recurrence: known simplifications

- **Editing "all" / "this and future" drops overrides only when the edit
  also toggles all-day-ness** — otherwise overrides are shifted by the
  master's DTSTART delta (`shiftOverride()`) and carried; `applyThisAndFuture`
  also re-keys them onto the new series's UID. No sensible time delta exists
  across a DATE↔DATE-TIME boundary.
- No separate expansion "horizon" cap — the iterator stops at `range.end`,
  so the requested range is the bound.
- *Ordinal `BYDAY`* and *RDATE* needed no server work beyond `mapper.ts`
  round-tripping the RRULE string / writing RDATE with a real `ICAL.Time`
  (`EventFields.rdate`); ical.js's iterator honors both.

## Search, ICS import, subscriptions

- **Search** — `GET /api/search?q=` (`server/src/routes/search.ts`),
  substring over summary/description/location, case-insensitive, capped at
  100, sorted by start. Two backends:
  - **Cache off (`DavCalendarStore`)** — the route's own `windowSweep`:
    loops `discoverCalendars` + `getEvents` over a default ±1yr/±2yr window
    (overridable via `start`/`end`). Scales with calendar count × window.
  - **Cache on (`SqliteCalendarStore`)** — the store exposes an optional
    `searchEvents(ctx, q)`; the route uses it instead. It freshens every
    calendar (`ensureFresh`), then substring-scans a per-object lowercased
    `search_text` blob (built by `ical/searchText.ts`, stored on the
    `objects` row). **Full history, no window.** Returns one hit per stored
    object — the *series master* for a recurring event, not every
    occurrence (unlike the sweep). Substring, not FTS5: FTS5 would silently
    change matching to token-prefix. `search_text` is NULL for rows synced
    before this shipped until their next sync — those just don't match.
  - Frontend: `SearchBox.vue`, 300ms debounce, min 2 chars; sends only `q`.
- **ICS import** — `POST /api/calendars/:id/import`, body `{ ics }`.
  `server/src/ical/importIcs.ts` splits a multi-VEVENT file into one
  VCALENDAR per source UID (master + its RECURRENCE-ID overrides), assigns
  each a **fresh** UID (avoids collisions), creates via the normal
  `store.createObject`. Partial failure doesn't abort
  (`imported`/`total`).
- **Subscriptions** — `GET /api/subscriptions/events?url=&start=&end=`
  (`server/src/ical/subscription.ts`). Fetches an external
  http(s)/webcal URL server-side, parses like import, returns
  `CalendarObject[]` with a synthetic `sub:<sha256(url)[:16]>` id and a
  constant `'subscription'` etag (read-only by construction). **SSRF
  surface**: gated by `requireSession`; `safeFetchExternal` pins the
  connection to the validated IP (see "Security hardening").
  Subscriptions are **entirely client-side state**
  (`stores/subscriptions.ts`, localStorage); the server just proxies each
  URL per request. Events merge into `CalendarView.vue` with
  `editable: false`.

## Calendar sharing

Shares a calendar between two users on the same CalDAV server. CalDAV
itself (RFC 4791) has no sharing; each backend has its own mechanism, and
**the code must positively confirm which mechanism a share uses before
acting — never infer it from a failed call** (see the CRITICAL bug below).

### Radicale — `/.sharing/v1/map` API

Enabled via the `[sharing]` config section above. A share needs both
sides to `map/enable` + `map/unhide` (owner, then recipient) before it's
live; until then it's inert. Once live the collection is genuinely mounted
under the recipient's principal and shows up through the unmodified
`discoverCalendars()` path.

- All sharing-API paths need a **leading slash** (bare `"testuser/personal/"`
  500s deep in `pathutils.strip_path`).
- `PathOrToken` = the path under the **recipient's** principal
  (`/shareduser/testuser-personal/`); `PathMapped` = the owner's real
  collection. The `Access` check is against the recipient's rights on
  `PathOrToken`, so a path under the owner's principal 403s.
- `Permissions: "rw"` works for write access despite `w` not appearing in
  SHARING.md's vocabulary examples; `"r"` correctly 403s on `PUT`.
- A map-shared calendar's `resourcetype` is **identical** to an owned one
  — no marker. "Shared with me" detection cross-references
  `/.sharing/v1/map/list` (`listRadicaleSharedPaths()`, once per
  `discoverCalendars()`, fails open). Match on `PathOrToken` (the mounted
  path), not `PathMapped` (the owner's path — matches nothing).
- Radicale has no "declined" state — a hidden share is byte-identical to
  one never accepted, so an unsubscribed share reappears as "pending" on
  the next load. Handled client-side (below).
- `TimestampUpdated` is computed from the server's **naive local time**
  minus a naive epoch — it's ~UTC-offset hours off a real Unix timestamp.
  Any comparison against it must use a value sourced from the same clock,
  never `Date.now()`.

### Baikal — CalDAV `cs:share` POST (calendarserver-sharing draft)

Both sharing plugins are unconditionally registered in Baikal 0.11.1
(older GitHub issues saying otherwise are stale).

- Owner POSTs a `cs:share` body to the calendar collection URL, with
  `<cs:set><d:href>` = **`mailto:` + the recipient's registered email**
  (username alone silently creates an invalid invite), plus
  `<cs:read-write/>` or `<cs:read/>`.
- **No accept step** — the invite auto-accepts and mounts immediately at
  `/dav.php/calendars/<recipient>/<uuid>/` with `resourcetype` including
  `cs:shared` (vs `cs:shared-owner` for owned), which tsdav surfaces as
  `cal.resourcetype` containing `shared` — a free "Shared with me" signal.
- Baikal returns `200 OK` even when the recipient can't be resolved, so
  `tryBaikalShare()` **re-fetches `cs:invite` and checks the entry's
  status** before reporting success.
- Once a calendar is shared, Baikal lists the **owner** in `cs:invite` as a
  `cs:user` with an empty `<cs:access/>`; `parseBaikalInvite()` drops
  empty-access entries (unit-tested in `dav/sharing.test.ts`), otherwise a
  token taken from `[0]` points at the owner and update/revoke silently
  no-op (Baikal answers 200). `cs:set` without `cs:common-name` updates an
  existing recipient in place; `cs:remove` removes them.
- XML parser gotcha: `xml-js` (`compact: true`) keys by the literal wire
  tag, and Baikal declares `xmlns:d="DAV:"` *prefixed*, so the href is
  under `'d:href'`, not `'href'`.

Share management (list → update read↔readwrite → revoke) is verified against
Baikal 0.11.1 (Basic) via the sharing routes.

### App surface

- `POST /api/calendars/:id/share` (`shareCalendar()` in
  `server/src/dav/sharing.ts`) tries Radicale then Baikal, throws a
  combined `ShareFailedError` → 422 if neither works (never a false
  success). Radicale re-share after an unsubscribe hits a 409 on the
  deterministic `PathOrToken`; handled by looking up and re-enabling the
  existing (hidden) entry.
- `POST /api/calendars/:id/unsubscribe` (recipient) — **CRITICAL bug,
  fixed:** the original "try Radicale `hide`; on any non-success fall back
  to a plain DAV `DELETE`" logic is unsafe. Radicale's map resolver
  forwards `DELETE` to the owner's real collection with no extra
  permission check — a recipient's `DELETE` against their mounted path
  **irreversibly deleted the owner's calendar**. Now: positively
  confirm the calendar is a Radicale map share the current user receives
  (`fetchRadicaleMapList` matching `User` + `PathOrToken`) **first** — if
  so, only `hide` is ever attempted and any failure throws; `DELETE` is
  reached only when the lookup confirms it's *not* a Radicale share.
- `DELETE /api/calendars/:id` (owner) — plain DAV `DELETE`. On Radicale
  this doesn't touch the sharing db, so `deleteRadicaleSharesForPath()`
  runs afterward (best-effort) to `map/delete` any shares pointing at the
  deleted collection, else recipients see a phantom pending invite. Baikal's
  PDO backend already wipes all `calendarinstances` rows on an owner delete.
- `GET /api/sharing/pending` + `POST /api/sharing/pending/accept`
  (`listPendingRadicaleShares()`) — in-app accept flow for the Radicale
  recipient-side enable+unhide step. `fetchShareDisplayName()` PROPFINDs
  the share for a real `displayname` (falls back to the path segment,
  which for app-created calendars is a raw UUID). Baikal returns `[]`.
- `GET/PATCH/DELETE /api/sharing/calendars/:id/shares[/:token]`
  (`server/src/routes/sharing.ts`, owner-only) — list / change-permission
  / revoke. `OwnedShare.token` is base64url-encoded `PathOrToken` /
  `mailto:` href via `idCodec.ts`.
- Client: dismissed-pending state is a `pathOrToken → dismissedAt` map in
  localStorage (`calendar.dismissedPendingShares.v2` — the `.v2` rename
  discards entries corrupted by a pre-fix `Date.now()` clock bug).
  `CalendarList.vue` splits own vs "Shared with me" on `Calendar.isShared`.
  The SQLite schema has an unused `is_shared` column (no migration system
  yet).

**Trust boundary:** unsubscribe is only safe because it's meant to be
called from the "Shared with me" list. There's no server-side check
distinguishing "shared to me" from "my own" beyond what Radicale's `hide`
permission enforces (Baikal has none — an owner's plain `DELETE` on their
own calendar *is* the intended full delete, which is why the two routes
share a code path there).

## Calendar create / rename / delete

`POST /api/calendars` (`MKCALENDAR` via `client.makeCalendar()`, collection
URL is `<calendar-home-set>/<uuid>/`), `PATCH /api/calendars/:id` (raw
PROPPATCH of `d:displayname` / `ca:calendar-color`, tsdav has no wrapper),
`DELETE /api/calendars/:id`. Rename/delete are owner-only (403 if
`isShared`). `SqliteCalendarStore` write-throughs and patches the cached
row for all three.

## Read-only calendars, color, reminders, export

- **Read-only calendars.** `server/src/dav/privileges.ts`
  `isCalendarReadOnly()` — raw `current-user-privilege-set` PROPFIND per
  calendar (tsdav doesn't request it). A `rw` share recipient gets `read`
  + `write-content` but never a bare `write`, so `readOnly` checks for the
  absence of **both** `write` and `write-content`. Enforced server-side by
  `requireWritableCalendar()` (gates all four event-write routes, 403s
  before any DAV call), not just discovered. Client: the New/Edit-event and
  Import dialogs filter their calendar dropdowns to writable calendars
  (keeping the event's current one selectable so it can be moved).
- **Per-event color.** RFC 7986 `COLOR`, a plain string property.
  Flows through `editScope.ts` for free.
- **Reminders (VALARM).** `EventFields.alarms` = `{ minutesBefore }[]`.
  v1 scope: `DISPLAY` action, relative before-start `TRIGGER` only
  (absolute or after-start triggers aren't read back). Stored ICS is
  standard `BEGIN:VALARM` — portable. Delivery is **in-tab only** (explicit
  choice, no service worker/push): `stores/notifications.ts` requests
  `Notification` permission on an explicit button click, schedules
  `setTimeout`s for alarms within 24h, re-arming on every load.
- **ICS export.** `GET /api/calendars/:id/export` (whole calendar over a
  wide default range) and `GET /api/calendars/:id/events/:uid/export`
  (single event). `mergeIcsObjects` in `server/src/ical/exportIcs.ts`.

## Undo toast

Client-only. `client/src/stores/undo.ts` holds a single pending
`{ message, run }` offer with an 8s self-clearing timer (a new offer
replaces any still-pending one); `UndoToast.vue` is mounted once in
`CalendarView.vue`. The delete `ConfirmDialog` is unchanged — the toast is an
*additional* safety net.

Undo is offered only for **non-recurring** events, on: delete
(`doDelete`), calendar-move / field-edit via the edit dialog (`doUpdate`,
`offerEditUndo`), and drag / resize (`onEventDrop` / `onEventResize`).

- **Delete undo re-creates the event** via `eventsStore.createEvent` from
  the `CalendarObject` still in memory → it comes back with a **fresh
  UID/href**. It would not restore a recurring series' overrides, hence
  non-recurring only.
- **Edit/move undo** re-applies the pre-edit `CalendarObject`'s original
  fields (`toFields(before, before.start, before.end)`) against the
  server's *current* etag, looked up via `eventsStore.findEvent` after
  `reloadLastRange` has refreshed the cache. `scope: 'all'` always.
- Recurring events: no toast — reverting them needs an edit-scope choice.

## SQLite read-cache (`SqliteCalendarStore`)

Enable with `CACHE_ENABLED=true` (default off — `DavCalendarStore` is used
directly otherwise); `SQLITE_PATH` (default `./data/cache.db`) and
`CACHE_SYNC_TTL_MS` (default 30000) also configurable. Has never been enabled
in a real deployment.

Decorator over any `CalendarStore` — reads are cache-first with TTL-gated
sync, writes are write-through then reflected into the cache. Supporting
code in `server/src/store/sqlite/{db,schema,userKey}.ts`. Cache key is
`sha256(baseUrl + username)` — the password is never persisted. Tables use
`STRICT`.

Verified: cold-cache correctness, write-then-read consistency, TTL-bounded
staleness on out-of-band writes, and the 412 + recurring edit-scope tests
re-passing through the cached path (including the `getRawObject` cache-hit).
**Out of scope**: cross-device invalidation beyond the TTL, background sync
workers, pre-expanded occurrence caching, cache eviction.

## Settings, theme, auto-refresh

- `SettingsDialog.vue` (⚙️ next to sign-out) holds calendar sort ("Week
  starts on", "Default calendar" and the contacts address format too). All
  settings are client-only in `client/src/stores/settings.ts`, one
  localStorage key each. `calendarSortOrder` (`'server' | 'name-asc' |
  'name-desc'`) is applied in `CalendarList.vue` via a local `sorted()` helper
  that doesn't touch `store.calendars`' order (CalDAV has no ordering
  property). View options (`weekends`, `weekNumbers`, `nowIndicator`,
  `scrollTime`) feed straight into `calendarOptions` in `CalendarView.vue`.
  "Default event length" only affects the "New event" button; "Default
  reminder" seeds `form.reminders` in `EventEditDialog.vue` for a brand-new
  event only, never an edit or duplicate/paste. Reminder presets are shared
  via `client/src/lib/reminders.ts`.
- `calendar.defaultVisibleCalendarIds` is in `ACCOUNT_SCOPED_KEYS`
  (`lib/accountStorage.ts`): it's a whitelist of calendar ids, so left behind
  on logout it would hide every calendar of the next user on that browser.
- **Theme** — `Theme = 'auto' | 'light' | 'dark'`. The store resolves it
  (`'auto'` via a live `matchMedia('(prefers-color-scheme: dark)')`
  listener) onto `<html data-theme="light|dark">`; `App.vue` instantiates it
  so the login page is themed too. An inline script in `client/index.html`
  does the same resolution before first paint to avoid a light flash --
  **keep the two in sync**. `base.css` redefines the `--color-*` /
  `--shadow-*` tokens under `:root[data-theme='dark']`, inside
  `@media screen` so printing always uses the light tokens. FullCalendar
  follows through the `--fc-*` → token mapping in `CalendarView.vue`'s
  unscoped `<style>`.
- **Auto-refresh** — `CalendarView.vue` calls `loadVisibleRange()` when the
  tab becomes visible again and every 5 min while visible
  (`AUTO_REFRESH_MS`). Non-forced, so `eventsStore`'s 30s `FRESH_MS` window
  dedupes it. The calendar *list* isn't re-fetched — a calendar created on
  another client needs a reload. A failed background load doesn't overwrite
  an error banner that's already showing.

## Views, duplicate/paste, print

Client-only, mostly in `CalendarView.vue`.

- **Agenda** (custom `listUpcoming` view) is a `type: 'list'` view whose
  `visibleRange` always starts today and runs a year out, regardless of
  prev/next navigation. `onDatesSet` records the view type in
  `currentViewType`; while it's `listUpcoming`, `fullCalendarEvents` sorts by
  start and caps the list at `LIST_UPCOMING_MAX_EVENTS` (100). **Year** is
  `multiMonthYear`.
- **Mini-month** — `components/MiniMonth.vue`, luxon-only (no second
  FullCalendar instance). Follows the main calendar via `focusDate`
  (`onDatesSet` records `arg.view.currentStart`, not `arg.start`, which
  includes a month grid's leading days) but can be paged independently.
- **Duplicate** — no new API; a duplicate is a pre-filled create.
  `EventEditDialog.vue` takes an optional `template?: CalendarObject` and
  seeds the content fields from it (`source = props.event ?? props.template`);
  `props.event` alone still drives `isEditing`. `requestDuplicate()` opens it
  directly for non-recurring events; recurring ones first show
  `DuplicateScopeDialog.vue` (one-off vs whole series;
  `duplicateTemplateObject` strips `rrule/rdate/isRecurring/recurrenceId` for
  'single').
- **Copy-paste** — `stores/clipboard.ts` holds one `CalendarObject` in memory
  (no OS clipboard). A window `keydown` handler does Ctrl/⌘-C (detail popover
  open, outside inputs) and Ctrl/⌘-V (opens the pre-filled create dialog).
  Paste always lands as a one-off.
- **Print** — no dedicated route; it prints whatever view is on screen. A
  `printing` ref reshapes `calendarOptions` (`headerToolbar: false`,
  `height: 'auto'`, `expandRows`/`dayMaxEventRows` off). The sidebar "Print"
  button sets `printing`, awaits `nextTick()` + one rAF for FullCalendar's
  reflow, then `window.print()`; `beforeprint`/`afterprint` listeners cover
  Ctrl/⌘-P. Styling is a `.layout--printing` class plus an `@media print`
  block in the **unscoped** `<style>` (so it reaches the teleported
  `UndoToast` and FullCalendar's markup). Auto-switching to agenda for
  printing was dropped — restoring the prior view after `afterprint` races
  the print dialog. Pick Agenda first, then Print.

## External access

Start the client dev server with `vite --host 0.0.0.0` (not the bare
`vite` in the `dev` script) to reach it from another LAN device
(`http://192.168.10.50:5173`). The API server already binds `0.0.0.0`.
This is plain HTTP, no auth/firewall in front — trusted-LAN only. Plain
HTTP on a non-`localhost` host also disables secure-context browser APIs
(see `crypto.randomUUID()` above).

## Docker packaging (unbuilt — no Docker on this host)

Single image (`Dockerfile` at repo root) — `server/src/index.ts` already
serves `client/dist` via `@fastify/static`, so there's no second server.

- Multi-stage: `build` stage has `python3`/`make`/`g++` (for
  `better-sqlite3`'s native addon), runs `npm run build` (shared → server
  → client) then `npm prune --omit=dev`; `runtime` stage copies only
  `node_modules`, each workspace's `package.json` + `dist`, and
  `client/dist`.
- Depends on the npm-workspaces symlink layout:
  `node_modules/@yourdav/{shared,server,client}` are relative symlinks, so
  copying `node_modules` verbatim + recreating each `package.json`+`dist`
  at the same relative path makes them resolve without carrying `src/`.
  `client/package.json` is deliberately not copied.
- `docker-compose.yml` wires `SESSION_SECRET` (required, no default —
  `openssl rand -hex 32`, decoded as raw 32-byte key material),
  `ALLOWED_DAV_HOSTS`, `CACHE_ENABLED`/`CACHE_SYNC_TTL_MS`, and a named
  volume at `/app/data`. `.env.example` mirrors these.
- **Gotcha, not fixed:** the Dockerfile sets `NODE_ENV=production`, which
  makes `session.ts` mark the cookie `Secure` — a browser won't send it
  over plain HTTP, conflicting with the LAN-IP access pattern above. Any
  deployment past `localhost` needs TLS termination in front, or a
  conscious `NODE_ENV` override.
- Whoever has Docker should `docker compose up --build` and run at least a
  login + one calendar read/write through it.

The running release shows as "Version …" in the settings dialog footer
(`SessionInfo.version`, from `config.version`): the `APP_VERSION` env var,
baked in by the Dockerfile build arg (CI passes the git tag for tag builds,
`dev` for `main`/dispatch builds; unset also means `dev`). There's no `.git`
in the image, so it can't come from `git describe`.

## CardDAV contacts

Merged in from the separate YourContacts project. The shell (app switcher,
`/contacts` route, master-detail layout, address-book sidebar, per-book client
cache) came from PR #68 by BladeWDR; the data layer is YourContacts' and
replaced that PR's ical.js-based one. Verified with curl against real
Radicale 3.x and Baikal 0.11.1, and browser-tested (see Open items).

- **One session, two protocols.** `createClient(ctx, 'caldav' | 'carddav')` in
  `server/src/dav/client.ts` keeps one cached tsdav client per account *and*
  account type (the type is part of the cache key — without it the two would
  collide); `evictClient` clears both. Contacts always use `'carddav'`.
- **`SessionInfo.hasContacts`** is set at login and on whoami from
  `supportsContacts()` (`dav/discovery.ts`), a CardDAV discovery probe that
  never throws and is cached per account for ten minutes. When false the
  switcher omits the Contacts tab and the router bounces `/contacts`.
- **API** (`server/src/routes/addressbooks.ts`, mounted at `/api/addressbooks`):
  `GET /` and `POST /` (create), `DELETE /:id`, `GET|POST|PUT|DELETE
  /:id/contacts`, `POST /:id/contacts/transfer` (move/copy to another book),
  `GET /:id/photo`, `GET /:id/export`, `POST /:id/import`,
  `POST /:id/groups/rename`, `POST /:id/groups/members` (add/remove one group
  on many contacts). `AddressBook.url` is the collection's CardDAV URL.
  Writes check the address book is discovered and not read-only
  (`writable()`); address-book delete is refused (404) for any id that is not
  a discovered address book.
- **Store** (`store/DavContactStore.ts`, no SQLite cache — contacts always go
  straight to the server): `readOnly` comes from the WebDAV ACL via
  `isCollectionReadOnly`, shared with calendars. Every card href must sit inside
  its address book's path (`hrefInBook`, segment-boundary check) and
  throws `ForbiddenError` (-> 403) otherwise. Updates re-fetch the server's card
  and send `If-Match`; a stale etag is a 412.

### Verified against Baikal 0.11.1

Driven through the app's API with curl, once under Basic and once under
Digest: login and CardDAV discovery (`/dav.php/`, default book `Default
Address Book`), ACL-derived `readOnly: false`, contact create with photo,
list, photo endpoint (`image/png`, `nosniff`), no-op edit of an Apple-style
card (ORG, TYPE params, X-*/IMPP/PRODID kept), stale etag -> 412, `.vcf`
export and re-import (UID dedupe, content-hash UID for UID-less cards), group
rename, address-book create (extended `MKCOL`) and delete, delete of an
undiscovered id -> 404, card href outside the book -> 403.

Not covered on Baikal: a read-only address book (Baikal does not share address
books) and write conflicts from a second client. Changing `dav_auth_type` under
a live session makes the stored auth method stale: the server rejects it and
the app ends the session with a 401, which is the intended behaviour.

### vCard handling (important)

- `server/src/vcard/` is a hand-written line parser, **not** ical.js. PR #68's
  ical.js version was tested and rewrote untouched data on every edit:
  `BDAY;VALUE=date:1990-05-17` became `BDAY;VALUE=DATE:19900517`, `GEO:geo:1,2`
  became `geo:1\,2` (corrupting the URI), `TYPE=CELL,VOICE` became one quoted
  `TYPE="CELL, VOICE"`, `PREF=`/`VALUE=` parameters were dropped, and an Apple
  `item1.X-ABLabel` was orphaned from its `item1.EMAIL`.
- Edits regenerate only the managed properties (FN, N, NICKNAME, ORG, TITLE,
  EMAIL, TEL, URL, ADR, BDAY, ANNIVERSARY, NOTE, CATEGORIES, PHOTO); every other
  line (X-*, PRODID, IMPP, KIND, GEO, ...) is kept byte-for-byte. VERSION is
  retained (3.0 or 4.0); new cards are 3.0. `REV` is refreshed.
- ORG is structured (company;department) but edited as one flat string, so the
  stored ORG line is kept verbatim unless its text changes.
- Apple-style groups (`item1.EMAIL` + `item1.X-ABLabel`) are removed together
  when the managed property is regenerated, so a custom label ("Work2") is
  dropped with it rather than left orphaned. Known loss.
- The editor's "display name" field only holds a value when the stored FN differs
  from the one generated from the name parts, so a custom FN ("Mom") survives an
  edit and clearing the field regenerates it.
- Birthdays/anniversaries are plain text (`1990-01-31` or `--01-31` with no
  year) because a date picker would silently clear year-less dates.
- `Contact.href` / `Contact.id` are opaque locators the client echoes back.
  Import dedupes by UID; cards with no UID get a content-hash UID so
  re-importing is idempotent.

### Moving, copying, batch edits and merging

- **Transfer** (`/:id/contacts/transfer`): a copy gets a new UID so the two
  cards stay distinct, a move keeps it. A move is create-then-delete and
  removes the new card again if deleting the original fails, so a contact is
  never left in both books. Copying out of a read-only book is allowed; moving
  out of one is not.
- **Group membership** (`/:id/groups/members`, `editCategories()` in
  `vcard/card.ts`) edits only the CATEGORIES line(s), like group rename, so a
  batch "add to group" doesn't renormalise every card the way a full update
  would. Capped at 200 contacts per request; the client chunks.
- **Merge** is client-composed: `MergeDialog.vue` builds a `ContactInput` from
  the user's choices and the store updates the kept card (so its UID, href and
  unmanaged properties survive) then deletes the other. Shared phone/email/URL/
  address entries are folded by a normalised key. Unmanaged properties of the
  *deleted* card are not carried over (the dialog says so). A photo taken from
  the other card is fetched and re-encoded client-side.

### Client

- `stores/contacts.ts` keeps contacts per address book with a 30s freshness
  window and stale-while-revalidate, remembers the active book in
  `localStorage` (`yourdav:active-address-book`, cleared on logout). The active
  book is an address-book id or `ALL_BOOKS` (`'all'`), the combined view, which
  is the default when there are two or more books. A remembered book that no
  longer exists falls back to the combined view (or the only book).
  Search, group filter and sort are client-side. The store also holds the
  checked set for batch actions and the move/copy/merge/batch operations.
- **Popovers and pointer events.** Menus (`BookMenu`, `GroupMenu`) are
  teleported to `<body>` and `position: fixed` via `lib/popover.ts`, so the
  list pane's overflow can't clip them. When hiding something with
  `opacity: 0`, also set `pointer-events: none`: a transparent element still
  catches clicks, and one with opacity < 1 paints above plain siblings. This
  broke group rename once (the faded-out count sat on top of the rename button).
- The address format preference (US / international) lives in the
  localStorage-backed `stores/settings.ts` like every other preference —
  YourContacts' server-side per-account settings were not carried over.

## Browser testing (headless Chromium, no root needed)

There is no browser on the dev host, but Playwright's headless shell works if
its system libraries are unpacked privately (all outside the repo):

```
mkdir pw && cd pw && npm init -y && npm i playwright-core
npx playwright-core install chromium          # ~120 MB into ~/.cache/ms-playwright
mkdir debs syslibs && cd debs
apt-get download libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libasound2t64 libatspi2.0-0t64
for d in *.deb; do dpkg -x $d ../syslibs; done
export LD_LIBRARY_PATH=$PWD/../syslibs/usr/lib/x86_64-linux-gnu
```

If `apt-get download` 404s on a package (stale index), fetch the current `.deb`
from `archive.ubuntu.com/ubuntu/pool/...` directly. Run the app on a spare port
against the local Baikal, log in through the real login form, and drive it with
real `mouse.down()/up()` pauses: a bare `click()` is fast enough to hide
hover/transition bugs. Verify effects against the raw cards on the DAV server
rather than only the UI. Seed with throwaway contacts and restore them after.

## Security hardening

From an external review of the code:

- **Login host policy is deliberately open.** With `ALLOWED_DAV_HOSTS`
  unset, `POST /api/session` will connect to any `serverUrl` (blind SSRF:
  it only ever answers 401/403/201). Not changed on purpose -- this is a
  generic CalDAV frontend and LAN servers are the main use case, so the
  login path can't use the private-IP-blocking `safeFetchExternal`. The
  mitigation is the allowlist (documented in the README / SECURITY.md).
- **DNS rebinding**: `safeFetchExternal` (`dav/ssrf.ts`) uses `node:http(s)`
  with `guardedLookup` as the socket `lookup`, so the validated addresses
  are the ones connected to; hostname is untouched (SNI/Host fine). Literal
  IPs skip DNS and are checked up front. No `Accept-Encoding` is sent, so
  feeds arrive uncompressed.
- **LAN subscription feeds**: `ALLOW_PRIVATE_SUBSCRIPTIONS=true` permits
  RFC1918/CGNAT/ULA targets (loopback + link-local stay blocked).
  `ALLOWED_SUBSCRIPTION_PRIVATE_HOSTS`
  (comma-separated, exact hostname/IP) exempts named hosts from the
  private-address block in `safeFetchExternal` (e.g. a LAN Sonarr iCal
  feed). Default empty = everything private stays blocked.
- **Timeouts**: `OUTBOUND_TIMEOUT_MS` (default 30s) bounds every outbound
  request -- `safeFetchExternal` (whole exchange incl. body), `davFetch`
  and `detectAuthMethod` via `dav/timeout.ts`.
- **Login throttling**: `@fastify/rate-limit` on `POST /api/session`
  (`LOGIN_RATE_LIMIT_MAX`/min per IP; needs `TRUST_PROXY=true` behind a
  proxy or every user shares one bucket) plus a 20-concurrent-login cap.
  No per-(server, username) throttle.
- **Subscriptions**: 60s result cache keyed by url+start+end (shared by
  in-flight requests, failures not cached, 100 entries), 4 concurrent
  uncached fetches per account (429), range capped at 800 days.
- **Origin check** (`originCheck.ts`) on non-GET requests; missing Origin is
  allowed. The global error handler returns a generic 500 for anything that
  isn't a Fastify 4xx.
- **Known/accepted**: the CalDAV password lives in the encrypted session
  cookie and the in-memory DAV client cache -- inherent to proxying CalDAV
  auth with no local user store.
