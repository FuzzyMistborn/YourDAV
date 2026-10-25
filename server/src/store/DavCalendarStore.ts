import type {
  Calendar,
  CalendarObject,
  CreateCalendarInput,
  SyncResult,
  TimeRange,
  UnsubscribeResult,
  UpdateCalendarInput,
} from '@yourdav/shared'
import { davFetch } from '../dav/auth.js'
import { createClient } from '../dav/client.js'
import type { DavContext } from '../dav/context.js'
import { assertHrefSameHost } from '../dav/hostAllowlist.js'
import { isCollectionReadOnly } from '../dav/privileges.js'
import {
  deleteRadicaleSharesForPath,
  escapeXml,
  listRadicaleSharedPaths,
  ShareFailedError,
  fetchCalendarDisplayName,
  syncShareDisplayNames,
  unsubscribeFromCalendar,
} from '../dav/sharing.js'
import { icsToCalendarObject } from '../ical/mapper.js'
import { expandCalendarObject } from '../ical/recurrence.js'
import type { CalendarStore, ObjectRef, RawObject, RawObjectWithHref } from './CalendarStore.js'
import { EtagConflictError } from './errors.js'
import { decodeId, encodeId } from './idCodec.js'

export class DavCalendarStore implements CalendarStore {
  async discoverCalendars(ctx: DavContext): Promise<Calendar[]> {
    const client = await createClient(ctx)
    const davCalendars = await client.fetchCalendars()

    // Radicale shares are otherwise indistinguishable from owned calendars
    // (see listRadicaleSharedPaths's doc comment) -- cross-reference against
    // Radicale's own sharing API once per discovery call. Best-effort: an
    // empty set just means "no Radicale shares" (including on servers with
    // no sharing support at all, e.g. plain Baikal).
    const radicaleSharedPaths = await listRadicaleSharedPaths(ctx)
    const eventCalendars = davCalendars.filter((cal) => cal.components?.includes('VEVENT') ?? true)

    // current-user-privilege-set (RFC 3744) has to be fetched with one
    // PROPFIND per calendar -- tsdav's fetchCalendars() has no way to
    // include it in the batched PROPFIND it already does. Run these in
    // parallel rather than serially awaiting each one.
    const readOnlyFlags = await Promise.all(eventCalendars.map((cal) => isCollectionReadOnly(ctx, String(cal.url))))

    return eventCalendars.map((cal, i) => {
      // Baikal marks a calendar shared *to* the current user with a
      // `cs:shared` resourcetype child (vs. `cs:shared-owner` on a
      // calendar they own) -- tsdav strips the `cs:` prefix and
      // camelCases it to `shared`. Confirmed via real PROPFIND against
      // Baikal; Radicale never sets this, hence the separate map lookup.
      const resourcetypes: string[] = Array.isArray(cal.resourcetype) ? cal.resourcetype : []
      const isBaikalShared = resourcetypes.includes('shared')
      const isRadicaleShared = radicaleSharedPaths.has(new URL(String(cal.url)).pathname)

      return {
        id: encodeId(String(cal.url)),
        displayName: typeof cal.displayName === 'string' ? cal.displayName : 'Untitled',
        // Some servers (confirmed: Baikal, when no color was ever explicitly
        // set on a calendar) return calendar-color as a genuinely empty XML
        // element, which tsdav's XML parser turns into `{ _attributes: {...} }`
        // rather than an empty string -- truthy, so `??` alone doesn't catch
        // it. Radicale always returns a real color string, which is why this
        // wasn't caught until testing against real Baikal.
        color: typeof cal.calendarColor === 'string' && cal.calendarColor ? cal.calendarColor : '#0082c9',
        readOnly: readOnlyFlags[i],
        supportsEvents: cal.components?.includes('VEVENT') ?? true,
        supportsTasks: cal.components?.includes('VTODO') ?? false,
        ctag: cal.ctag ?? null,
        isShared: isBaikalShared || isRadicaleShared,
      }
    })
  }

  async createCalendar(ctx: DavContext, input: CreateCalendarInput): Promise<Calendar> {
    const client = await createClient(ctx)
    const homeUrl = client.account?.homeUrl
    if (!homeUrl) {
      throw new Error('CalDAV account has no calendar-home-set URL')
    }

    const color = input.color ?? '#0082c9'
    const url = new URL(`${crypto.randomUUID()}/`, homeUrl.endsWith('/') ? homeUrl : `${homeUrl}/`).toString()

    const responses = await client.makeCalendar({
      url,
      props: {
        'd:displayname': input.displayName,
        'c:supported-calendar-component-set': {
          'c:comp': { _attributes: { name: 'VEVENT' } },
        },
        'ca:calendar-color': color,
      },
    })
    const failed = responses.find((r) => !r.ok)
    if (failed) {
      throw new Error(`Failed to create calendar: ${failed.status} ${failed.statusText}`)
    }

    return {
      id: encodeId(url),
      displayName: input.displayName,
      color,
      readOnly: false,
      supportsEvents: true,
      supportsTasks: false,
      ctag: null,
      isShared: false,
    }
  }

