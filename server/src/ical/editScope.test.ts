import type { EventFields } from '@yourdav/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyAll,
  applyThisAndFuture,
  applyThisOccurrence,
  deleteThisAndFuture,
  deleteThisOccurrence,
} from './editScope.js'
import { calendarObjectToIcs } from './mapper.js'
import { expandCalendarObject } from './recurrence.js'

function baseFields(overrides: Partial<EventFields> = {}): EventFields {
  return {
    summary: 'Standup',
    description: null,
    location: null,
    start: '2026-03-10T15:00:00.000Z', // Tuesday
    end: '2026-03-10T15:30:00.000Z',
    allDay: false,
    timezone: null,
    rrule: 'FREQ=WEEKLY;COUNT=6',
    color: null,
    alarms: [],
    rdate: [],
    ...overrides,
  }
}

const wideRange = { start: '2020-01-01T00:00:00.000Z', end: '2030-01-01T00:00:00.000Z' }
const expand = (ics: string) => expandCalendarObject(ics, 'cal1', 'events/test.ics', '"etag1"', wideRange)

describe('applyThisOccurrence', () => {
  it('inserts an override with the right RECURRENCE-ID and fields, and strips a client-sent RRULE', () => {
    const ics = calendarObjectToIcs('uid1', baseFields())
    const recurrenceId = '2026-03-17T15:00:00.000Z' // 2nd occurrence
    const edited = baseFields({ summary: 'Standup (moved)', rrule: 'FREQ=WEEKLY;COUNT=6' })
    const result = applyThisOccurrence(ics, recurrenceId, edited)

    // The master keeps its RRULE; only the override VEVENT must not carry one.
    expect(result.match(/RRULE/g)).toHaveLength(1)
    const occurrences = expand(result)
    expect(occurrences).toHaveLength(6)
    const moved = occurrences.find((o) => o.recurrenceId === recurrenceId)
    expect(moved?.summary).toBe('Standup (moved)')
    const others = occurrences.filter((o) => o.recurrenceId !== recurrenceId)
    expect(others.every((o) => o.summary === 'Standup')).toBe(true)
  })
})

describe('applyAll', () => {
  it('shifts the series master by the drag delta, not to the dragged occurrence', () => {
    let ics = calendarObjectToIcs('uid-shift', baseFields())
    ics = applyThisOccurrence(
      ics,
      '2026-03-24T15:00:00.000Z',
      baseFields({ summary: 'Standup (special)', start: '2026-03-24T15:00:00.000Z', end: '2026-03-24T15:30:00.000Z' }),
    )
    // Drag the 2026-03-17 occurrence one day + 1h later.
    const dragged = baseFields({ start: '2026-03-18T16:00:00.000Z', end: '2026-03-18T16:30:00.000Z' })
    const result = applyAll(ics, dragged, { days: 1, milliseconds: 3_600_000 })
    const occurrences = expand(result)
    expect(occurrences).toHaveLength(6)
    expect(occurrences[0]?.start).toBe('2026-03-11T16:00:00.000Z')
    expect(occurrences[0]?.end).toBe('2026-03-11T16:30:00.000Z')
    expect(occurrences.find((o) => o.summary === 'Standup (special)')?.start).toBe('2026-03-25T16:00:00.000Z')
  })

  it('keeps the series start and takes the new duration for a zero shift (resize)', () => {
    const ics = calendarObjectToIcs('uid-resize', baseFields())
    // Resize the 2026-03-17 occurrence from 30 to 90 minutes.
    const resized = baseFields({ start: '2026-03-17T15:00:00.000Z', end: '2026-03-17T16:30:00.000Z' })
    const occurrences = expand(applyAll(ics, resized, { days: 0, milliseconds: 0 }))
    expect(occurrences).toHaveLength(6)
    expect(occurrences[0]?.start).toBe('2026-03-10T15:00:00.000Z')
    expect(occurrences.every((o) => new Date(o.end).getTime() - new Date(o.start).getTime() === 90 * 60_000)).toBe(true)
  })

  it('shifts an all-day series by whole days', () => {
    const fields = baseFields({ allDay: true, start: '2026-03-10', end: '2026-03-11' })
    const ics = calendarObjectToIcs('uid-shift-ad', fields)
    const dragged = { ...fields, start: '2026-03-18', end: '2026-03-19' }
    const occurrences = expand(applyAll(ics, dragged, { days: 1, milliseconds: 0 }))
    expect(occurrences[0]?.start.slice(0, 10)).toBe('2026-03-11')
    expect(occurrences).toHaveLength(6)
  })

  it('rewrites the master and shifts existing overrides by the DTSTART delta', () => {
    let ics = calendarObjectToIcs('uid2', baseFields())
    ics = applyThisOccurrence(
      ics,
      '2026-03-17T15:00:00.000Z',
      baseFields({
        summary: 'Standup (special)',
        start: '2026-03-17T15:00:00.000Z',
        end: '2026-03-17T15:30:00.000Z',
      }),
    )

    // Move the whole series 2 hours later.
    const edited = baseFields({ start: '2026-03-10T17:00:00.000Z', end: '2026-03-10T17:30:00.000Z' })
    const result = applyAll(ics, edited)
    const occurrences = expand(result)
    expect(occurrences).toHaveLength(6)

    const shiftedOverride = occurrences.find((o) => o.summary === 'Standup (special)')
    expect(shiftedOverride).toBeDefined()
    // Original override instant was 2026-03-17T15:00:00Z; series moved +2h.
    expect(shiftedOverride?.start).toBe('2026-03-17T17:00:00.000Z')

    const plain = occurrences.filter((o) => o.summary === 'Standup')
    expect(plain.every((o) => o.start.endsWith('17:00:00.000Z'))).toBe(true)
  })

  it('drops overrides when the edit toggles all-day-ness', () => {
    let ics = calendarObjectToIcs('uid3', baseFields())
    ics = applyThisOccurrence(
      ics,
      '2026-03-17T15:00:00.000Z',
      baseFields({
        summary: 'Standup (special)',
        start: '2026-03-17T15:00:00.000Z',
        end: '2026-03-17T15:30:00.000Z',
      }),
    )

    const edited = baseFields({
      allDay: true,
      start: '2026-03-10T00:00:00.000Z',
      end: '2026-03-11T00:00:00.000Z',
    })
    const result = applyAll(ics, edited)
    const occurrences = expand(result)
    expect(occurrences.every((o) => o.summary === 'Standup')).toBe(true)
    expect(occurrences.every((o) => o.allDay)).toBe(true)
  })
})

