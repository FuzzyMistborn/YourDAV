import type { OwnedShare, PendingShare, ShareCalendarInput, ShareCalendarResult, UnsubscribeResult } from '@yourdav/shared'
import { xml2js } from 'xml-js'
import { decodeId, encodeId } from '../store/idCodec.js'
import { davFetch } from './auth.js'
import type { DavContext } from './context.js'

export { basicAuthHeader } from './auth.js'

export class ShareFailedError extends Error {}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

/**
 * Tries Radicale's proprietary `/.sharing/v1/map` API (Radicale 3.7+).
 * Confirmed by spike-testing (see AGENTS.md "Calendar sharing"): creating
 * a map share and enabling+unhiding the owner's side is enough for the
 * calendar to become writable and auto-discoverable for the recipient --
 * but only once the recipient *also* enables+unhides their own side,
 * which this app has no UI for yet (`pending: true`).
 */
/**
 * PROPFIND for a calendar's own displayname, called by the owner against
 * their own real collection URL (always accessible to them, unlike
 * fetchShareDisplayName's PROPFIND against a *recipient's* mounted path,
 * which 404s until that recipient has enabled+unhidden their own side --
 * confirmed by testing, contradicting this file's older assumption that
 * pre-acceptance PROPFIND always works).
 */
export async function fetchCalendarDisplayName(ctx: DavContext, calendarUrl: string): Promise<string | null> {
  try {
    const res = await davFetch(ctx, calendarUrl, {
      method: 'PROPFIND',
      headers: { 'Content-Type': 'application/xml', Depth: '0' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>',
    })
    if (!res.ok) return null
    const xml = await res.text()
    const parsed = xml2js(xml, { compact: true, ignoreDeclaration: true }) as Record<string, unknown>
    return findDisplayName(parsed)
  } catch {
    return null
  }
}

async function tryRadicaleShare(
  ctx: DavContext,
  calendarUrl: string,
  input: ShareCalendarInput,
): Promise<ShareCalendarResult> {
  const calPath = new URL(calendarUrl).pathname
  const slug = calPath.split('/').filter(Boolean).pop() ?? 'calendar'
  const pathOrToken = `/${input.recipient}/${ctx.username}-${slug}/`
  const permissions = input.permission === 'readwrite' ? 'rw' : 'r'
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  // Stashed into the share record itself (Radicale's Properties overlay
  // field, RFC-whitelisted to a handful of props incl. D:displayname) so
  // the recipient can see the real calendar name in their pending-shares
  // list *before* accepting -- confirmed by testing that the owner can set
  // this regardless of the server's permit_properties_overlay config (that
  // flag only gates whether Radicale *applies* the overlay to live PROPFIND
  // responses through the mounted path, not whether the value is stored/
  // readable via map/list, which both sides already read for other fields).
  // Best-effort: a calendar with no displayname yet (or a PROPFIND failure)
  // just means no Properties are sent, not a failure of the whole share.
  const displayName = await fetchCalendarDisplayName(ctx, calendarUrl)
  const properties = displayName ? { 'D:displayname': displayName } : undefined

  const create = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      PathOrToken: pathOrToken,
      PathMapped: calPath,
      User: input.recipient,
      Permissions: permissions,
      ...(properties ? { Properties: properties } : {}),
    }),
  })

  // 409 means a map share already exists for this owner/recipient/collection
  // combo -- e.g. the recipient previously unsubscribed (which only hides
  // their own side, see unsubscribeFromCalendar's doc comment) and the
  // owner is now re-sharing to the same person. Radicale has no
  // create-or-reuse semantics here, so re-share by finding that existing
  // entry and resetting it (permissions + owner's own enable/unhide) rather
  // than failing outright. Confirmed by testing: re-sharing a calendar to
  // a recipient who'd previously unsubscribed 409'd before this existed.
  let existingPathOrToken: string | null = null
  if (create.status === 409) {
    const entries = await fetchRadicaleMapList(ctx)
    const existing = entries.find(
      (e) => e.Owner === ctx.username && e.PathMapped === calPath && e.User === input.recipient,
    )
    if (!existing?.PathOrToken) {
      throw new ShareFailedError('Radicale map/create failed: 409 (conflicting share, but could not find it to reuse)')
    }
    existingPathOrToken = existing.PathOrToken
  } else if (!create.ok) {
    throw new ShareFailedError(`Radicale map/create failed: ${create.status}`)
  } else {
    const createBody = (await create.json().catch(() => null)) as { Status?: string } | null
    if (!createBody || createBody.Status !== 'success') {
      throw new ShareFailedError('Radicale map/create did not report success')
    }
  }

  const targetPathOrToken = existingPathOrToken ?? pathOrToken

  if (existingPathOrToken) {
    const update = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        PathOrToken: existingPathOrToken,
        Permissions: permissions,
        ...(properties ? { Properties: properties } : {}),
      }),
    })
    if (!update.ok) {
      throw new ShareFailedError(`Radicale map/update failed: ${update.status}`)
    }
  }

  for (const action of ['enable', 'unhide']) {
    const res = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ PathOrToken: targetPathOrToken }),
    })
    if (!res.ok) {
      // Only clean up if this call is what created the map entry -- if we
      // reused an existing (e.g. previously-unsubscribed) entry, it was
      // already in some valid state before we touched it, so leave it
      // alone rather than deleting a share that predates this request.
      if (!existingPathOrToken) {
        await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/delete`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ PathOrToken: targetPathOrToken }),
        }).catch(() => {})
      }
      throw new ShareFailedError(`Radicale map/${action} failed: ${res.status}`)
    }
  }

  return { mechanism: 'radicale-map', pending: true }
}

interface CsUserEntry {
  // xml-js's compact mode keys elements by their literal tag name as sent
  // on the wire -- Baikal declares DAV: under the `d:` prefix (not as a
  // default namespace), so this is genuinely `d:href`, not `href`.
  'd:href'?: { _text?: string }
  'cs:invite-accepted'?: unknown
  'cs:invite-invalid'?: unknown
  // Per the calendarserver-sharing draft, each cs:user entry carries its
  // own <cs:access><cs:read-write/></cs:access> (or <cs:read/>) block --
  // Spike-tested against Baikal 0.11.1. The owner is listed too, as a
  // `cs:user` with an empty `<cs:access/>` (xml-js: `{}`) -- see
  // parseBaikalInvite().
  'cs:access'?: Record<string, unknown>
}

/**
 * Parses a `cs:invite` PROPFIND body into the real recipients. Baikal lists
 * the calendar's owner as a `cs:user` too (principal href, empty
 * `<cs:access/>`) once anything is shared; that's not a share, and handing
 * its token to update/revoke would silently no-op. Entries Baikal couldn't
 * resolve (`cs:invite-invalid`) are returned as-is: shareCalendar() needs to
 * see them to report the failure, listings filter them out.
 */
export function parseBaikalInvite(xml: string): CsUserEntry[] {
  const parsed = xml2js(xml, { compact: true, ignoreDeclaration: true }) as Record<string, unknown>
  const invite = findCsInvite(parsed)
  if (!invite) return []
  const users = ([] as CsUserEntry[]).concat((invite as { 'cs:user'?: CsUserEntry | CsUserEntry[] })['cs:user'] ?? [])
  return users.filter((u) => u['cs:access'] && Object.keys(u['cs:access']).length > 0)
}

function baikalPermissionFor(entry: CsUserEntry): 'read' | 'readwrite' {
  const access = entry['cs:access']
  if (access && typeof access === 'object' && 'cs:read-write' in access) return 'readwrite'
  return 'read'
}

/**
 * Tries the Apple calendarserver-sharing draft (`cs:share` POST), which
 * Baikal 0.11.1 has wired in unconditionally (see AGENTS.md "Calendar
 * sharing" for how this differs from older Baikal releases). Unlike
 * Radicale, a share here auto-accepts immediately with no separate
 * recipient action (`pending: false`) -- but Baikal returns `200 OK` even
 * when the recipient can't be resolved at all (confirmed by spike-testing:
 * an unmatched `mailto:` address silently produces an
 * `INVITE_INVALID`-status entry with no error response), so this always
 * re-fetches `cs:invite` afterward and checks the entry's actual status
 * rather than trusting the POST's status code.
 */
async function tryBaikalShare(
  ctx: DavContext,
  calendarUrl: string,
  input: ShareCalendarInput,
): Promise<ShareCalendarResult> {
  const href = input.recipient.startsWith('mailto:') ? input.recipient : `mailto:${input.recipient}`
  const accessTag = input.permission === 'readwrite' ? '<cs:read-write/>' : '<cs:read/>'

  const shareRes = await davFetch(ctx, calendarUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<cs:share xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <cs:set>
    <d:href>${escapeXml(href)}</d:href>
    <cs:common-name>${escapeXml(input.recipient)}</cs:common-name>
    ${accessTag}
  </cs:set>
</cs:share>`,
  })
  if (!shareRes.ok) {
    throw new ShareFailedError(`Baikal cs:share POST failed: ${shareRes.status}`)
  }

  const verifyRes = await davFetch(ctx, calendarUrl, {
    method: 'PROPFIND',
    headers: { 'Content-Type': 'application/xml', Depth: '0' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:invite/></d:prop></d:propfind>',
  })
  if (!verifyRes.ok) {
    throw new ShareFailedError(`Could not verify share: PROPFIND failed with ${verifyRes.status}`)
  }
  const users = parseBaikalInvite(await verifyRes.text())
  const entry = users.find((u) => u['d:href']?._text === href)

  if (!entry || 'cs:invite-invalid' in entry) {
    throw new ShareFailedError(
      `Could not resolve recipient "${input.recipient}" -- make sure this matches their registered email address exactly.`,
    )
  }

  return { mechanism: 'baikal-caldav-sharing', pending: false }
}

