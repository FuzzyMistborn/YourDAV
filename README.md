# YourDAV

A self-hosted web calendar and contacts client for CalDAV/CardDAV servers
(tested against [Radicale](https://radicale.org/) and
[Baikal](https://sabre.io/baikal/)). Your DAV server is the sole identity
provider — there's no separate local user store or account system. Switch
between Calendar and Contacts from the top of the sidebar; if your server
has no address books, the Contacts tab is hidden.

YourDAV is the merger of the former YourCal and YourContacts projects. See
[Upgrading from YourCal](#upgrading-from-yourcal) if you're coming from an
earlier release.

## Features

- Month/week/day views with drag-to-resize and drag-to-move events
- Multiple calendars, per-calendar color overrides
- Recurring events (RRULE) with weekday picker and never/count/until end
  conditions, plus this/this-and-future/all edit and delete scopes
- Real IANA timezone support (read and write), including across
  DST transitions
- Search across all calendars
- ICS file import
- WebCal/ICS URL subscriptions (read-only)
- Calendar sharing between users on the same CalDAV server (Radicale
  sharing API and Baikal `cs:share`, with an in-app accept flow)
- Contacts (CardDAV): multiple address books (create and delete) with a
  combined "All address books" view, groups, photos, typed
  phones/emails/websites/addresses, `.vcf` import and export, read-only
  address books, move/copy between address books, multi-select with batch
  delete and group changes, merging two duplicates, and each address book's
  CardDAV URL for setting up other apps. Edits only touch the fields the editor manages —
  everything else on the card (custom `X-` properties, instant-message
  handles, etc.) is preserved byte-for-byte. Contacts have been verified against
  Radicale and Baikal (Basic and Digest auth).

See [AGENTS.md](./AGENTS.md) for implementation details, known gaps, and
open items.

## Screenshots

<table>
  <tr>
    <td><img src="screenshots/02-calendar-month.png" alt="Month view"></td>
    <td><img src="screenshots/03-calendar-week.png" alt="Week view"></td>
  </tr>
  <tr>
    <td align="center">Month view</td>
    <td align="center">Week view</td>
  </tr>
  <tr>
    <td><img src="screenshots/04-new-event.png" alt="New event dialog"></td>
    <td><img src="screenshots/05-settings.png" alt="Settings dialog"></td>
  </tr>
  <tr>
    <td align="center">New event</td>
    <td align="center">Settings</td>
  </tr>
</table>

<table>
  <tr>
    <td><img src="screenshots/06-contacts.png" alt="Contacts"></td>
    <td><img src="screenshots/07-contacts-edit.png" alt="Editing a contact"></td>
  </tr>
  <tr>
    <td align="center">Contacts</td>
    <td align="center">Editing a contact</td>
  </tr>
  <tr>
    <td><img src="screenshots/08-contacts-batch.png" alt="Batch actions and move/copy"></td>
    <td><img src="screenshots/09-contacts-merge.png" alt="Merging two duplicate contacts"></td>
  </tr>
  <tr>
    <td align="center">Select several: move, copy, group, delete</td>
    <td align="center">Merge duplicates</td>
  </tr>
</table>

## Stack

npm workspaces monorepo:

- `shared` — TypeScript types shared between client and server
- `server` — Fastify API, talks to your CalDAV/CardDAV server via `tsdav`
- `client` — Vue 3 SPA (FullCalendar for the calendar grid)

## Running with Docker

### From a checkout (builds the image locally)

```sh
cp .env.example .env
# generate a session secret and put it in .env
openssl rand -hex 32
```

Edit `.env` (or set the equivalent variables in `docker-compose.yml`) —
`SESSION_SECRET` is required, everything else has a sensible default. Then:

```sh
docker compose up -d --build
```

### Without a checkout (pulls the published image)

Every push to `main` publishes an image to
`ghcr.io/fuzzymistborn/yourdav:latest` (see
`.github/workflows/docker-publish.yml`; tagged releases also get
`vX.Y.Z`/`vX.Y` tags). If you just want to run YourDAV without cloning the
repo, grab `docker-compose.example.yml`, rename it to `docker-compose.yml`,
create a `.env` next to it with at least `SESSION_SECRET` set (see
`.env.example` above for the full list of variables), then:

```sh
docker compose up -d
```

### Either way

The app listens on `http://localhost:3000`. Log in with credentials for
any CalDAV/CardDAV server reachable from the container (set `ALLOWED_DAV_HOSTS`
to restrict which hosts it's allowed to connect to).

> **Security note:** with `ALLOWED_DAV_HOSTS` unset, anyone who can reach
> the login page can make the server send requests to any host it can reach
> (including your internal network). That's fine on a trusted LAN; if the
> app is exposed to the internet, set the allowlist. Behind a reverse proxy,
> also set `TRUST_PROXY=true` so the login rate limit (10/min per IP) sees
> real client IPs. See [SECURITY.md](./SECURITY.md).

Calendar subscriptions (external iCal URLs) refuse hosts that resolve to
private/LAN addresses. To subscribe to LAN feeds such as Sonarr's, set
`ALLOW_PRIVATE_SUBSCRIPTIONS=true` (loopback and link-local/cloud-metadata
addresses stay blocked), or list individual hosts in
`ALLOWED_SUBSCRIPTION_PRIVATE_HOSTS` (comma-separated, exact match).

**Logged out immediately after a successful login?** The session cookie is
marked `Secure` whenever `NODE_ENV=production` (the Dockerfile's default),
so browsers silently drop it if you're accessing the app over plain HTTP at
anything other than `localhost` (e.g. a LAN IP like `http://192.168.1.50:3000`)
— login itself succeeds (`POST /api/session` returns 201) but every request
right after comes back 401 since the cookie never made it back. Either put a
TLS-terminating reverse proxy in front and access over HTTPS, or, for a
trusted LAN, uncomment `NODE_ENV: development` in `docker-compose.yml` and
`docker compose up -d` again (no rebuild needed).

## Running locally for development

Requires Node.js and a running CalDAV/CardDAV server to point at.

```sh
npm install
cp .env.example .env   # fill in SESSION_SECRET at minimum

npm run dev:server   # Fastify API, with reload
npm run dev:client   # Vite dev server for the SPA
```

Other useful scripts:

```sh
npm run build   # build shared, server, and client
npm run test    # server test suite
npm run lint    # eslint across the workspace
```

## Configuration

All server configuration is via environment variables — see
[.env.example](./.env.example) for the full list (session secret, DAV
host allowlist, session TTL, optional SQLite read-cache).

## Upgrading from YourCal

The first YourDAV release renames the project and is **a breaking change**.
Nothing is lost server-side — your calendars and contacts live on your DAV
server — but your deployment needs these edits:

- **Image:** `ghcr.io/fuzzymistborn/yourcal` stops receiving updates. Switch
  to `ghcr.io/fuzzymistborn/yourdav`.
- **Compose service and volume:** `yourcal` / `yourcal-data` are now
  `yourdav` / `yourdav-data`. The volume only holds the optional SQLite
  read-cache (`CACHE_ENABLED`), which is rebuilt automatically, so you can
  start with a fresh volume. To keep it anyway:
  `docker run --rm -v yourcal-data:/from -v yourdav-data:/to alpine cp -a /from/. /to/`.
- **Environment:** `ALLOWED_CALDAV_HOSTS` is now `ALLOWED_DAV_HOSTS` (it
  covers CardDAV too). The old name is **not** read, so with only the old
  name set the allowlist silently turns off — rename it before upgrading.
- **Coming from YourContacts:** that project's separate image is replaced by
  this one. Per-account settings (theme, address format) were stored on the
  server there and are now browser-local like the calendar's; set them once in
  Settings. `ALLOWED_CARDDAV_HOSTS` is now `ALLOWED_DAV_HOSTS`.

## Troubleshooting

**Baikal: login fails with "cannot find principalUrl"** — Baikal serves
CalDAV under `/dav.php`, not the host root, so the login form's server
URL needs the full path with a trailing slash, e.g.
`https://your-baikal-host/dav.php/` (omitting the trailing slash can make
the discovery request get redirected in a way that breaks it).

**Baikal: login fails with a fast `401` even with correct credentials** —
this app authenticates with HTTP Basic auth only. If your Baikal instance
(or a reverse proxy in front of it) is configured to require Digest auth
(check for a `WWW-Authenticate: Digest` response header), Basic auth
requests will be rejected outright. Configure Baikal/your reverse proxy
to accept Basic auth instead.

## License

MIT — see [LICENSE](./LICENSE).
