import type { EventFields } from '@yourdav/shared'
import { describe, expect, it } from 'vitest'
import { calendarObjectToIcs, icsToCalendarObject } from './mapper.js'

function baseFields(overrides: Partial<EventFields> = {}): EventFields {
  return {
    summary: 'Standup',
    description: null,
    location: null,
    start: '2026-03-10T15:00:00.000Z',
    end: '2026-03-10T15:30:00.000Z',
    allDay: false,
    timezone: null,
    rrule: null,
    color: null,
    alarms: [],
    rdate: [],
    ...overrides,
  }
}

function roundTrip(fields: EventFields) {
  const ics = calendarObjectToIcs('test-uid', fields)
  return icsToCalendarObject(ics, 'cal1', 'events/test-uid.ics', '"etag1"')
}

describe('mapper round-trip', () => {
  it('preserves a plain timed event', () => {
    const fields = baseFields({ summary: 'Standup', description: 'Daily sync', location: 'Room A' })
    const obj = roundTrip(fields)
    expect(obj.summary).toBe('Standup')
    expect(obj.description).toBe('Daily sync')
    expect(obj.location).toBe('Room A')
    expect(obj.allDay).toBe(false)
    expect(new Date(obj.start).toISOString()).toBe(fields.start)
    expect(new Date(obj.end).toISOString()).toBe(fields.end)
  })

  it('trims leading and trailing whitespace from the title', () => {
    const ics = calendarObjectToIcs('test-uid', baseFields({ summary: '  Dentiste   ' }))
    expect(ics).toMatch(/^SUMMARY:Dentiste\r?$/m)
    expect(roundTrip(baseFields({ summary: 'Dentiste ' })).summary).toBe('Dentiste')
  })

  it('preserves an all-day event across its exact calendar date', () => {
    const fields = baseFields({
      allDay: true,
      start: '2026-03-10T00:00:00.000Z',
      end: '2026-03-11T00:00:00.000Z',
    })
    const obj = roundTrip(fields)
    expect(obj.allDay).toBe(true)
    expect(obj.start.slice(0, 10)).toBe('2026-03-10')
    expect(obj.end.slice(0, 10)).toBe('2026-03-11')
  })

  it('preserves an IANA timezone', () => {
    const fields = baseFields({ timezone: 'America/New_York' })
    const obj = roundTrip(fields)
    expect(obj.timezone).toBe('America/New_York')
  })

  it('preserves an RRULE', () => {
    const fields = baseFields({ rrule: 'FREQ=WEEKLY;COUNT=6' })
    const obj = roundTrip(fields)
    expect(obj.isRecurring).toBe(true)
    expect(obj.rrule).toContain('FREQ=WEEKLY')
    expect(obj.rrule).toContain('COUNT=6')
  })

  it('preserves alarms (VALARM round-trip)', () => {
    const fields = baseFields({ alarms: [{ minutesBefore: 15 }, { minutesBefore: 60 }] })
    const obj = roundTrip(fields)
    expect(obj.alarms).toHaveLength(2)
    expect(obj.alarms.map((a) => a.minutesBefore).sort((a, b) => a - b)).toEqual([15, 60])
  })

  it('preserves RDATEs for a timed event', () => {
    const fields = baseFields({
      rrule: 'FREQ=WEEKLY;COUNT=3',
      rdate: ['2026-04-01T15:00:00.000Z'],
    })
    const obj = roundTrip(fields)
    expect(obj.rdate).toHaveLength(1)
    expect(new Date(obj.rdate[0]).toISOString()).toBe('2026-04-01T15:00:00.000Z')
  })

  it('writes a zoned RDATE with a TZID instead of a floating time', () => {
    const fields = baseFields({
      timezone: 'America/New_York',
      start: '2026-03-10T13:00:00.000Z',
      end: '2026-03-10T14:00:00.000Z',
      rrule: 'FREQ=MONTHLY;COUNT=3',
      rdate: ['2026-03-20T13:00:00.000Z'],
    })
    const ics = calendarObjectToIcs('test-uid', fields)
    expect(ics).toMatch(/^RDATE;TZID=America\/New_York:20260320T090000$/m)
    const obj = roundTrip(fields)
    expect(new Date(obj.rdate[0]).toISOString()).toBe('2026-03-20T13:00:00.000Z')
  })

  it('preserves RDATEs for an all-day event', () => {
    const fields = baseFields({
      allDay: true,
      start: '2026-03-10T00:00:00.000Z',
      end: '2026-03-11T00:00:00.000Z',
      rrule: 'FREQ=WEEKLY;COUNT=3',
      rdate: ['2026-04-01'],
    })
    const obj = roundTrip(fields)
    expect(obj.rdate).toHaveLength(1)
    expect(obj.rdate[0].slice(0, 10)).toBe('2026-04-01')
  })

  it('flattens multiple values carried in a single RDATE property', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:multi-rdate',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260101',
      'DTEND;VALUE=DATE:20260102',
      'RRULE:FREQ=YEARLY;COUNT=2',
      'RDATE;VALUE=DATE:20260201,20260301,20260401',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const obj = icsToCalendarObject(ics, 'cal1', 'events/multi-rdate.ics', '"etag1"')
    expect(obj.rdate.map((d) => d.slice(0, 10))).toEqual(['2026-02-01', '2026-03-01', '2026-04-01'])
  })

  it('ignores an unsupported RDATE;VALUE=PERIOD instead of throwing', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:period-rdate',
      'DTSTAMP:20260101T000000Z',
      'DTSTART:20260101T100000Z',
      'DTEND:20260101T110000Z',
      'RDATE;VALUE=PERIOD:20260201T100000Z/20260201T110000Z',
      'RDATE:20260301T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const obj = icsToCalendarObject(ics, 'cal1', 'events/period-rdate.ics', '"etag1"')
    expect(obj.rdate).toEqual(['2026-03-01T10:00:00.000Z'])
  })

  it('preserves color', () => {
    const fields = baseFields({ color: '#ff0000' })
    const obj = roundTrip(fields)
    expect(obj.color).toBe('#ff0000')
  })
})