function findCsInvite(node: unknown): unknown {
  if (!node || typeof node !== 'object') return undefined
  const obj = node as Record<string, unknown>
  if ('cs:invite' in obj) return obj['cs:invite']
  for (const value of Object.values(obj)) {
    const found = findCsInvite(value)
    if (found) return found
  }
  return undefined
}

export async function shareCalendar(
  ctx: DavContext,
  calendarUrl: string,
  input: ShareCalendarInput,
): Promise<ShareCalendarResult> {
  try {
    return await tryRadicaleShare(ctx, calendarUrl, input)
  } catch (radicaleErr) {
    try {
      return await tryBaikalShare(ctx, calendarUrl, input)
    } catch (baikalErr) {
      const radicaleMsg = radicaleErr instanceof Error ? radicaleErr.message : String(radicaleErr)
      const baikalMsg = baikalErr instanceof Error ? baikalErr.message : String(baikalErr)
      throw new ShareFailedError(
        `Sharing failed. This server may not support sharing, or the recipient could not be resolved. ` +
          `(Radicale attempt: ${radicaleMsg}; Baikal attempt: ${baikalMsg})`,
      )
    }
  }
}

/**
 * Radicale map-shared calendars are otherwise indistinguishable from
 * normally-owned ones -- confirmed by spike-testing: a mapped calendar's
 * `resourcetype` is identical to an owned one (`<C:calendar/><collection/>`,
 * no `cs:shared` equivalent Baikal has). The only way to know a discovered
 * calendar is actually a share-to-me is to cross-reference it against
 * Radicale's own sharing API, so this fetches every map where the current
 * user is the recipient (`User`) and returns the set of *mounted*
 * (`PathOrToken`) pathnames those shares appear at -- fetchCalendars()
 * returns each calendar's URL as it's mounted under the current user's own
 * principal, not the owner's real underlying (`PathMapped`) collection
 * path, so `PathOrToken` is the one that actually matches (confirmed by
 * testing: comparing against `PathMapped` matched nothing at all).
 *
 * Best-effort: a server with no sharing support at all (or sharing
 * disabled) will fail this call in some server-specific way -- treated as
 * "no Radicale shares" rather than failing calendar discovery outright.
 */
