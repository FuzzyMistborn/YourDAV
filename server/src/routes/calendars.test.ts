import type { Calendar, CalendarObject } from '@yourdav/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DavContext } from '../dav/context.js'
import { EtagConflictError } from '../store/errors.js'

process.env.SESSION_SECRET ??= 'a'.repeat(64)

const storeMock = {
  discoverCalendars: vi.fn(),
  createCalendar: vi.fn(),
  updateCalendar: vi.fn(),
  getEvents: vi.fn(),
  getRawObject: vi.fn(),
  getRawObjects: vi.fn(),
  syncCalendar: vi.fn(),
  createObject: vi.fn(),
  updateObject: vi.fn(),
  deleteObject: vi.fn(),
  deleteCalendar: vi.fn(),
  unsubscribeCalendar: vi.fn(),
}
vi.mock('../store/index.js', () => ({ store: storeMock }))

const { calendarRoutes } = await import('./calendars.js')

const dav: DavContext = { baseUrl: 'https://caldav.example.com/dav/', username: 'alice', password: 'secret' }
// base64url encoding of 'https://caldav.example.com/dav/cal1/' -- decodeId (idCodec.js) must
// round-trip to a real URL on the same host as `dav`, or route paths that call
// loadOwnedRawObject (which decodes the id and parses it as a URL) throw instead of 400/403/404ing.
const CAL_ID = Buffer.from('https://caldav.example.com/dav/cal1/', 'utf8').toString('base64url')

function calendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: CAL_ID,
    displayName: 'Personal',
    color: '#ff0000',
    readOnly: false,
    supportsEvents: true,
    supportsTasks: false,
    isShared: false,
    ctag: 'ctag-1',
    ...overrides,
  }
}

/** Builds a Fastify app with calendarRoutes mounted and a fake session -- authenticated unless authenticated:false. */
async function buildApp(opts: { authenticated?: boolean } = {}): Promise<FastifyInstance> {
  const { authenticated = true } = opts
  const app = Fastify()
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    req.session = {
      get: (key: string) => (key === 'dav' && authenticated ? dav : undefined),
      set: () => {},
      delete: () => {},
    } as never
  })
  await app.register(calendarRoutes, { prefix: '/api/calendars' })
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/calendars', () => {
  it('returns 401 when not authenticated', async () => {
    const app = await buildApp({ authenticated: false })
    const res = await app.inject({ method: 'GET', url: '/api/calendars' })
    expect(res.statusCode).toBe(401)
  })

  it('returns the discovered calendar list', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar()])
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/calendars' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([calendar()])
  })
})

describe('GET /api/calendars/:id/events', () => {
  it('requires start and end query params', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/api/calendars/${CAL_ID}/events` })
    expect(res.statusCode).toBe(400)
  })

  it('returns events for the requested range', async () => {
    const events = [{ uid: 'e1', summary: 'Standup' } as CalendarObject]
    storeMock.getEvents.mockResolvedValue(events)
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: `/api/calendars/${CAL_ID}/events?start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(events)
    expect(storeMock.getEvents).toHaveBeenCalledWith(dav, CAL_ID, {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-02-01T00:00:00.000Z',
    })
  })
})

describe('POST /api/calendars/:id/events', () => {
  const validBody = {
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
  }

  it('rejects invalid fields with 400', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar()])
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: `/api/calendars/${CAL_ID}/events`, payload: { summary: '' } })
    expect(res.statusCode).toBe(400)
    expect(storeMock.createObject).not.toHaveBeenCalled()
  })

  it('404s for an unknown calendar', async () => {
    storeMock.discoverCalendars.mockResolvedValue([])
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: `/api/calendars/${CAL_ID}/events`, payload: validBody })
    expect(res.statusCode).toBe(404)
  })

  it('403s when the calendar is read-only', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar({ readOnly: true })])
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: `/api/calendars/${CAL_ID}/events`, payload: validBody })
    expect(res.statusCode).toBe(403)
    expect(storeMock.createObject).not.toHaveBeenCalled()
  })

  it('creates the event on a writable calendar', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar()])
    storeMock.createObject.mockResolvedValue({ uid: 'new-uid', href: 'events/new-uid.ics', etag: '"e1"' })
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: `/api/calendars/${CAL_ID}/events`, payload: validBody })
    expect(res.statusCode).toBe(201)
    expect(storeMock.createObject).toHaveBeenCalledWith(dav, CAL_ID, expect.stringContaining('SUMMARY:Standup'))
  })
})