describe('applyThisAndFuture', () => {
  it('truncates the original series and starts a new one at the boundary, migrating later overrides and reducing COUNT', () => {
    let ics = calendarObjectToIcs('uid4', baseFields({ rrule: 'FREQ=WEEKLY;COUNT=6' }))
    // Override on the 5th occurrence (2026-04-07), which is at/after the split boundary.
    ics = applyThisOccurrence(
      ics,
      '2026-04-07T15:00:00.000Z',
      baseFields({
        summary: 'Standup (special)',
        start: '2026-04-07T15:00:00.000Z',
        end: '2026-04-07T15:30:00.000Z',
      }),
    )

    // Split at the 4th occurrence (2026-03-31), changing the time to 17:00.
    const boundary = '2026-03-31T15:00:00.000Z'
    const edited = baseFields({
      start: '2026-03-31T17:00:00.000Z',
      end: '2026-03-31T17:30:00.000Z',
      summary: 'Standup v2',
      rrule: null, // let the carried (count-reduced) RRULE be used, as an unrelated field-only edit would
    })
    const { updatedIcs, newSeriesIcs, newUid } = applyThisAndFuture(ics, boundary, edited)

    const oldOccurrences = expand(updatedIcs)
    expect(oldOccurrences).toHaveLength(3) // occurrences 1-3 only
    expect(oldOccurrences.every((o) => o.summary === 'Standup')).toBe(true)

    const newOccurrences = expand(newSeriesIcs)
    // COUNT=6 total, 3 consumed before split -> COUNT=3 on new series.
    expect(newOccurrences).toHaveLength(3)
    expect(newOccurrences[0].summary).toBe('Standup v2')
    expect(newOccurrences[0].start).toBe('2026-03-31T17:00:00.000Z')
    expect(newOccurrences[0].uid).toBe(newUid)

    // Migrated override (originally +0 offset at 2026-04-07T15:00, series shifted +2h) now on new series.
    const migrated = newOccurrences.find((o) => o.summary === 'Standup (special)')
    expect(migrated).toBeDefined()
    expect(migrated?.start).toBe('2026-04-07T17:00:00.000Z')
    expect(migrated?.uid).toBe(newUid)
  })
})

