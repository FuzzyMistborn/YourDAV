import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.fn()
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookup(...args) }))

type Responder = (url: URL, opts: { lookup: unknown; signal: AbortSignal }) => Readable | Error
const responders: Responder[] = []
const requested: URL[] = []

function fakeRequest(url: URL, opts: { lookup: unknown; signal: AbortSignal }, cb: (res: Readable) => void) {
  const req = new EventEmitter() as EventEmitter & { end: () => void }
  req.end = () => {
    requested.push(url)
    const result = responders.shift()?.(url, opts)
    if (result instanceof Error) setImmediate(() => req.emit('error', result))
    else if (result) setImmediate(() => cb(result))
  }
  return req
}
vi.mock('node:https', () => ({ default: { request: fakeRequest } }))
vi.mock('node:http', () => ({ default: { request: fakeRequest } }))

const { safeFetchExternal, guardedLookup, BlockedUrlError } = await import('./ssrf.js')

function respond(body: string, status = 200, headers: Record<string, string> = {}): Responder {
  return () =>
    Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, statusMessage: '', headers })
}

function redirect(location: string): Responder {
  return respond('', 302, { location })
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]

beforeEach(() => {
  lookup.mockReset()
  responders.length = 0
  requested.length = 0
})

describe('safeFetchExternal', () => {
  it('fetches a public URL successfully', async () => {
    responders.push(respond('hello'))
    const result = await safeFetchExternal('https://example.com/feed.ics')
    expect(result.text).toBe('hello')
  })

  it('connects through the guarded lookup', async () => {
    responders.push((_url, opts) => {
      expect(opts.lookup).toBe(guardedLookup)
      return respond('ok')(_url, opts)
    })
    await safeFetchExternal('https://example.com/feed.ics')
  })

  it('rejects an unsupported protocol', async () => {
    await expect(safeFetchExternal('ftp://example.com/feed.ics')).rejects.toThrow(BlockedUrlError)
  })

  it('rejects a literal loopback IP', async () => {
    await expect(safeFetchExternal('http://127.0.0.1/feed.ics')).rejects.toThrow(BlockedUrlError)
    expect(requested).toHaveLength(0)
  })

  it('rejects a literal private IP', async () => {
    await expect(safeFetchExternal('http://192.168.1.1/feed.ics')).rejects.toThrow(BlockedUrlError)
  })

  it('rejects a bracketed IPv6 loopback literal', async () => {
    await expect(safeFetchExternal('http://[::1]/feed.ics')).rejects.toThrow(BlockedUrlError)
  })

  it('rejects the cloud metadata link-local address', async () => {
    await expect(safeFetchExternal('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(BlockedUrlError)
  })

  it('re-validates the destination of a redirect rather than trusting it', async () => {
    responders.push(redirect('http://169.254.169.254/latest/meta-data/'))
    await expect(safeFetchExternal('https://example.com/feed.ics')).rejects.toThrow(BlockedUrlError)
    expect(requested).toHaveLength(1)
  })

  it('follows a redirect to a public host and returns its body', async () => {
    responders.push(redirect('https://example.com/final.ics'), respond('final content'))
    const result = await safeFetchExternal('https://example.com/feed.ics')
    expect(result.text).toBe('final content')
  })

  it('gives up after too many redirects', async () => {
    for (let i = 0; i < 10; i++) responders.push(redirect('https://example.com/again.ics'))
    await expect(safeFetchExternal('https://example.com/feed.ics')).rejects.toThrow(/redirects/)
  })

  it('rejects a response over the size cap via Content-Length', async () => {
    responders.push(respond('x', 200, { 'content-length': String(10 * 1024 * 1024) }))
    await expect(safeFetchExternal('https://example.com/feed.ics')).rejects.toThrow(BlockedUrlError)
  })

  it('rejects a body that exceeds the size cap while streaming', async () => {
    responders.push(respond('x'.repeat(6 * 1024 * 1024)))
    await expect(safeFetchExternal('https://example.com/feed.ics')).rejects.toThrow(BlockedUrlError)
  })

  it('rejects a non-ok response', async () => {
    responders.push(respond('nope', 500))
    await expect(safeFetchExternal('https://example.com/feed.ics')).rejects.toThrow(/500/)
  })

  it('passes an abort signal so a stalled server times out', async () => {
    responders.push((_url, opts) => {
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      return respond('ok')(_url, opts)
    })
    await safeFetchExternal('https://example.com/feed.ics')
  })
})

describe('guardedLookup', () => {
  function run(hostname: string, options: { all?: boolean } = {}) {
    return new Promise<{ err: Error | null; result: unknown; family?: number }>((resolve) => {
      guardedLookup(hostname, options, ((err: Error | null, result: unknown, family?: number) =>
        resolve({ err, result, family })) as never)
    })
  }

  it('returns a validated public address', async () => {
    lookup.mockResolvedValue(PUBLIC)
    expect(await run('example.com')).toMatchObject({ err: null, result: '93.184.216.34', family: 4 })
  })

  it('returns the full list when asked for all addresses', async () => {
    lookup.mockResolvedValue(PUBLIC)
    expect((await run('example.com', { all: true })).result).toEqual(PUBLIC)
  })

  it('rejects a hostname that resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    expect((await run('internal.example.com')).err).toBeInstanceOf(BlockedUrlError)
  })

  it('rejects when any one of several addresses is private', async () => {
    lookup.mockResolvedValue([...PUBLIC, { address: '127.0.0.1', family: 4 }])
    expect((await run('mixed.example.com')).err).toBeInstanceOf(BlockedUrlError)
  })

  it('rejects "localhost" outright', async () => {
    expect((await run('localhost')).err).toBeInstanceOf(BlockedUrlError)
  })

  it('rejects a hostname that fails to resolve', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'))
    expect((await run('nonexistent.invalid')).err).toBeInstanceOf(BlockedUrlError)
  })
})

describe('ALLOWED_SUBSCRIPTION_PRIVATE_HOSTS', () => {
  it('lets an allowlisted host resolve to a private address', async () => {
    const { config } = await import('../config.js')
    config.allowedSubscriptionPrivateHosts = ['sonarr.lan']
    try {
      lookup.mockResolvedValue([{ address: '192.168.50.10', family: 4 }])
      await expect(
        new Promise((resolve, reject) =>
          guardedLookup('sonarr.lan', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))),
        ),
      ).resolves.toBeTruthy()
      await expect(
        new Promise((resolve, reject) =>
          guardedLookup('other.lan', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))),
        ),
      ).rejects.toThrow(BlockedUrlError)
    } finally {
      config.allowedSubscriptionPrivateHosts = []
    }
  })
})

describe('ALLOW_PRIVATE_SUBSCRIPTIONS', () => {
  it('allows LAN addresses but still blocks loopback and link-local', async () => {
    const { config } = await import('../config.js')
    config.allowPrivateSubscriptions = true
    try {
      responders.push(respond('lan ok'))
      await expect(safeFetchExternal('http://192.168.50.10/feed.ics')).resolves.toEqual({ text: 'lan ok' })
      await expect(safeFetchExternal('http://127.0.0.1/feed.ics')).rejects.toThrow(BlockedUrlError)
      await expect(safeFetchExternal('http://169.254.169.254/latest/')).rejects.toThrow(BlockedUrlError)
      lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
      await expect(
        new Promise((resolve, reject) =>
          guardedLookup('evil.example', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))),
        ),
      ).rejects.toThrow(BlockedUrlError)
    } finally {
      config.allowPrivateSubscriptions = false
    }
  })
})
