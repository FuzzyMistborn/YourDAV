import type { CalendarObject, TimeRange } from '@yourdav/shared'
import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import { safeFetchExternal } from '../dav/ssrf.js'
import { fetchHolidayEvents, isHolidayUrl } from './holidays.js'
import { expandCalendarObject } from './recurrence.js'
import { registerEmbeddedTimezones } from './timezones.js'

// Bounds how much work a single feed can force onto the server -- an
// unbounded or malicious feed could otherwise contain enough VEVENTs to
// make expansion (recurrence.ts's own MAX_ITERATIONS is per-event, not
// per-feed) expensive across the whole request.
const MAX_SUBSCRIPTION_EVENTS = 2000

/**
 * Canonicalises a subscription URL before it's fetched or hashed into a
 * synthetic calendar id:
 *  - webcal:// -> https://
 *  - a Google Calendar "embed" link (calendar.google.com/calendar/embed?src=...,
 *    which serves an HTML page and 404/401s when fetched as ICS) is rewritten
 *    to its real iCal export URL.
 * Anything already in ical form, or from another host, is returned unchanged.
 */
export function normalizeUrl(url: string): string {
  const https = url.startsWith('webcal://') ? `https://${url.slice('webcal://'.length)}` : url

  let parsed: URL
  try {
    parsed = new URL(https)
  } catch {
    return https
  }

  const host = parsed.hostname.toLowerCase()
  const isGoogle = host === 'calendar.google.com' || host === 'www.google.com'
  if (isGoogle && /\/calendar\/embed\/?$/.test(parsed.pathname)) {
    const src = parsed.searchParams.get('src')
    if (src) {
      return `https://calendar.google.com/calendar/ical/${encodeURIComponent(src)}/public/basic.ics`
    }
  }

  return https
}

export function subscriptionCalendarId(url: string): string {
  return `sub:${createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 16)}`
}

/**
 * Fetches and parses a read-only external ICS/WebCal feed -- not a CalDAV
 * collection, just a static (or semi-static) document some other calendar
 * publishes. No etags exist for this kind of resource, so a constant
 * placeholder is used; these events are never written back anywhere.
 */
export async function fetchSubscriptionEvents(url: string, range: TimeRange): Promise<CalendarObject[]> {
  // Built-in holiday calendars (`holidays:US`) are generated, not fetched.
  if (isHolidayUrl(url)) return fetchHolidayEvents(url, range)
  const normalized = normalizeUrl(url)
  const { text } = await safeFetchExternal(normalized, { headers: { Accept: 'text/calendar' } })
  const calendarId = subscriptionCalendarId(url)

  const comp = new ICAL.Component(ICAL.parse(text))
  // The per-UID VCALENDARs built below carry the VEVENTs but not the feed's
  // VTIMEZONE components, so any TZID they reference (DTSTART;TZID=...)
  // would otherwise be unresolvable -- registering them globally here,
  // before expandCalendarObject re-parses each split-out ICS on its own,
  // means the zone is already known by the time it's looked up. Same fix
  // as importIcs.ts, but via global registration rather than carrying the
  // VTIMEZONE along, since these per-event ICS strings are only ever used
  // transiently within this function.
  registerEmbeddedTimezones(comp)
  const vevents = comp.getAllSubcomponents('vevent').slice(0, MAX_SUBSCRIPTION_EVENTS)

  const groups = new Map<string, ICAL.Component[]>()
  for (const vevent of vevents) {
    const uid = vevent.getFirstPropertyValue('uid') as string | null
    if (!uid) continue
    const group = groups.get(uid) ?? []
    group.push(vevent)
    groups.set(uid, group)
  }

  const results: CalendarObject[] = []
  for (const [uid, components] of groups) {
    const eventCal = new ICAL.Component(['vcalendar', [], []])
    eventCal.updatePropertyWithValue('prodid', '-//calendar//standalone//EN')
    eventCal.updatePropertyWithValue('version', '2.0')
    for (const vevent of components) eventCal.addSubcomponent(vevent)

    try {
      results.push(...expandCalendarObject(eventCal.toString(), calendarId, `${normalized}#${uid}`, 'subscription', range))
    } catch {
      continue
    }
  }
  return results
}