describe('deleteThisOccurrence', () => {
  it('adds an EXDATE and removes any matching override', () => {
    let ics = calendarObjectToIcs('uid5', baseFields({ rrule: 'FREQ=WEEKLY;COUNT=4' }))
    const recurrenceId = '2026-03-17T15:00:00.000Z'
    ics = applyThisOccurrence(
      ics,
      recurrenceId,
      baseFields({ summary: 'Standup (special)', start: recurrenceId, end: '2026-03-17T15:30:00.000Z' }),
    )

    const result = deleteThisOccurrence(ics, recurrenceId)
    expect(result).toContain('EXDATE')
    const occurrences = expand(result)
    expect(occurrences).toHaveLength(3)
    expect(occurrences.some((o) => o.recurrenceId === recurrenceId)).toBe(false)
    expect(occurrences.some((o) => o.summary === 'Standup (special)')).toBe(false)
  })
})

describe('all-day recurrence IDs are server-timezone independent', () => {
  const allDayWeekly = () =>
    calendarObjectToIcs(
      'uid-allday',
      baseFields({
        allDay: true,
        start: '2026-03-10T00:00:00.000Z',
        end: '2026-03-11T00:00:00.000Z',
        rrule: 'FREQ=WEEKLY;COUNT=4',
      }),
    )

  const originalTz = process.env.TZ
  afterEach(() => {
    process.env.TZ = originalTz
  })

  // Spread of offsets: UTC, west of UTC, east of UTC, the extreme ends
  // (Niue -11, Kiritimati +14), and a sub-hour offset (Kolkata +05:30).
  for (const tz of [
    'UTC',
    'Europe/London',
    'America/New_York',
    'Pacific/Niue',
    'Pacific/Kiritimati',
    'Asia/Kolkata',
  ]) {
    it(`expands an all-day series to bare-date recurrence IDs under TZ=${tz}`, () => {
      process.env.TZ = tz
      const occ = expand(allDayWeekly())
      expect(occ.map((o) => o.recurrenceId)).toEqual([
        '2026-03-10',
        '2026-03-17',
        '2026-03-24',
        '2026-03-31',
      ])
    })

    it(`EXDATEs the intended all-day date under TZ=${tz}`, () => {
      process.env.TZ = tz
      const result = deleteThisOccurrence(allDayWeekly(), '2026-03-17')
      expect(result).toContain('EXDATE;VALUE=DATE:20260317')
      const occ = expand(result)
      expect(occ.map((o) => o.recurrenceId)).toEqual(['2026-03-10', '2026-03-24', '2026-03-31'])
    })

    it(`overrides the intended all-day occurrence under TZ=${tz}`, () => {
      process.env.TZ = tz
      const result = applyThisOccurrence(
        allDayWeekly(),
        '2026-03-17',
        baseFields({
          summary: 'Moved',
          allDay: true,
          start: '2026-03-18T00:00:00.000Z',
          end: '2026-03-19T00:00:00.000Z',
          rrule: null,
        }),
      )
      const moved = expand(result).find((o) => o.summary === 'Moved')
      expect(moved?.recurrenceId).toBe('2026-03-17')
      expect(moved?.start.slice(0, 10)).toBe('2026-03-18')
    })

    it(`accepts a legacy full-ISO recurrenceId for an all-day series under TZ=${tz}`, () => {
      process.env.TZ = tz
      // A client cached from before the bare-date change still sends the
      // occurrence as a UTC-midnight instant -- icalTimeFromIso slices the
      // date portion, so it must still match.
      const result = deleteThisOccurrence(allDayWeekly(), '2026-03-17T00:00:00.000Z')
      expect(result).toContain('EXDATE;VALUE=DATE:20260317')
      expect(expand(result).map((o) => o.recurrenceId)).toEqual(['2026-03-10', '2026-03-24', '2026-03-31'])
    })

    it(`splits an all-day series at the intended date under TZ=${tz}`, () => {
      process.env.TZ = tz
      const result = deleteThisAndFuture(allDayWeekly(), '2026-03-24')
      expect(expand(result).map((o) => o.recurrenceId)).toEqual(['2026-03-10', '2026-03-17'])
    })
  }
})

describe('deleteThisAndFuture', () => {
  it('truncates the RRULE and drops overrides at/after the boundary', () => {
    let ics = calendarObjectToIcs('uid6', baseFields({ rrule: 'FREQ=WEEKLY;COUNT=4' }))
    ics = applyThisOccurrence(
      ics,
      '2026-03-24T15:00:00.000Z',
      baseFields({
        summary: 'Standup (special)',
        start: '2026-03-24T15:00:00.000Z',
        end: '2026-03-24T15:30:00.000Z',
      }),
    )

    const result = deleteThisAndFuture(ics, '2026-03-17T15:00:00.000Z')
    const occurrences = expand(result)
    expect(occurrences).toHaveLength(1) // only the first occurrence remains
    expect(occurrences[0].start).toBe('2026-03-10T15:00:00.000Z')
  })
})