export interface RadicaleMapEntry {
  User?: string
  Owner?: string
  PathOrToken?: string
  PathMapped?: string
  Permissions?: string
  EnabledByUser?: boolean
  HiddenByUser?: boolean
  TimestampUpdated?: number
  Properties?: Record<string, string> | null
}

async function fetchRadicaleMapList(ctx: DavContext): Promise<RadicaleMapEntry[]> {
  try {
    const res = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    })
    if (!res.ok) return []
    const body = (await res.json().catch(() => null)) as { Content?: RadicaleMapEntry[] } | null
    return body?.Content ?? []
  } catch {
    return []
  }
}

/**
 * Cleans up any Radicale map shares the current user owns that point at
 * `pathMapped` -- meant to be called right after the underlying collection
 * itself is deleted (`DavCalendarStore.deleteCalendar`). Without this, the
 * share row survives the collection it points to: `sharing_collection_by_map_resolver`
 * never checks that `PathMapped` still exists, so the recipient's
 * `/.sharing/v1/map/list` keeps returning it, and since it's still
 * `EnabledByUser` from before, `listPendingRadicaleShares` shows it as a
 * legitimate-looking pending invite for a calendar that no longer exists
 * (confirmed by hitting exactly this after deleting a calendar that had
 * been shared out during testing). Best-effort/fails-open, same spirit as
 * `listRadicaleSharedPaths` -- the calendar is already gone by the time
 * this runs, so a failure here is a hygiene issue, not a correctness one.
 */
