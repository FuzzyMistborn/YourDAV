import type { CalendarObject } from '@yourdav/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DavContext } from '../dav/context.js'

process.env.SESSION_SECRET ??= 'a'.repeat(64)

const fetchSubscriptionEvents = vi.fn()
vi.mock('../ical/subscription.js', () => ({
  fetchSubscriptionEvents: (...args: unknown[]) => fetchSubscriptionEvents(...args),
}))

const readSubscriptionsProp = vi.fn()
const writeSubscriptionsProp = vi.fn()
class SettingsUnsupportedError extends Error {}
vi.mock('../dav/userSettings.js', () => ({
  readSubscriptionsProp: (...args: unknown[]) => readSubscriptionsProp(...args),
  writeSubscriptionsProp: (...args: unknown[]) => writeSubscriptionsProp(...args),
  SettingsUnsupportedError,
}))

const { subscriptionRoutes, clearSubscriptionCache } = await import('./subscriptions.js')

const dav: DavContext = { baseUrl: 'https://caldav.example.com/dav/', username: 'alice', password: 'secret' }

async function buildApp(opts: { authenticated?: boolean } = {}): Promise<FastifyInstance> {
  const { authenticated = true } = opts
  const app = Fastify()
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    req.session = { get: (key: string) => (key === 'dav' && authenticated ? dav : undefined) } as never
  })
  await app.register(subscriptionRoutes, { prefix: '/api/subscriptions' })
  return app
}

const validQuery = 'url=https%3A%2F%2Fexample.com%2Ffeed.ics&start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z'

beforeEach(() => {
  vi.clearAllMocks()
  clearSubscriptionCache()
})

