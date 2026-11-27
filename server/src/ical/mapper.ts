import type { AlarmFields, CalendarObject, EventFields } from '@yourdav/shared'
import ICAL from 'ical.js'
import { ensureTimezoneRegistered, registerEmbeddedTimezones } from './timezones.js'

/**
 * Reads VALARM subcomponents back into AlarmFields. Only DISPLAY alarms
 * with a relative, before-start TRIGGER (a negative ICAL.Duration) are
 * recognized -- an absolute-datetime TRIGGER (getFirstPropertyValue
 * returns an ICAL.Time instead of a Duration in that case, confirmed by
 * spike-testing) or a positive (after-start) duration falls outside v1's
 * scope and is silently dropped, same "unsupported, not modeled" posture
 * EventEditDialog.vue already takes for exotic RRULEs it can't parse.
 */
function parseAlarms(vevent: ICAL.Component): AlarmFields[] {
  const alarms: AlarmFields[] = []
  for (const valarm of vevent.getAllSubcomponents('valarm')) {
    if (valarm.getFirstPropertyValue('action') !== 'DISPLAY') continue
    const trigger = valarm.getFirstPropertyValue('trigger') as ICAL.Duration | null
    if (!trigger || typeof trigger !== 'object' || !('isNegative' in trigger) || !trigger.isNegative) continue
    const minutesBefore = trigger.weeks * 7 * 24 * 60 + trigger.days * 24 * 60 + trigger.hours * 60 + trigger.minutes
    alarms.push({ minutesBefore })
  }
  return alarms
}

/**
 * Serializes an ICAL.Time for a CalendarObject field. An ICAL.Time with
 * isDate is a calendar date, not an instant: toJSDate().toISOString()
 * would apply the runtime's local UTC offset and can shift it to the
 * adjacent day in any non-UTC timezone. Emit date-only values as a bare
 * "YYYY-MM-DD" string and only timed values as an ISO instant.
 */
export function icalTimeToString(t: ICAL.Time): string {
  return t.isDate ? t.toString() : t.toJSDate().toISOString()
}

function parseRdates(vevent: ICAL.Component): string[] {
  // A single RDATE property may carry several comma-separated values
  // (RDATE;VALUE=DATE:20260201,20260301,20260401) -- getFirstValue() would
  // keep only the first and silently drop the rest on the next save.
  // Skip any non-DATE/DATE-TIME value (e.g. RDATE;VALUE=PERIOD): unsupported
  // elsewhere in the mapper, and icalTimeToString would throw on it.
  return vevent
    .getAllProperties('rdate')
    .flatMap((p) => p.getValues())
    .filter((v): v is ICAL.Time => v instanceof ICAL.Time)
    .map((value) => icalTimeToString(value))
}

export function buildCalendarObject(
  event: ICAL.Event,
  opts: {
    calendarId: string
    etag: string
    href: string
    start: ICAL.Time
    end: ICAL.Time
    recurrenceId: string | null
    // A per-occurrence override (RECURRENCE-ID) VEVENT never carries its
    // own RRULE (RFC 5545 forbids it), so `event.isRecurring()`/its own
    // rrule property are always false/null for one -- even though it's
    // still an occurrence of a recurring series. expandCalendarObject
    // passes the *master*'s values through here for exception occurrences
    // so the client can still tell it's part of a series (and route
    // edits/deletes through the recurrence-scope dialog instead of
    // silently treating it as a standalone event). Defaults to the
    // event's own values for the plain (non-exception) case.
    isRecurring?: boolean
    rrule?: string | null
  },
): CalendarObject {
  const rruleProp = event.component.getFirstPropertyValue('rrule') as { toString(): string } | null

  return {
    uid: event.uid,
    etag: opts.etag,
    href: opts.href,
    calendarId: opts.calendarId,
    summary: event.summary ?? '',
    description: event.description ?? null,
    location: event.location ?? null,
    start: icalTimeToString(opts.start),
    end: icalTimeToString(opts.end),
    allDay: opts.start.isDate,
    timezone: opts.start.isDate ? null : (opts.start.zone?.tzid ?? null),
    recurrenceId: opts.recurrenceId,
    isRecurring: opts.isRecurring ?? event.isRecurring(),
    rrule: opts.rrule ?? (rruleProp ? rruleProp.toString() : null),
    color: (event.component.getFirstPropertyValue('color') as string | null) ?? null,
    alarms: parseAlarms(event.component),
    rdate: parseRdates(event.component),
  }
}

/**
 * Maps a raw ICS object to its master-event view. Recurring series are
 * flagged via isRecurring/rrule but not expanded here -- expansion into
 * per-occurrence CalendarObjects happens in ical/recurrence.ts.
 */
export function icsToCalendarObject(ics: string, calendarId: string, href: string, etag: string): CalendarObject {
  const jcal = ICAL.parse(ics)
  const comp = new ICAL.Component(jcal)
  registerEmbeddedTimezones(comp)
  const vevent = comp.getFirstSubcomponent('vevent')
  if (!vevent) {
    throw new Error('ICS object has no VEVENT component')
  }

  const event = new ICAL.Event(vevent)
  return buildCalendarObject(event, {
    calendarId,
    etag,
    href,
    start: event.startDate,
    end: event.endDate,
    recurrenceId: null,
  })
}

