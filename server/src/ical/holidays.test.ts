import { describe, expect, it } from 'vitest'
import { fetchHolidayEvents, holidayCountries, isHolidayUrl } from './holidays.js'
import { fetchSubscriptionEvents, subscriptionCalendarId } from './subscription.js'

const range2026 = { start: '2026-01-01T00:00:00.000Z', end: '2026-12-31T23:59:59.000Z' }

describe('holiday calendars', () => {
  it('recognises holidays: URLs only', () => {
    expect(isHolidayUrl('holidays:US')).toBe(true)
    expect(isHolidayUrl('https://example.com/holidays:US')).toBe(false)
  })

  it('lists countries sorted by name', () => {
    const countries = holidayCountries()
    expect(countries.find((c) => c.code === 'GB')?.name).toBe('United Kingdom')
    const names = countries.map((c) => c.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it('generates read-only all-day events for a country', () => {
    const events = fetchHolidayEvents('holidays:US', range2026)
    const xmas = events.find((e) => e.summary === 'Christmas Day')
    expect(xmas).toBeDefined()
    expect(xmas).toMatchObject({ allDay: true, etag: 'subscription', calendarId: subscriptionCalendarId('holidays:US') })
    expect(xmas!.start.slice(0, 10)).toBe('2026-12-25')
  })

  it('leaves out observances like Valentine\'s Day', () => {
    const events = fetchHolidayEvents('holidays:US', range2026)
    expect(events.some((e) => e.summary === "Valentine's Day")).toBe(false)
  })

  it('only returns events inside the requested range', () => {
    const events = fetchHolidayEvents('holidays:US', { start: '2026-12-01T00:00:00.000Z', end: '2026-12-31T00:00:00.000Z' })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.start.startsWith('2026-12'))).toBe(true)
  })

  it('accepts a lowercase code and rejects an unknown one', () => {
    expect(fetchHolidayEvents('holidays:gb', range2026).length).toBeGreaterThan(0)
    expect(() => fetchHolidayEvents('holidays:ZZ', range2026)).toThrow(/Unknown holiday country/)
  })

  it('is served through fetchSubscriptionEvents without any network fetch', async () => {
    const events = await fetchSubscriptionEvents('holidays:CA', range2026)
    expect(events.length).toBeGreaterThan(0)
  })
})