/**
 * Keeps a calendar's stashed display-name overlay (see tryRadicaleShare's
 * doc comment) in sync when the owner renames it after already sharing it
 * out -- otherwise a recipient's pending-shares list keeps showing the
 * name it had *at share time* forever, since Radicale only stores this as
 * a point-in-time copy on the share record, not a live reference. Called
 * from DavCalendarStore.updateCalendar right after a successful PROPPATCH.
 * Best-effort/fails-open: a rename shouldn't fail just because this
 * bookkeeping call did.
 *
 * A recipient who renames the shared calendar for themselves writes into this
 * same record (verified against Radicale), so a share is only touched while
 * its stashed name is still the owner's `previousName` (or was never set) --
 * anything else is the recipient's own name and must survive the rename.
 */
export function shareNameFollowsOwner(entry: RadicaleMapEntry, previousName: string | null): boolean {
  const stashed = entry.Properties?.['D:displayname']
  return stashed === undefined || stashed === null || (previousName !== null && stashed === previousName)
}

export async function syncShareDisplayNames(
  ctx: DavContext,
  pathMapped: string,
  displayName: string,
  previousName: string | null,
): Promise<void> {
  const entries = await fetchRadicaleMapList(ctx)
  const owned = entries.filter(
    (e) => e.Owner === ctx.username && e.PathMapped === pathMapped && e.PathOrToken && shareNameFollowsOwner(e, previousName),
  )
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  for (const entry of owned) {
    try {
      await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/update`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ PathOrToken: entry.PathOrToken, Properties: { 'D:displayname': displayName } }),
      })
    } catch {
      // best-effort, see doc comment above
    }
  }
}

export async function deleteRadicaleSharesForPath(ctx: DavContext, pathMapped: string): Promise<void> {
  const entries = await fetchRadicaleMapList(ctx)
  const owned = entries.filter((e) => e.Owner === ctx.username && e.PathMapped === pathMapped && e.PathOrToken)
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  for (const entry of owned) {
    try {
      await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ PathOrToken: entry.PathOrToken }),
      })
    } catch {
      // best-effort, see doc comment above
    }
  }
}

/**
 * Fetches every share the current user, as owner, has created for
 * `calendarUrl` -- the symmetric counterpart to listPendingRadicaleShares
 * (that's the recipient's view of an unaccepted share; this is the
 * owner's view of everything they've shared out, accepted or not).
 * `token` is base64url-encoded (via encodeId, reused from idCodec.ts to
 * avoid a route param containing raw slashes) and must be passed back
 * verbatim to updateSharePermission/revokeShare.
 */
export async function listSharesForCalendar(ctx: DavContext, calendarUrl: string): Promise<OwnedShare[]> {
  const path = new URL(calendarUrl).pathname

  const radicaleEntries = await fetchRadicaleMapList(ctx)
  const radicaleShares: OwnedShare[] = radicaleEntries
    .filter((e) => e.Owner === ctx.username && e.PathMapped === path && e.User && e.PathOrToken)
    .map((e) => ({
      recipient: e.User!,
      permission: e.Permissions === 'r' ? 'read' : 'readwrite',
      accepted: Boolean(e.EnabledByUser && !e.HiddenByUser),
      mechanism: 'radicale-map',
      token: encodeId(e.PathOrToken!),
    }))

  let baikalShares: OwnedShare[] = []
  try {
    const res = await davFetch(ctx, calendarUrl, {
      method: 'PROPFIND',
      headers: { 'Content-Type': 'application/xml', Depth: '0' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:invite/></d:prop></d:propfind>',
    })
    if (res.ok) {
      baikalShares = parseBaikalInvite(await res.text())
        .filter((u) => !('cs:invite-invalid' in u) && u['d:href']?._text)
        .map((u) => ({
          recipient: (u['d:href']!._text as string).replace(/^mailto:/, ''),
          permission: baikalPermissionFor(u),
          accepted: true, // Baikal shares auto-accept, no separate acceptance step
          mechanism: 'baikal-caldav-sharing' as const,
          token: encodeId(u['d:href']!._text as string),
        }))
    }
  } catch {
    // Not a Baikal (or sharing-enabled) server -- no shares to report via this mechanism.
  }

  return [...radicaleShares, ...baikalShares]
}

/**
 * Changes an existing share's permission. Which mechanism to use is
 * decided by *positively confirming* the token matches a Radicale map
 * entry this user owns first (never "try Radicale, and if it fails
 * assume Baikal") -- same lesson as unsubscribeFromCalendar's "Sixth bug,
 * CRITICAL" fix in AGENTS.md: inferring server type from a failure is not
 * a safe basis for choosing which destructive/mutating call to make.
 */
export async function updateSharePermission(
  ctx: DavContext,
  calendarUrl: string,
  token: string,
  permission: 'read' | 'readwrite',
): Promise<void> {
  const decoded = decodeId(token)
  const radicaleEntries = await fetchRadicaleMapList(ctx)
  const path = new URL(calendarUrl).pathname
  const radicaleMatch = radicaleEntries.find(
    (e) => e.Owner === ctx.username && e.PathMapped === path && e.PathOrToken === decoded,
  )

  if (radicaleMatch) {
    const res = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ PathOrToken: decoded, Permissions: permission === 'readwrite' ? 'rw' : 'r' }),
    })
    if (!res.ok) throw new ShareFailedError(`Radicale map/update failed: ${res.status}`)
    return
  }

  // Not a confirmed Radicale share -- treat as a Baikal mailto href and
  // re-invite with a different access tag (spike-tested: Baikal 0.11.1
  // updates the accepted recipient's access in place).
  const accessTag = permission === 'readwrite' ? '<cs:read-write/>' : '<cs:read/>'
  const res = await davFetch(ctx, calendarUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<cs:share xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <cs:set>
    <d:href>${escapeXml(decoded)}</d:href>
    ${accessTag}
  </cs:set>
</cs:share>`,
  })
  if (!res.ok) {
    throw new ShareFailedError(`Could not update share permission: cs:share POST failed with ${res.status}`)
  }
}

