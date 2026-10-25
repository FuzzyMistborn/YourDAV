import type { CalendarObject, TimeRange } from '@yourdav/shared'
import { createHash } from 'node:crypto'
import Holidays from 'date-holidays'
import { expandCalendarObject } from './recurrence.js'
import { subscriptionCalendarId } from './subscription.js'

/**
 * Built-in holiday calendars: a subscription whose URL is `holidays:<ISO
 * country code>` is generated locally from the date-holidays dataset rather
 * than fetched, so it works offline and needs no third-party feed. Only
 * public and bank holidays are emitted -- the dataset's "observance" type
 * includes things like Valentine's Day.
 */
export const HOLIDAYS_PREFIX = 'holidays:'
const INCLUDED_TYPES = new Set(['public', 'bank'])

export function isHolidayUrl(url: string): boolean {
  return url.startsWith(HOLIDAYS_PREFIX)
}

export function holidayCountries(): { code: string; name: string }[] {
  const names = new Holidays().getCountries('en') as Record<string, string>
  return Object.entries(names)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function icsDate(isoDate: string): string {
  return isoDate.replaceAll('-', '')
}

function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function escapeText(value: string): string {
  return value.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n')
}

export function fetchHolidayEvents(url: string, range: TimeRange): CalendarObject[] {
  const code = url.slice(HOLIDAYS_PREFIX.length).toUpperCase()
  if (!holidayCountries().some((c) => c.code === code)) {
    throw new Error(`Unknown holiday country "${code}"`)
  }
  const hd = new Holidays(code)
  const calendarId = subscriptionCalendarId(url)

  const startYear = new Date(range.start).getUTCFullYear() - 1
  const endYear = new Date(range.end).getUTCFullYear() + 1
  const seen = new Set<string>()
  const results: CalendarObject[] = []

  for (let year = startYear; year <= endYear; year++) {
    for (const h of hd.getHolidays(year)) {
      if (!INCLUDED_TYPES.has(h.type)) continue
      const day = h.date.slice(0, 10)
      const uid = `${createHash('sha256').update(`${code}|${day}|${h.name}`).digest('hex').slice(0, 24)}@holidays`
      if (seen.has(uid)) continue
      seen.add(uid)
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//yourdav//holidays//EN',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${icsDate(day)}T000000Z`,
        `DTSTART;VALUE=DATE:${icsDate(day)}`,
        `DTEND;VALUE=DATE:${icsDate(nextDay(day))}`,
        `SUMMARY:${escapeText(h.name)}`,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')
      results.push(...expandCalendarObject(ics, calendarId, `${url}#${uid}`, 'subscription', range))
    }
  }
  return results
}