describe('POST /api/calendars/:id/events/:uid/restore', () => {
  const seriesIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:series-1',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20260310T150000Z',
    'DTEND:20260310T153000Z',
    'RRULE:FREQ=WEEKLY;COUNT=5',
    'EXDATE:20260317T150000Z',
    'SUMMARY:Standup',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('re-creates the object verbatim from the ICS snapshot', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar()])
    storeMock.createObject.mockResolvedValue({ uid: 'series-1', href: 'events/x.ics', etag: '"e1"' })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: `/api/calendars/${CAL_ID}/events/series-1/restore`,
      payload: { ics: seriesIcs },
    })
    expect(res.statusCode).toBe(201)
    expect(storeMock.createObject).toHaveBeenCalledWith(dav, CAL_ID, seriesIcs)
    const [, , ics] = storeMock.createObject.mock.calls[0] as [unknown, unknown, string]
    expect(ics).toContain('RRULE:FREQ=WEEKLY;COUNT=5')
    expect(ics).toContain('EXDATE:20260317T150000Z')
    expect(ics).toContain('UID:series-1')
  })

  it('400s on a missing or unparseable ICS body', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar()])
    const app = await buildApp()
    expect(
      (await app.inject({ method: 'POST', url: `/api/calendars/${CAL_ID}/events/x/restore`, payload: {} })).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/calendars/${CAL_ID}/events/x/restore`,
          payload: { ics: 'not an ics' },
        })
      ).statusCode,
    ).toBe(400)
    expect(storeMock.createObject).not.toHaveBeenCalled()
  })

  it('403s when the calendar is read-only', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar({ readOnly: true })])
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: `/api/calendars/${CAL_ID}/events/series-1/restore`,
      payload: { ics: seriesIcs },
    })
    expect(res.statusCode).toBe(403)
    expect(storeMock.createObject).not.toHaveBeenCalled()
  })
})

describe('PUT /api/calendars/:id/events/:uid (etag conflict)', () => {
  it('translates EtagConflictError into a 412', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar()])
    storeMock.getRawObject.mockResolvedValue({
      ics: [
        'BEGIN:VCALENDAR',
        'PRODID:-//test//EN',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:uid1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260310T150000Z',
        'DTEND:20260310T153000Z',
        'SUMMARY:Standup',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
      etag: '"stale-etag"',
    })
    storeMock.updateObject.mockRejectedValue(new EtagConflictError('stale'))
    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: `/api/calendars/${CAL_ID}/events/uid1`,
      payload: {
        href: 'events/uid1.ics',
        etag: '"stale-etag"',
        scope: 'all',
        recurrenceId: null,
        fields: {
          summary: 'Standup (edited)',
          description: null,
          location: null,
          start: '2026-03-10T16:00:00.000Z',
          end: '2026-03-10T16:30:00.000Z',
          allDay: false,
          timezone: null,
          rrule: null,
          color: null,
          alarms: [],
          rdate: [],
        },
      },
    })
    expect(res.statusCode).toBe(412)
  })
})

describe('PATCH /api/calendars/:id', () => {
  it('lets the recipient of a shared calendar rename it', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar({ isShared: true })])
    storeMock.updateCalendar.mockResolvedValue(calendar({ isShared: true, displayName: 'Mine' }))
    const app = await buildApp()
    const res = await app.inject({ method: 'PATCH', url: `/api/calendars/${CAL_ID}`, payload: { displayName: 'Mine' } })
    expect(res.statusCode).toBe(200)
    expect(storeMock.updateCalendar).toHaveBeenCalledWith(dav, CAL_ID, { displayName: 'Mine' })
  })

  it('lets the recipient of a shared calendar recolor their own copy', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar({ isShared: true })])
    storeMock.updateCalendar.mockResolvedValue(calendar({ isShared: true, color: '#00ff00' }))
    const app = await buildApp()
    const res = await app.inject({ method: 'PATCH', url: `/api/calendars/${CAL_ID}`, payload: { color: '#00ff00' } })
    expect(res.statusCode).toBe(200)
    expect(storeMock.updateCalendar).toHaveBeenCalledWith(dav, CAL_ID, { color: '#00ff00' })
  })
})

describe('DELETE /api/calendars/:id', () => {
  it('403s when trying to delete a calendar shared to (not owned by) the caller', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar({ isShared: true })])
    const app = await buildApp()
    const res = await app.inject({ method: 'DELETE', url: `/api/calendars/${CAL_ID}` })
    expect(res.statusCode).toBe(403)
    expect(storeMock.deleteCalendar).not.toHaveBeenCalled()
  })

  it('deletes an owned calendar', async () => {
    storeMock.discoverCalendars.mockResolvedValue([calendar({ isShared: false })])
    const app = await buildApp()
    const res = await app.inject({ method: 'DELETE', url: `/api/calendars/${CAL_ID}` })
    expect(res.statusCode).toBe(204)
    expect(storeMock.deleteCalendar).toHaveBeenCalledWith(dav, CAL_ID)
  })
})

describe('POST /api/calendars/:id/import', () => {
  const ics = (count: number) =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      ...Array.from({ length: count }, (_, i) => [
        'BEGIN:VEVENT',
        `UID:import-${i}`,
        'DTSTAMP:20260101T000000Z',
        `DTSTART:20260201T0${i % 10}0000Z`,
        `SUMMARY:Event ${i}`,
        'END:VEVENT',
      ]).flat(),
      'END:VCALENDAR',
      '',
    ].join('\r\n')
  const post = (app: FastifyInstance, body: string) =>
    app.inject({ method: 'POST', url: `/api/calendars/${CAL_ID}/import`, payload: { ics: body } })

  beforeEach(() => {
    storeMock.discoverCalendars.mockResolvedValue([calendar()])
    storeMock.createObject.mockResolvedValue({})
  })

  it('creates events concurrently, capped at 6 in flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    storeMock.createObject.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return {}
    })
    const app = await buildApp()
    const res = await post(app, ics(20))
    expect(res.json()).toEqual({ imported: 20, total: 20, skipped: 0 })
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(6)
  })

  it('counts a failing event without aborting the rest', async () => {
    storeMock.createObject.mockRejectedValueOnce(new Error('rejected')).mockResolvedValue({})
    const app = await buildApp()
    const res = await post(app, ics(5))
    expect(res.json()).toEqual({ imported: 4, total: 5, skipped: 0 })
    expect(storeMock.createObject).toHaveBeenCalledTimes(5)
  })
})