export function buildVeventComponent(uid: string, fields: EventFields): ICAL.Component {
  const vevent = new ICAL.Component('vevent')
  const event = new ICAL.Event(vevent)

  event.uid = uid
  // Trim the title: mobile keyboards often append a space after an accepted
  // suggestion, and a trailing space in the SUMMARY line is flagged as a
  // non-standard value by some CalDAV consumers (e.g. Home Assistant's caldav
  // integration). Every write path (create, edit scopes) goes through here.
  event.summary = fields.summary.trim()
  if (fields.description) event.description = fields.description
  if (fields.location) event.location = fields.location

  if (fields.allDay) {
    // fromJSDate + isDate=true does NOT produce a proper all-day value: it
    // converts through the JS Date first (shifting across a UTC/local
    // boundary) and isDate alone doesn't truncate the retained time-of-day.
    // fromDateString builds a real DATE-typed value directly, with no
    // timezone conversion to go wrong. `fields.start`/`end` are ISO strings
    // (always YYYY-MM-DD...), so the date is just the first 10 characters.
    event.startDate = ICAL.Time.fromDateString(fields.start.slice(0, 10))
    event.endDate = ICAL.Time.fromDateString(fields.end.slice(0, 10))
  } else {
    ensureTimezoneRegistered(fields.timezone)
    const zone = fields.timezone ? ICAL.TimezoneService.get(fields.timezone) : null
    event.startDate = ICAL.Time.fromJSDate(new Date(fields.start), true)
    event.endDate = ICAL.Time.fromJSDate(new Date(fields.end), true)
    if (zone) {
      // Reassigning .zone directly does NOT convert the stored wall-clock
      // time -- it just relabels it, so a UTC time would get serialized as
      // if it were already local. convertToZone does the actual conversion.
      event.startDate = event.startDate.convertToZone(zone)
      event.endDate = event.endDate.convertToZone(zone)
    }
  }

  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now())
  if (fields.rrule) {
    vevent.updatePropertyWithValue('rrule', ICAL.Recur.fromString(fields.rrule))
  }
  if (fields.color) {
    // RFC 7986 COLOR -- a plain text value, unlike rrule, so no typed-value
    // wrapper is needed before updatePropertyWithValue.
    vevent.updatePropertyWithValue('color', fields.color)
  }

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/
  for (const iso of fields.rdate) {
    // Same value-type handling as dtstart/dtend above: a real DATE-typed
    // value for all-day events (no JS-Date/timezone round trip), a proper
    // zone-converted DATE-TIME otherwise -- addPropertyWithValue with an
    // ICAL.Time, never a raw string (RDATE has no RRULE-style
    // Recur.fromString requirement, but there's no reason to risk it).
    let rdateTime: ICAL.Time
    if (fields.allDay) {
      rdateTime = ICAL.Time.fromDateString(iso.slice(0, 10))
    } else if (dateOnly.test(iso)) {
      // A date-only (no time-of-day) RDATE for a timed event has no
      // instant to parse as a JS Date -- doing so anyway would default to
      // UTC midnight, which convertToZone then shifts to the *previous*
      // calendar day in any negative-offset timezone. Build the wall-clock
      // components directly in the event's own timezone instead, the same
      // "reassigning .zone relabels, doesn't convert" approach the master
      // dtstart/dtend construction above relies on.
      const [year, month, day] = iso.split('-').map(Number)
      rdateTime = ICAL.Time.fromData({ year, month, day, hour: 0, minute: 0, second: 0, isDate: false })
      if (fields.timezone) {
        const zone = ICAL.TimezoneService.get(fields.timezone)
        if (zone) rdateTime.zone = zone
      }
    } else {
      rdateTime = ICAL.Time.fromJSDate(new Date(iso), true)
      if (fields.timezone) {
        const zone = ICAL.TimezoneService.get(fields.timezone)
        if (zone) rdateTime = rdateTime.convertToZone(zone)
      }
    }
    // addPropertyWithValue doesn't derive TZID from the value's zone (only
    // the event.startDate/endDate setters do), so without this a zoned RDATE
    // is written as a floating local time -- other clients then place it in
    // their own zone, and it reads back here as `floating`.
    const rdate = new ICAL.Property('rdate')
    rdate.setValue(rdateTime)
    if (!rdateTime.isDate && rdateTime.zone && rdateTime.zone.tzid !== 'UTC' && rdateTime.zone.tzid !== 'floating') {
      rdate.setParameter('tzid', rdateTime.zone.tzid)
    }
    vevent.addProperty(rdate)
  }

  for (const alarm of fields.alarms) {
    const valarm = new ICAL.Component('valarm')
    valarm.updatePropertyWithValue('action', 'DISPLAY')
    // A raw duration string round-trips cleanly here (spike-tested) --
    // unlike RRULE's `Recur.fromString` requirement, TRIGGER's DURATION
    // value type serializes a plain string as-is.
    valarm.updatePropertyWithValue('trigger', `-PT${alarm.minutesBefore}M`)
    // RFC 5545 requires DESCRIPTION on a DISPLAY alarm.
    valarm.updatePropertyWithValue('description', fields.summary || 'Reminder')
    vevent.addSubcomponent(valarm)
  }

  return vevent
}

export function calendarObjectToIcs(uid: string, fields: EventFields): string {
  const comp = new ICAL.Component(['vcalendar', [], []])
  comp.updatePropertyWithValue('prodid', '-//calendar//standalone//EN')
  comp.updatePropertyWithValue('version', '2.0')
  comp.addSubcomponent(buildVeventComponent(uid, fields))
  ICAL.helpers.updateTimezones(comp)
  return comp.toString()
}