describe('GET /api/subscriptions/events', () => {
  it('401s when unauthenticated', async () => {
    const app = await buildApp({ authenticated: false })
    const res = await app.inject({ method: 'GET', url: `/api/subscriptions/events?${validQuery}` })
    expect(res.statusCode).toBe(401)
  })

  it('400s when url/start/end are missing', async () => {
    const app = await buildApp()
    expect((await app.inject({ method: 'GET', url: '/api/subscriptions/events' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/subscriptions/events?url=https://example.com/feed.ics' })).statusCode).toBe(400)
  })

  it('400s on an unparseable URL', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/events?url=not-a-url&start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(400)
  })

  it('400s on a non-http(s)/webcal protocol', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/subscriptions/events?url=ftp%3A%2F%2Fexample.com%2Ffeed.ics&start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(400)
    expect(fetchSubscriptionEvents).not.toHaveBeenCalled()
  })

  it('accepts a webcal:// URL', async () => {
    fetchSubscriptionEvents.mockResolvedValue([])
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url:
        '/api/subscriptions/events?url=webcal%3A%2F%2Fexample.com%2Ffeed.ics&start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(200)
  })

  it('returns fetched events on success', async () => {
    const events = [{ uid: 'e1', summary: 'Feed Event' } as CalendarObject]
    fetchSubscriptionEvents.mockResolvedValue(events)
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/api/subscriptions/events?${validQuery}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(events)
    expect(fetchSubscriptionEvents).toHaveBeenCalledWith('https://example.com/feed.ics', {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-02-01T00:00:00.000Z',
    })
  })

  it('502s when fetching/parsing the feed fails', async () => {
    fetchSubscriptionEvents.mockRejectedValue(new Error('feed unreachable'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: `/api/subscriptions/events?${validQuery}` })
    expect(res.statusCode).toBe(502)
  })

  it('serves a repeated identical request from cache', async () => {
    fetchSubscriptionEvents.mockResolvedValue([])
    const app = await buildApp()
    await app.inject({ method: 'GET', url: `/api/subscriptions/events?${validQuery}` })
    await app.inject({ method: 'GET', url: `/api/subscriptions/events?${validQuery}` })
    expect(fetchSubscriptionEvents).toHaveBeenCalledTimes(1)
  })

  it('does not cache failures', async () => {
    fetchSubscriptionEvents.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([])
    const app = await buildApp()
    expect((await app.inject({ method: 'GET', url: `/api/subscriptions/events?${validQuery}` })).statusCode).toBe(502)
    expect((await app.inject({ method: 'GET', url: `/api/subscriptions/events?${validQuery}` })).statusCode).toBe(200)
  })

  it('400s when the range is reversed or too large', async () => {
    const app = await buildApp()
    const base = 'url=https%3A%2F%2Fexample.com%2Ffeed.ics'
    const tooBig = await app.inject({
      method: 'GET',
      url: `/api/subscriptions/events?${base}&start=2020-01-01T00:00:00.000Z&end=2030-01-01T00:00:00.000Z`,
    })
    const reversed = await app.inject({
      method: 'GET',
      url: `/api/subscriptions/events?${base}&start=2026-02-01T00:00:00.000Z&end=2026-01-01T00:00:00.000Z`,
    })
    expect(tooBig.statusCode).toBe(400)
    expect(reversed.statusCode).toBe(400)
    expect(fetchSubscriptionEvents).not.toHaveBeenCalled()
  })

  it('429s when one account has too many uncached fetches in flight', async () => {
    fetchSubscriptionEvents.mockReturnValue(new Promise(() => {}))
    const app = await buildApp()
    const base = 'start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z'
    for (let i = 0; i < 4; i++) {
      void app.inject({ method: 'GET', url: `/api/subscriptions/events?url=https%3A%2F%2Fexample.com%2F${i}.ics&${base}` })
    }
    await new Promise((r) => setTimeout(r, 50))
    const res = await app.inject({ method: 'GET', url: `/api/subscriptions/events?url=https%3A%2F%2Fexample.com%2Fx.ics&${base}` })
    expect(res.statusCode).toBe(429)
  })
})

describe('stored subscription list (GET/PUT /api/subscriptions)', () => {
  const sub = { id: 'a', name: 'Sonarr', url: 'https://example.com/feed.ics', color: '#8e5fd4' }

  it('401s when unauthenticated', async () => {
    const app = await buildApp({ authenticated: false })
    expect((await app.inject({ method: 'GET', url: '/api/subscriptions' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: '/api/subscriptions', payload: { subscriptions: [] } })).statusCode).toBe(401)
  })

  it('returns the stored list', async () => {
    readSubscriptionsProp.mockResolvedValue(JSON.stringify([sub]))
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/subscriptions' })
    expect(res.json()).toEqual({ subscriptions: [sub] })
  })

  it('returns null when nothing is stored, unparseable, or malformed', async () => {
    const app = await buildApp()
    for (const raw of [null, 'not json', JSON.stringify([{ id: 1 }])]) {
      readSubscriptionsProp.mockResolvedValue(raw)
      expect((await app.inject({ method: 'GET', url: '/api/subscriptions' })).json()).toEqual({ subscriptions: null })
    }
  })

  it('stores a valid list', async () => {
    writeSubscriptionsProp.mockResolvedValue(undefined)
    const res = await (await buildApp()).inject({ method: 'PUT', url: '/api/subscriptions', payload: { subscriptions: [sub] } })
    expect(res.statusCode).toBe(204)
    expect(writeSubscriptionsProp).toHaveBeenCalledWith(dav, JSON.stringify([sub]))
  })

  it('400s on malformed entries and over-long lists', async () => {
    const app = await buildApp()
    for (const subscriptions of [
      [{ ...sub, color: 'red' }],
      [{ ...sub, url: '' }],
      [{ ...sub, name: 5 }],
      'nope',
      Array.from({ length: 101 }, (_, i) => ({ ...sub, id: String(i) })),
    ]) {
      const res = await app.inject({ method: 'PUT', url: '/api/subscriptions', payload: { subscriptions } })
      expect(res.statusCode).toBe(400)
    }
    expect(writeSubscriptionsProp).not.toHaveBeenCalled()
  })

  it('501s when the DAV server cannot store the property', async () => {
    writeSubscriptionsProp.mockRejectedValue(new SettingsUnsupportedError('no'))
    const res = await (await buildApp()).inject({ method: 'PUT', url: '/api/subscriptions', payload: { subscriptions: [sub] } })
    expect(res.statusCode).toBe(501)
  })
})

describe('holiday calendars over HTTP', () => {
  it('lists the countries', async () => {
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/subscriptions/holiday-countries' })
    expect(res.statusCode).toBe(200)
    expect(res.json().some((c: { code: string }) => c.code === 'US')).toBe(true)
  })

  it('401s the country list when unauthenticated', async () => {
    const res = await (await buildApp({ authenticated: false })).inject({ method: 'GET', url: '/api/subscriptions/holiday-countries' })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a holidays: URL for events (not rejected as a non-http protocol)', async () => {
    fetchSubscriptionEvents.mockResolvedValue([])
    const res = await (await buildApp()).inject({
      method: 'GET',
      url: '/api/subscriptions/events?url=holidays%3AUS&start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(200)
    expect(fetchSubscriptionEvents).toHaveBeenCalledWith('holidays:US', expect.anything())
  })
})
