import type { CalendarObject, TimeRange } from '@yourdav/shared'
import { createHash } from 'node:crypto'
import Holidays from 'date-holidays'
import { expandCalendarObject } from './recurrence.js'
import { subscriptionCalendarId } from './subscription.js'

/**
 * Built-in holiday calendars: a subscription whose URL is `holidays:<ISO
 * country code>` is generated locally from the date-holidays dataset rather
 * than fetched, so it works offline and needs no third-party feed. By default
 * only public and bank holidays are emitted; `holidays:<code>?observances`
 * also adds the dataset's "observance" type (Valentine's Day, Mother's Day,
 * Easter Sunday, ...). The dataset's "optional" type is never included.
 */
export const HOLIDAYS_PREFIX = 'holidays:'
const OBSERVANCES_FLAG = 'observances'
const BASE_TYPES = ['public', 'bank']

export function isHolidayUrl(url: string): boolean {
  return url.startsWith(HOLIDAYS_PREFIX)
}

let countryList: { code: string; name: string }[] | null = null
let countryCodes: Set<string> | null = null

export function holidayCountries(): { code: string; name: string }[] {
  if (!countryList) {
    const names = new Holidays().getCountries('en') as Record<string, string>
    countryList = Object.entries(names)
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
    countryCodes = new Set(countryList.map((c) => c.code))
  }
  return countryList
}

function isKnownCountry(code: string): boolean {
  holidayCountries()
  return countryCodes!.has(code)
}

/** True when a `holidays:` URL names a country the dataset knows. */
export function isKnownHolidayUrl(url: string): boolean {
  return isKnownCountry(parseHolidayUrl(url).code)
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

function parseHolidayUrl(url: string): { code: string; observances: boolean } {
  const [code, flag] = url.slice(HOLIDAYS_PREFIX.length).split('?')
  return { code: code.toUpperCase(), observances: flag === OBSERVANCES_FLAG }
}

export function fetchHolidayEvents(url: string, range: TimeRange): CalendarObject[] {
  const { code, observances } = parseHolidayUrl(url)
  const includedTypes = new Set(observances ? [...BASE_TYPES, 'observance'] : BASE_TYPES)
  if (!isKnownCountry(code)) {
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
      if (!includedTypes.has(h.type)) continue
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
