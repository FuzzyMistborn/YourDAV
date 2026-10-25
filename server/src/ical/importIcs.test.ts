import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import { splitImportIcs, splitImportIcsCapped } from './importIcs.js'

function vcalendar(...vevents: string[]): string {
  return ['BEGIN:VCALENDAR', 'PRODID:-//test//EN', 'VERSION:2.0', ...vevents, 'END:VCALENDAR'].join('\r\n')
}

function vevent(uid: string, extra: string[] = [], recurrenceId?: string): string {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260310T150000Z',
    'DTEND:20260310T153000Z',
    'SUMMARY:Standup',
    ...(recurrenceId ? [`RECURRENCE-ID:${recurrenceId}`] : []),
    ...extra,
    'END:VEVENT',
  ].join('\r\n')
}

describe('splitImportIcs', () => {
  it('returns one group per event for a file with several independent events', () => {
    const ics = vcalendar(vevent('a'), vevent('b'), vevent('c'))
    const groups = splitImportIcs(ics)
    expect(groups).toHaveLength(3)
  })

  it('returns an empty array for a file with no VEVENTs', () => {
    expect(splitImportIcs(vcalendar())).toEqual([])
  })

  it('groups a master and its RECURRENCE-ID overrides sharing the original UID together', () => {
    const ics = vcalendar(
      vevent('series-1', ['RRULE:FREQ=WEEKLY;COUNT=3']),
      vevent('series-1', [], '20260317T150000Z'),
      vevent('other'),
    )
    const groups = splitImportIcs(ics)
    expect(groups).toHaveLength(2)
    const seriesGroup = groups.find((g) => g.includes('RRULE'))!
    expect(seriesGroup).toBeDefined()
    expect((seriesGroup.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2)
  })

  it('assigns every imported event a fresh UID, distinct from the source UID', () => {
    const ics = vcalendar(vevent('original-uid'))
    const [group] = splitImportIcs(ics)
    const comp = new ICAL.Component(ICAL.parse(group))
    const uid = comp.getFirstSubcomponent('vevent')!.getFirstPropertyValue('uid') as string
    expect(uid).not.toBe('original-uid')
    expect(uid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('carries along a referenced VTIMEZONE so a TZID stays resolvable', () => {
    const vtimezone = [
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:19701101T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'END:STANDARD',
      'END:VTIMEZONE',
    ].join('\r\n')
    const eventWithTzid = [
      'BEGIN:VEVENT',
      'UID:tz-event',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=America/New_York:20260310T150000',
      'DTEND;TZID=America/New_York:20260310T153000',
      'SUMMARY:Standup',
      'END:VEVENT',
    ].join('\r\n')
    const ics = ['BEGIN:VCALENDAR', 'PRODID:-//test//EN', 'VERSION:2.0', vtimezone, eventWithTzid, 'END:VCALENDAR'].join(
      '\r\n',
    )
    const [group] = splitImportIcs(ics)
    expect(group).toContain('BEGIN:VTIMEZONE')
    expect(group).toContain('TZID:America/New_York')
  })

  it('caps the number of imported groups at the limit and reports the skipped count', () => {
    const ics = vcalendar(...Array.from({ length: 8 }, (_, i) => vevent(`uid-${i}`)))
    const { groups, skipped } = splitImportIcsCapped(ics, 5)
    expect(groups).toHaveLength(5)
    expect(skipped).toBe(3)
    expect(splitImportIcs(ics, 5)).toHaveLength(5)
  })

  it('reports nothing skipped when under the limit', () => {
    const ics = vcalendar(vevent('a'), vevent('b'))
    expect(splitImportIcsCapped(ics, 5)).toMatchObject({ skipped: 0 })
  })
})
