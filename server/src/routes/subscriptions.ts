import type { CalendarObject } from '@yourdav/shared'
import type { FastifyInstance } from 'fastify'
import { readSubscriptionsProp, SettingsUnsupportedError, writeSubscriptionsProp } from '../dav/userSettings.js'
import { holidayCountries, isHolidayUrl, isKnownHolidayUrl } from '../ical/holidays.js'
import { fetchSubscriptionEvents } from '../ical/subscription.js'
import { requireSession } from './requireSession.js'

// A feed is re-fetched and re-expanded on every view change, and the URL is
// user-supplied, so repeated identical requests are cached briefly (and
// concurrent ones share a single fetch) rather than each hitting the remote
// server and the recurrence expander.
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 100
const cache = new Map<string, { expires: number; events: Promise<CalendarObject[]> }>()

// Concurrent uncached fetches allowed per CalDAV account.
const MAX_CONCURRENT_PER_USER = 4
const inFlight = new Map<string, number>()

// Bounds the recurrence expansion a single request can demand; comfortably
// above the widest view the client asks for (year view plus padding).
const MAX_RANGE_MS = 800 * 24 * 60 * 60 * 1000

/** Test hook: forget every cached feed and in-flight count. */
export function clearSubscriptionCache(): void {
  cache.clear()
  inFlight.clear()
}

const MAX_SUBSCRIPTIONS = 100
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

interface StoredSubscription {
  id: string
  name: string
  url: string
  color: string
}

/** Strict shape check -- this is stored server-side and read back by every browser of the account. */
function validSubscriptions(value: unknown): value is StoredSubscription[] {
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIPTIONS) return false
  return value.every((s) => {
    if (!s || typeof s !== 'object') return false
    const { id, name, url, color } = s as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0 || id.length > 100) return false
    if (typeof name !== 'string' || name.length > 200) return false
    if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false
    if (typeof color !== 'string' || !COLOR_RE.test(color)) return false
    return true
  })
}

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  // The account's subscription list, stored as a property on the DAV
  // server's calendar home (see dav/userSettings.ts). `subscriptions` is
  // null when nothing has been saved there yet, so the client knows whether
  // to migrate its browser-local list.
  app.get('/', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    let raw: string | null
    try {
      raw = await readSubscriptionsProp(dav)
    } catch (err) {
      // Not "nothing saved": the client must not seed over a list it couldn't read.
      req.log.warn({ err }, 'Could not read stored subscriptions')
      return reply.code(502).send({ error: 'bad_gateway', message: 'Could not read subscriptions from the DAV server' })
    }
    if (raw === null) return reply.send({ subscriptions: null })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (validSubscriptions(parsed)) return reply.send({ subscriptions: parsed })
    // Something is stored but unusable; flag it so the client leaves it alone.
    req.log.warn('Stored subscriptions failed validation')
    return reply.send({ subscriptions: null, invalid: true })
  })

  app.put<{ Body: { subscriptions?: unknown } }>('/', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const subscriptions = req.body?.subscriptions
    if (!validSubscriptions(subscriptions)) {
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid subscriptions list' })
    }
    try {
      await writeSubscriptionsProp(dav, JSON.stringify(subscriptions))
    } catch (err) {
      if (err instanceof SettingsUnsupportedError) {
        return reply.code(501).send({ error: 'not_supported', message: 'This DAV server cannot store subscriptions' })
      }
      req.log.warn({ err }, 'Could not store subscriptions')
      return reply.code(502).send({ error: 'bad_gateway', message: 'Could not save subscriptions to the DAV server' })
    }
    return reply.code(204).send()
  })

  // Countries offered by the built-in holiday calendars (holidays:<code>).
  app.get('/holiday-countries', async (req, reply) => {
    if (!requireSession(req, reply)) return
    return reply.send(holidayCountries())
  })

  app.get<{ Querystring: { url?: string; start?: string; end?: string } }>('/events', async (req, reply) => {
    // Fetches an arbitrary user-supplied URL server-side; safeFetchExternal
    // (server/src/dav/ssrf.ts) blocks private/loopback/link-local
    // addresses (incl. cloud metadata endpoints), re-validates every
    // redirect hop, and caps the response size.
    const dav = requireSession(req, reply)
    if (!dav) return

    const { url, start, end } = req.query
    if (!url || !start || !end) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'url, start and end query params are required' })
    }
    if (Number.isNaN(new Date(start).getTime()) || Number.isNaN(new Date(end).getTime())) {
      return reply.code(400).send({ error: 'bad_request', message: 'start and end must be valid ISO dates' })
    }

    const rangeMs = new Date(end).getTime() - new Date(start).getTime()
    if (rangeMs < 0 || rangeMs > MAX_RANGE_MS) {
      return reply.code(400).send({ error: 'bad_request', message: 'start/end range is invalid or too large' })
    }

    // fetchSubscriptionEvents normalizes internally (webcal://, Google embed
    // links); this parse is only a protocol sanity check on the raw input.
    let parsed: URL
    try {
      parsed = new URL(url.replace(/^webcal:\/\//, 'https://'))
    } catch {
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid subscription URL' })
    }
    if (!isHolidayUrl(url) && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reply.code(400).send({ error: 'bad_request', message: 'Only http(s)/webcal URLs are supported' })
    }

    if (isHolidayUrl(url) && !isKnownHolidayUrl(url)) {
      return reply.code(400).send({ error: 'bad_request', message: 'Unknown holiday country' })
    }

    const now = Date.now()
    for (const [key, entry] of cache) {
      if (entry.expires <= now) cache.delete(key)
    }
    const cacheKey = JSON.stringify([url, start, end])
    let cached = cache.get(cacheKey)
    const userKey = `${dav.baseUrl}\n${dav.username}`
    const count = inFlight.get(userKey) ?? 0
    if (!cached) {
      if (count >= MAX_CONCURRENT_PER_USER) {
        return reply.code(429).send({ error: 'too_many_requests', message: 'Too many subscription requests in progress' })
      }
      inFlight.set(userKey, count + 1)
      const events = fetchSubscriptionEvents(url, { start, end }).finally(() => {
        const remaining = (inFlight.get(userKey) ?? 1) - 1
        if (remaining > 0) inFlight.set(userKey, remaining)
        else inFlight.delete(userKey)
      })
      cached = { expires: now + CACHE_TTL_MS, events }
      cache.set(cacheKey, cached)
      // Failures aren't worth caching.
      events.catch(() => {
        if (cache.get(cacheKey) === cached) cache.delete(cacheKey)
      })
      if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!)
    }

    try {
      return reply.send(await cached.events)
    } catch (err) {
      req.log.warn({ err }, 'Failed to fetch subscription feed')
      return reply.code(502).send({ error: 'bad_gateway', message: 'Could not fetch or parse the subscription feed' })
    }
  })
}