  async updateCalendar(ctx: DavContext, calendarId: string, input: UpdateCalendarInput): Promise<Calendar> {
    const url = decodeId(calendarId)
    assertHrefSameHost(ctx.baseUrl, url)

    // No tsdav helper exists for PROPPATCH -- hand-rolled the same way
    // sharing.ts's raw DAV calls are, since tsdav only wraps discovery/CRUD.
    const setProps: string[] = []
    if (input.displayName !== undefined) {
      setProps.push(`<d:displayname>${escapeXml(input.displayName)}</d:displayname>`)
    }
    if (input.color !== undefined) {
      setProps.push(`<ca:calendar-color xmlns:ca="http://apple.com/ns/ical/">${escapeXml(input.color)}</ca:calendar-color>`)
    }
    if (setProps.length === 0) {
      const existing = (await this.discoverCalendars(ctx)).find((c) => c.id === calendarId)
      if (!existing) throw new Error(`Calendar not found: ${calendarId}`)
      return existing
    }

    // Read before the PROPPATCH below overwrites it: syncShareDisplayNames
    // needs it to tell shares still following this name from recipient renames.
    const previousName = input.displayName !== undefined ? await fetchCalendarDisplayName(ctx, url) : null

    const response = await davFetch(ctx, url, {
      method: 'PROPPATCH',
      headers: { 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:">
  <d:set>
    <d:prop>
      ${setProps.join('\n      ')}
    </d:prop>
  </d:set>
</d:propertyupdate>`,
    })
    if (!response.ok) {
      throw new ShareFailedError(`Failed to update calendar: ${response.status} ${response.statusText}`)
    }
    // A 207 multistatus can still report a per-property failure (e.g. 403 on
    // calendar-color if the server doesn't support it) even though the
    // overall response is 2xx -- coarse check is enough here, matching the
    // error-shape convention already used for delete/share failures in this
    // file rather than fully parsing the multistatus body.
    const body = await response.text()
    if (/<[^>]*status[^>]*>[^<]*\b(4\d\d|5\d\d)\b/i.test(body)) {
      throw new ShareFailedError('Server rejected one or more calendar properties')
    }

    if (input.displayName !== undefined) {
      // Best-effort: keeps any existing Radicale shares' stashed display
      // name (see sharing.ts's tryRadicaleShare) in sync with the rename.
      await syncShareDisplayNames(ctx, new URL(url).pathname, input.displayName, previousName)
    }

    const updated = (await this.discoverCalendars(ctx)).find((c) => c.id === calendarId)
    if (!updated) throw new Error(`Calendar not found after update: ${calendarId}`)
    return updated
  }

  async getEvents(ctx: DavContext, calendarId: string, range: TimeRange): Promise<CalendarObject[]> {
    const client = await createClient(ctx)
    const url = decodeId(calendarId)
    assertHrefSameHost(ctx.baseUrl, url)

    const objects = await client.fetchCalendarObjects({
      calendar: { url },
      timeRange: { start: range.start, end: range.end },
    })

    const results: CalendarObject[] = []
    for (const obj of objects) {
      if (!obj.data || !obj.etag) continue
      try {
        results.push(...expandCalendarObject(obj.data, calendarId, obj.url, obj.etag, range))
      } catch {
        // Skip objects we can't parse (e.g. VTODO-only) rather than fail the whole range.
        continue
      }
    }
    return results
  }

  async getRawObject(ctx: DavContext, href: string): Promise<RawObject> {
    assertHrefSameHost(ctx.baseUrl, href)
    const client = await createClient(ctx)
    // The calendar url itself is unused by fetchCalendarObjects when objectUrls
    // is given, but the param shape requires one; any valid collection url works.
    const objects = await client.fetchCalendarObjects({
      calendar: { url: href },
      objectUrls: [href],
    })
    const [obj] = objects
    if (!obj?.data || !obj.etag) {
      throw new Error(`Calendar object not found: ${href}`)
    }
    return { ics: obj.data, etag: obj.etag }
  }

  async getRawObjects(ctx: DavContext, hrefs: string[]): Promise<RawObjectWithHref[]> {
    if (hrefs.length === 0) return []
    for (const href of hrefs) assertHrefSameHost(ctx.baseUrl, href)
    const client = await createClient(ctx)
    // Same "any href works as the collection url when objectUrls is given"
    // shape as getRawObject, just batched into a single multiget.
    const objects = await client.fetchCalendarObjects({
      calendar: { url: hrefs[0] },
      objectUrls: hrefs,
    })
    return objects
      .filter((obj): obj is typeof obj & { data: string; etag: string } => Boolean(obj.data && obj.etag))
      .map((obj) => ({ href: obj.url, ics: obj.data, etag: obj.etag }))
  }

  async syncCalendar(ctx: DavContext, calendarId: string, syncToken?: string): Promise<SyncResult> {
    const client = await createClient(ctx)
    const url = decodeId(calendarId)
    assertHrefSameHost(ctx.baseUrl, url)

    const result = await client.smartCollectionSync({
      // objectMultiGet is required by tsdav's webdav-sync path whenever the
      // sync-collection REPORT reports changed hrefs -- it only returns
      // hrefs+etags, not full ICS, so tsdav needs a way to fetch the
      // bodies. Confirmed required by testing against real Radicale (threw
      // "collection.objectMultiGet is required for webdav sync changes"
      // without this).
      collection: { url, syncToken, objectMultiGet: client.calendarMultiGet.bind(client) },
      method: 'webdav',
      detailedResult: true,
    })

    const changed: CalendarObject[] = []
    const deletedHrefs: string[] = []
    for (const obj of result.objects.created) {
      if (obj.data && obj.etag) changed.push(icsToCalendarObject(obj.data, calendarId, obj.url, obj.etag))
    }
    for (const obj of result.objects.updated) {
      if (obj.data && obj.etag) changed.push(icsToCalendarObject(obj.data, calendarId, obj.url, obj.etag))
    }
    for (const obj of result.objects.deleted) {
      deletedHrefs.push(obj.url)
    }

    return {
      syncToken: result.syncToken ?? '',
      changed,
      deletedHrefs,
    }
  }

  async createObject(ctx: DavContext, calendarId: string, ics: string): Promise<CalendarObject> {
    const client = await createClient(ctx)
    const url = decodeId(calendarId)
    assertHrefSameHost(ctx.baseUrl, url)
    const filename = `${crypto.randomUUID()}.ics`

    const response = await client.createCalendarObject({
      calendar: { url },
      filename,
      iCalString: ics,
    })
    if (!response.ok) {
      throw new Error(`Failed to create calendar object: ${response.status} ${response.statusText}`)
    }

    const href = new URL(filename, url.endsWith('/') ? url : `${url}/`).toString()
    const etag = response.headers.get('etag') ?? ''
    return icsToCalendarObject(ics, calendarId, href, etag)
  }

  async updateObject(ctx: DavContext, obj: ObjectRef, ics: string): Promise<CalendarObject> {
    assertHrefSameHost(ctx.baseUrl, obj.href)
    const client = await createClient(ctx)

    const response = await client.updateCalendarObject({
      calendarObject: { url: obj.href, data: ics, etag: obj.etag },
      headers: { 'If-Match': obj.etag },
    })
    if (response.status === 412) {
      throw new EtagConflictError('Calendar object changed since it was last read')
    }
    if (!response.ok) {
      throw new Error(`Failed to update calendar object: ${response.status} ${response.statusText}`)
    }

    const etag = response.headers.get('etag') ?? obj.etag
    return icsToCalendarObject(ics, obj.calendarId, obj.href, etag)
  }

  async deleteObject(ctx: DavContext, obj: ObjectRef): Promise<void> {
    assertHrefSameHost(ctx.baseUrl, obj.href)
    const client = await createClient(ctx)
    const response = await client.deleteCalendarObject({
      calendarObject: { url: obj.href, etag: obj.etag },
      headers: { 'If-Match': obj.etag },
    })
    if (response.status === 412) {
      throw new EtagConflictError('Calendar object changed since it was last read')
    }
    if (!response.ok) {
      throw new Error(`Failed to delete calendar object: ${response.status} ${response.statusText}`)
    }
  }

  async deleteCalendar(ctx: DavContext, calendarId: string): Promise<void> {
    const url = decodeId(calendarId)
    assertHrefSameHost(ctx.baseUrl, url)
    const response = await davFetch(ctx, url, { method: 'DELETE' })
    if (!response.ok) {
      // ShareFailedError (not a plain Error) so the route's error handler
      // can return a clean 422 instead of an opaque 500 -- this is the
      // one place a delete can fail for a reason worth describing to the
      // caller (e.g. the DAV server rejecting it), same as share/unsubscribe.
      throw new ShareFailedError(`Failed to delete calendar: ${response.status} ${response.statusText}`)
    }
    // Best-effort: also remove any Radicale map shares that pointed at this
    // collection, so a recipient doesn't see a dangling "pending" invite
    // for a calendar that no longer exists. No Baikal equivalent needed --
    // Baikal's own deleteCalendar already wipes every calendarinstances row
    // (including shared ones) in the same DELETE.
    await deleteRadicaleSharesForPath(ctx, new URL(url).pathname)
  }

  async unsubscribeCalendar(ctx: DavContext, calendarId: string): Promise<UnsubscribeResult> {
    const url = decodeId(calendarId)
    assertHrefSameHost(ctx.baseUrl, url)
    return unsubscribeFromCalendar(ctx, url)
  }
}
