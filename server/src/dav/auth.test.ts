import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDigestHeader,
  clearDigestChallengeCache,
  DavAuthError,
  davFetch,
  detectAuthMethod,
  parseDigestChallenge,
} from './auth.js'
import { config } from '../config.js'
import type { DavContext } from './context.js'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  clearDigestChallengeCache()
})

const digestCtx = (host: string, password = 'secret'): DavContext => ({
  baseUrl: `https://${host}/`,
  username: 'alice',
  password,
  authMethod: 'Digest',
})

const challengeRes = (nonce: string, extra = ''): Response =>
  new Response('', {
    status: 401,
    headers: { 'www-authenticate': `Digest realm="R", nonce="${nonce}", qop="auth"${extra}` },
  })

const authHeaderOf = (call: number): string =>
  new Headers(vi.mocked(fetch).mock.calls[call][1]?.headers).get('Authorization') ?? ''

describe('parseDigestChallenge', () => {
  it('parses a sabre/dav-style challenge with quoted params', () => {
    const c = parseDigestChallenge(
      'Digest realm="SabreDAV", qop="auth", nonce="abc123", opaque="zzz", algorithm=MD5',
    )
    expect(c).toEqual({ realm: 'SabreDAV', nonce: 'abc123', qop: 'auth', opaque: 'zzz', algorithm: 'MD5' })
  })

  it('takes the first qop when several are offered', () => {
    expect(parseDigestChallenge('Digest realm="r", nonce="n", qop="auth,auth-int"')?.qop).toBe('auth')
  })

  it('returns null when it is not a Digest challenge', () => {
    expect(parseDigestChallenge('Basic realm="r"')).toBeNull()
  })
})

describe('buildDigestHeader', () => {
  // RFC 2617 section 3.5 worked example.
  it('matches the RFC 2617 reference vector', () => {
    const ctx: DavContext = {
      baseUrl: 'http://host.com/',
      username: 'Mufasa',
      password: 'Circle Of Life',
      authMethod: 'Digest',
    }
    const header = buildDigestHeader(ctx, {
      method: 'GET',
      uri: '/dir/index.html',
      nc: 1,
      cnonce: '0a4f113b',
      challenge: {
        realm: 'testrealm@host.com',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        qop: 'auth',
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
      },
    })
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(header).toContain('nc=00000001')
    expect(header).toContain('uri="/dir/index.html"')
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"')
  })
})

describe('detectAuthMethod', () => {
  it('returns Digest when the server challenges with Digest only', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('', { status: 401, headers: { 'www-authenticate': 'Digest realm="x", nonce="y"' } }),
    )
    expect(await detectAuthMethod('https://baikal.example.com/dav.php/')).toBe('Digest')
  })

  it('prefers Basic when the server offers it', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } }),
    )
    expect(await detectAuthMethod('https://caldav.example.com/dav/')).toBe('Basic')
  })

  it('defaults to Basic when the server does not challenge', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 207 }))
    expect(await detectAuthMethod('https://caldav.example.com/dav/')).toBe('Basic')
  })

  it('follows a /.well-known/caldav redirect to find the Digest endpoint (Baikal behind nginx)', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/.well-known/caldav')) {
        return new Response('', { status: 302, headers: { location: '/dav.php/' } })
      }
      if (url.endsWith('/dav.php/')) {
        return new Response('', { status: 401, headers: { 'www-authenticate': 'Digest realm="BaikalDAV", nonce="n"' } })
      }
      return new Response('405', { status: 405 }) // nginx rejects PROPFIND on the bare origin
    })
    expect(await detectAuthMethod('http://192.168.50.20:8120')).toBe('Digest')
  })

  it('falls back to /.well-known/carddav when caldav is not published', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/.well-known/carddav')) {
        return new Response('', { status: 401, headers: { 'www-authenticate': 'Digest realm="x", nonce="n"' } })
      }
      return new Response('', { status: 404 })
    })
    expect(await detectAuthMethod('https://dav.example.com')).toBe('Digest')
  })
})