/**
 * Revokes an existing share. Same positive-confirmation-first decision
 * process as updateSharePermission above.
 */
export async function revokeShare(ctx: DavContext, calendarUrl: string, token: string): Promise<void> {
  const decoded = decodeId(token)
  const radicaleEntries = await fetchRadicaleMapList(ctx)
  const path = new URL(calendarUrl).pathname
  const radicaleMatch = radicaleEntries.find(
    (e) => e.Owner === ctx.username && e.PathMapped === path && e.PathOrToken === decoded,
  )

  if (radicaleMatch) {
    const res = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ PathOrToken: decoded }),
    })
    if (!res.ok) throw new ShareFailedError(`Radicale map/delete failed: ${res.status}`)
    return
  }

  // Not a confirmed Radicale share -- treat as a Baikal mailto href and
  // send the sharing draft's <cs:remove> block (spike-tested against Baikal
  // 0.11.1). Surfaces a ShareFailedError on any non-2xx.
  const res = await davFetch(ctx, calendarUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<cs:share xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <cs:remove>
    <d:href>${escapeXml(decoded)}</d:href>
  </cs:remove>
</cs:share>`,
  })
  if (!res.ok) {
    throw new ShareFailedError(`Could not revoke share: cs:share POST failed with ${res.status}`)
  }
}

export async function listRadicaleSharedPaths(ctx: DavContext): Promise<Set<string>> {
  const entries = await fetchRadicaleMapList(ctx)
  return new Set(
    entries.filter((entry) => entry.User === ctx.username && entry.PathOrToken).map((entry) => entry.PathOrToken!),
  )
}

function findDisplayName(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>
  // Radicale's own PROPFIND responses use an unprefixed default `xmlns="DAV:"`
  // (unlike Baikal, which prefixes it `d:`) -- this function is Radicale-only,
  // but checks both forms defensively.
  for (const key of ['displayname', 'd:displayname']) {
    const value = obj[key]
    if (value && typeof value === 'object' && '_text' in (value as Record<string, unknown>)) {
      const text = (value as { _text?: unknown })._text
      if (typeof text === 'string' && text) return text
    }
  }
  for (const value of Object.values(obj)) {
    const found = findDisplayName(value)
    if (found) return found
  }
  return null
}

/**
 * A pending share's `PathMapped` is a raw collection path, not the owner's
 * calendar's actual display name -- for calendars this app created itself
 * (`CreateCalendar`'s collection slug is a random UUID, not a readable
 * name), the fallback label derived from that path would show a UID
 * instead of something meaningful. Confirmed by testing that a direct
 * `PROPFIND` on the share's own `PathOrToken` returns the real
 * `displayname` even *before* the recipient has accepted the share (i.e.
 * while still hidden) -- so this fetches it proactively instead of
 * settling for the path-derived guess. Best-effort per share: any
 * failure just falls back to the path guess, same fails-open spirit as
 * the rest of this file.
 */
async function fetchShareDisplayName(ctx: DavContext, pathOrToken: string): Promise<string | null> {
  try {
    const res = await davFetch(ctx, `${ctx.baseUrl}${pathOrToken}`, {
      method: 'PROPFIND',
      headers: { 'Content-Type': 'application/xml', Depth: '0' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>',
    })
    if (!res.ok) return null
    const xml = await res.text()
    const parsed = xml2js(xml, { compact: true, ignoreDeclaration: true }) as Record<string, unknown>
    return findDisplayName(parsed)
  } catch {
    return null
  }
}

/**
 * Radicale shares where the current user is the recipient but hasn't yet
 * called `enable`+`unhide` on their own side -- "accepted" is defined as
 * both being true, matching the same dual-confirmation model documented
 * for `tryRadicaleShare`. A share the recipient explicitly re-hid after
 * accepting is treated as pending again, same as one never accepted --
 * there's no separate "declined" state in Radicale's model, only hidden
 * vs. not.
 */
// A collection's path segment is only a presentable label when it's a
// hand-typed slug (e.g. "personal"/"work") -- calendars created *through
// this app* get a `crypto.randomUUID()` slug (see DavCalendarStore.createCalendar),
// which is meaningless to show a recipient even after the owner has since
// renamed the calendar via PATCH (the collection's URL path never changes on
// rename, only its displayname property). Confirmed by testing: a share
// still hidden on the recipient's own side 404s on a direct PROPFIND against
// its PathOrToken (contrary to this file's own older assumption that this
// always works pre-acceptance -- apparently server/version/state dependent),
// so the UUID-slug fallback is genuinely reachable, not just theoretical.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function listPendingRadicaleShares(ctx: DavContext): Promise<PendingShare[]> {
  const entries = await fetchRadicaleMapList(ctx)
  const pending = entries
    .filter((entry) => entry.User === ctx.username && entry.PathOrToken)
    .filter((entry) => !(entry.EnabledByUser && !entry.HiddenByUser))

  return Promise.all(
    pending.map(async (entry) => {
      const pathSegment = entry.PathMapped?.split('/').filter(Boolean).pop()
      const pathLabel = pathSegment && !UUID_RE.test(pathSegment) ? pathSegment : null
      return {
        pathOrToken: entry.PathOrToken!,
        owner: entry.Owner ?? 'unknown',
        label:
          entry.Properties?.['D:displayname'] ??
          (await fetchShareDisplayName(ctx, entry.PathOrToken!)) ??
          pathLabel ??
          'Shared calendar',
        // Radicale reports this in unix seconds; the client compares it
        // against JS `Date.now()`-based dismissal timestamps, so convert to ms.
        updatedAt: (entry.TimestampUpdated ?? 0) * 1000,
      }
    }),
  )
}

/**
 * Recipient-side "leave this shared calendar" -- removes it from the
 * current user's own view without touching the owner's calendar or any
 * other recipient's share. Uses Radicale's map `hide` action for a
 * Radicale share (the recipient-permitted half of the toggle set --
 * confirmed by reading `radicale/sharing/__init__.py`'s POST handler:
 * when the caller is the share's `User` rather than its `Owner`,
 * `hide`/`unhide` only ever touch `HiddenByUser`, never the owner's
 * side), or a plain DAV `DELETE` on the calendar URL for Baikal --
 * confirmed by reading `CalDAV/Backend/PDO.php`'s `deleteCalendar()`: it
 * looks up the *instance's* `access` level and only wipes the real
 * collection when that's `ACCESS_SHAREDOWNER`; for a recipient's instance
 * (`ACCESS_READ`/`ACCESS_READWRITE`) it deletes just that
 * `calendarinstances` row.
 *
 * **CRITICAL, learned the hard way**: which of the two paths to use is
 * decided by *positively confirming* this is a Radicale map share the
 * current user is the recipient of (via `fetchRadicaleMapList`) -- never
 * by "try hide, and if it doesn't report success, assume it must not be
 * Radicale and fall back to DELETE." An earlier version of this function
 * did exactly that fallback, and it is **not safe**: a raw DAV `DELETE`
 * issued by the recipient against their own *mounted* Radicale map path
 * does not merely remove their own instance the way Baikal's does --
 * Radicale's map resolver transparently forwards `DELETE` to the owner's
 * real underlying collection with no additional permission check.
 * Confirmed by directly testing this exact call: `shareduser` issuing a
 * plain `DELETE` against their own mounted `/shareduser/testuser-personal/`
 * returned `200`, and the owner's real `/testuser/personal/` collection
 * was immediately, irreversibly gone (404 on a direct PROPFIND
 * afterward, no trash/undo mechanism in Radicale's filesystem storage).
 * So: if this calendar IS a Radicale map share for this user, `hide` is
 * the only path ever attempted, and any failure there throws rather than
 * falling through to `DELETE`. `DELETE` is only reached when this lookup
 * confirms the calendar is *not* a Radicale share the caller receives --
 * i.e. Baikal, or any other server with no Radicale sharing concept at
 * all (where `fetchRadicaleMapList` fails open to `[]`).
 */
export async function unsubscribeFromCalendar(ctx: DavContext, calendarUrl: string): Promise<UnsubscribeResult> {
  const path = new URL(calendarUrl).pathname
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  const radicaleShares = await fetchRadicaleMapList(ctx)
  const isRadicaleShare = radicaleShares.some((e) => e.User === ctx.username && e.PathOrToken === path)

  if (isRadicaleShare) {
    const hideRes = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/hide`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ PathOrToken: path }),
    })
    if (!hideRes.ok) {
      throw new ShareFailedError(`Radicale map/hide failed: ${hideRes.status}`)
    }
    const body = (await hideRes.json().catch(() => null)) as { Status?: string } | null
    if (body?.Status !== 'success') {
      throw new ShareFailedError('Radicale map/hide did not report success')
    }

    // Use Radicale's own TimestampUpdated for this share (re-fetched
    // post-hide), not the server process's Date.now() -- Radicale
    // computes TimestampUpdated from its host's naive local time treated
    // as UTC, which drifts from real UTC by that host's own offset.
    // Comparing it against a Date.now()-based value elsewhere (the
    // dismissal check in PendingSharesList.vue) only works if both sides
    // are on the same clock, so this fetches the fresh value from the
    // same source instead of stamping the moment with a different clock.
    const entries = await fetchRadicaleMapList(ctx)
    const updated = entries.find((e) => e.PathOrToken === path)
    const dismissedAt = updated?.TimestampUpdated ? updated.TimestampUpdated * 1000 : Date.now()
    return { dismissedPending: { pathOrToken: path, dismissedAt } }
  }

  const deleteRes = await davFetch(ctx, calendarUrl, { method: 'DELETE' })
  if (!deleteRes.ok) {
    throw new ShareFailedError(`Could not unsubscribe: DELETE failed with ${deleteRes.status}`)
  }
  return { dismissedPending: null }
}

/** Accepts a pending Radicale share by enabling+unhiding the recipient's own side. */
export async function acceptRadicaleShare(ctx: DavContext, pathOrToken: string): Promise<void> {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  for (const action of ['enable', 'unhide']) {
    const res = await davFetch(ctx, `${ctx.baseUrl}/.sharing/v1/map/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ PathOrToken: pathOrToken }),
    })
    if (!res.ok) {
      throw new ShareFailedError(`Radicale map/${action} failed: ${res.status}`)
    }
  }
}