describe('davFetch', () => {
  it('attaches a Basic header and makes a single request for a Basic context', async () => {
    const ctx: DavContext = { baseUrl: 'https://b.example.com/', username: 'alice', password: 'secret' }
    vi.mocked(fetch).mockResolvedValue(new Response('ok', { status: 200 }))

    await davFetch(ctx, 'https://b.example.com/dav/cal/', { method: 'PROPFIND' })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Basic ' + Buffer.from('alice:secret').toString('base64'),
    )
  })

  it('performs the 401 -> challenge -> retry handshake for a Digest context', async () => {
    const ctx: DavContext = {
      baseUrl: 'https://d1.example.com/',
      username: 'alice',
      password: 'secret',
      authMethod: 'Digest',
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response('nope', {
          status: 401,
          headers: { 'www-authenticate': 'Digest realm="R", nonce="N1", qop="auth"' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await davFetch(ctx, 'https://d1.example.com/dav/cal/', {
      method: 'PROPFIND',
      body: '<propfind/>',
    })

    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
    // The challenge probe must not carry the request body.
    const [, probeInit] = vi.mocked(fetch).mock.calls[0]
    expect(probeInit?.body).toBeUndefined()
    const [, retryInit] = vi.mocked(fetch).mock.calls[1]
    expect((retryInit as { body?: unknown })?.body).toBe('<propfind/>')
    const auth = new Headers(retryInit?.headers).get('Authorization') ?? ''
    expect(auth).toMatch(/^Digest /)
    expect(auth).toContain('nc=00000001')
    expect(auth).toContain('uri="/dav/cal/"')
  })

  it('reuses the negotiated challenge with an incrementing nc, skipping the probe', async () => {
    const ctx = digestCtx('d2.example.com')
    vi.mocked(fetch)
      .mockResolvedValueOnce(challengeRes('N1')) // call A: probe
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call A: auth
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call B: cached auth
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call C: cached auth

    await davFetch(ctx, 'https://d2.example.com/a/', { method: 'PROPFIND' })
    await davFetch(ctx, 'https://d2.example.com/b/', { method: 'PROPFIND' })
    await davFetch(ctx, 'https://d2.example.com/c/', { method: 'REPORT', body: '<report/>' })

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(authHeaderOf(1)).toContain('nonce="N1"')
    expect(authHeaderOf(1)).toContain('nc=00000001')
    expect(authHeaderOf(2)).toContain('nonce="N1"')
    expect(authHeaderOf(2)).toContain('nc=00000002')
    expect(authHeaderOf(2)).toContain('uri="/b/"')
    expect(authHeaderOf(3)).toContain('nc=00000003')
    expect((vi.mocked(fetch).mock.calls[3][1] as { body?: unknown }).body).toBe('<report/>')
  })

  it('renegotiates once from the 401 when the cached nonce is refused (stale / expired)', async () => {
    const ctx = digestCtx('d5.example.com')
    vi.mocked(fetch)
      .mockResolvedValueOnce(challengeRes('N1')) // call A: probe
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call A: auth
      .mockResolvedValueOnce(challengeRes('N2', ', stale=true')) // call B: cached N1 refused
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call B: auth with N2
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call C: cached N2

    await davFetch(ctx, 'https://d5.example.com/a/', { method: 'PROPFIND' })
    const res = await davFetch(ctx, 'https://d5.example.com/b/', { method: 'PUT', body: 'ICS' })
    await davFetch(ctx, 'https://d5.example.com/c/', { method: 'PROPFIND' })

    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(authHeaderOf(2)).toContain('nonce="N1"')
    expect(authHeaderOf(3)).toContain('nonce="N2"')
    expect(authHeaderOf(3)).toContain('nc=00000001')
    expect((vi.mocked(fetch).mock.calls[3][1] as { body?: unknown }).body).toBe('ICS')
    expect(authHeaderOf(4)).toContain('nonce="N2"')
    expect(authHeaderOf(4)).toContain('nc=00000002')
  })

  it('throws DavAuthError (no retry loop) when the renegotiated challenge is refused too', async () => {
    const ctx = digestCtx('d6.example.com')
    vi.mocked(fetch)
      .mockResolvedValueOnce(challengeRes('N1')) // call A: probe
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call A: auth
      .mockResolvedValueOnce(challengeRes('N2')) // call B: cached N1 refused
      .mockResolvedValueOnce(challengeRes('N3')) // call B: N2 refused -> credentials bad
      .mockResolvedValueOnce(challengeRes('N4')) // call C: probe (cache was dropped)
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // call C: auth

    await davFetch(ctx, 'https://d6.example.com/a/', { method: 'PROPFIND' })
    await expect(davFetch(ctx, 'https://d6.example.com/b/', { method: 'PROPFIND' })).rejects.toBeInstanceOf(
      DavAuthError,
    )
    expect(fetch).toHaveBeenCalledTimes(4)

    // Nothing stale was left behind: the next call negotiates from scratch.
    await davFetch(ctx, 'https://d6.example.com/c/', { method: 'PROPFIND' })
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(new Headers(vi.mocked(fetch).mock.calls[4][1]?.headers).has('Authorization')).toBe(false)
    expect(authHeaderOf(5)).toContain('nonce="N4"')
  })

  it('never reuses a challenge across different credentials', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(challengeRes('N1')) // wrong password: probe
      .mockResolvedValueOnce(challengeRes('N2')) // wrong password: refused
      .mockResolvedValueOnce(challengeRes('N3')) // right password: probe
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // right password: auth

    await expect(
      davFetch(digestCtx('d7.example.com', 'wrong'), 'https://d7.example.com/', { method: 'PROPFIND' }),
    ).rejects.toBeInstanceOf(DavAuthError)
    const res = await davFetch(digestCtx('d7.example.com'), 'https://d7.example.com/', { method: 'PROPFIND' })

    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(new Headers(vi.mocked(fetch).mock.calls[2][1]?.headers).has('Authorization')).toBe(false)
    expect(authHeaderOf(3)).toContain('nonce="N3"')
  })

  it('keeps the cnonce fixed across reuse for -sess algorithms', async () => {
    const ctx = digestCtx('d8.example.com')
    vi.mocked(fetch)
      .mockResolvedValueOnce(challengeRes('N1', ', algorithm=MD5-sess'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    await davFetch(ctx, 'https://d8.example.com/a/', { method: 'PROPFIND' })
    await davFetch(ctx, 'https://d8.example.com/b/', { method: 'PROPFIND' })

    const cnonceOf = (h: string): string | undefined => /cnonce="([^"]+)"/.exec(h)?.[1]
    expect(cnonceOf(authHeaderOf(1))).toBeDefined()
    expect(cnonceOf(authHeaderOf(2))).toBe(cnonceOf(authHeaderOf(1)))
  })

  it('throws DavAuthError when a Basic request is rejected', async () => {
    const ctx: DavContext = { baseUrl: 'https://b2.example.com/', username: 'alice', password: 'old' }
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }))

    await expect(davFetch(ctx, 'https://b2.example.com/dav/', { method: 'PROPFIND' })).rejects.toBeInstanceOf(
      DavAuthError,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('throws DavAuthError when the authenticated Digest retry is still rejected', async () => {
    const ctx: DavContext = {
      baseUrl: 'https://d3.example.com/',
      username: 'alice',
      password: 'old',
      authMethod: 'Digest',
    }
    const challenge = (): Response =>
      new Response('', { status: 401, headers: { 'www-authenticate': 'Digest realm="R", nonce="N", qop="auth"' } })
    vi.mocked(fetch).mockResolvedValueOnce(challenge()).mockResolvedValueOnce(challenge())

    await expect(davFetch(ctx, 'https://d3.example.com/dav/', { method: 'PROPFIND' })).rejects.toBeInstanceOf(
      DavAuthError,
    )
    // One probe, one authenticated attempt -- no further retries.
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('throws DavAuthError when a Digest session gets a 401 with no Digest challenge', async () => {
    const ctx: DavContext = {
      baseUrl: 'https://d4.example.com/',
      username: 'alice',
      password: 'secret',
      authMethod: 'Digest',
    }
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('', { status: 401, headers: { 'www-authenticate': 'Basic realm="R"' } }),
    )

    await expect(
      davFetch(ctx, 'https://d4.example.com/dav/', { method: 'REPORT', body: '<report/>' }),
    ).rejects.toBeInstanceOf(DavAuthError)
  })

  it('passes non-401 failures through as responses', async () => {
    const ctx: DavContext = { baseUrl: 'https://b3.example.com/', username: 'alice', password: 'secret' }
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 403 }))

    const res = await davFetch(ctx, 'https://b3.example.com/dav/', { method: 'PROPFIND' })
    expect(res.status).toBe(403)
  })
})

describe('davFetch origin pinning', () => {
  it.each(['https://evil.example/dav/', 'http://dav.example/dav/', 'https://dav.example:8443/dav/'])(
    'refuses to send credentials to %s',
    async (target) => {
      const ctx: DavContext = { baseUrl: 'https://dav.example/', username: 'a', password: 'b', authMethod: 'Basic' }
      await expect(davFetch(ctx, target)).rejects.toThrow(/does not belong/)
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})

describe('detectAuthMethod redirect allowlisting', () => {
  it('does not probe a .well-known redirect to a host off the allowlist', async () => {
    const original = config.allowedDavHosts
    config.allowedDavHosts = ['dav.example']
    try {
      vi.mocked(fetch).mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/.well-known/caldav')) {
          return new Response('', { status: 302, headers: { location: 'https://internal.example/x/' } })
        }
        return new Response('', { status: 207 })
      })
      await detectAuthMethod('https://dav.example/')
      const urls = vi.mocked(fetch).mock.calls.map(([i]) => (i instanceof Request ? i.url : String(i as string | URL)))
      expect(urls.some((u) => u.startsWith('https://internal.example'))).toBe(false)
    } finally {
      config.allowedDavHosts = original
    }
  })
})
