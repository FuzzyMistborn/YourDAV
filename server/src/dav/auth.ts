import { createHash, randomBytes } from 'node:crypto'
import type { DavContext } from './context.js'
import { assertHostAllowed, assertHrefSameHost } from './hostAllowlist.js'
import { withTimeout } from './timeout.js'

export type AuthMethod = 'Basic' | 'Digest'

/**
 * The DAV server answered an authenticated request with 401: the stored
 * credentials no longer work (password changed, account disabled, auth
 * scheme switched). Thrown from davFetch so every caller -- tsdav and the
 * raw sharing/PROPPATCH fetches alike -- fails the same way, and the error
 * handler turns it into an app-level 401 that ends the session.
 */
export class DavAuthError extends Error {
  constructor() {
    super('The DAV server rejected the stored credentials')
    this.name = 'DavAuthError'
  }
}

async function rejectIfUnauthorized(res: Response): Promise<Response> {
  if (res.status !== 401) return res
  await res.body?.cancel().catch(() => {})
  throw new DavAuthError()
}

export function basicAuthHeader(ctx: DavContext): Record<string, string> {
  return { Authorization: 'Basic ' + Buffer.from(`${ctx.username}:${ctx.password}`).toString('base64') }
}

// --- Digest (RFC 2617 / RFC 7616) -------------------------------------------

interface DigestChallenge {
  realm: string
  nonce: string
  qop?: string
  opaque?: string
  algorithm?: string
}

export function parseDigestChallenge(headerValue: string): DigestChallenge | null {
  const match = /^\s*Digest\s+(.*)$/is.exec(headerValue)
  if (!match) return null
  const params: Record<string, string> = {}
  const re = /([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(match[1])) !== null) {
    params[m[1].toLowerCase()] = m[2] ?? m[3]?.trim() ?? ''
  }
  if (!params.realm || !params.nonce) return null
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop ? params.qop.split(',')[0].trim() : undefined,
    opaque: params.opaque,
    algorithm: params.algorithm,
  }
}

function hashFor(algorithm: string | undefined): (input: string) => string {
  const algo = (algorithm ?? 'MD5').toUpperCase()
  const name = algo.startsWith('SHA-256') ? 'sha256' : 'md5'
  return (input: string) => createHash(name).update(input).digest('hex')
}

function formatNc(nc: number): string {
  return nc.toString(16).padStart(8, '0')
}

export function buildDigestHeader(
  ctx: DavContext,
  opts: { method: string; uri: string; challenge: DigestChallenge; nc: number; cnonce: string },
): string {
  const { method, uri, challenge, nc, cnonce } = opts
  const H = hashFor(challenge.algorithm)
  const sess = (challenge.algorithm ?? '').toUpperCase().endsWith('-SESS')

  let ha1 = H(`${ctx.username}:${challenge.realm}:${ctx.password}`)
  if (sess) ha1 = H(`${ha1}:${challenge.nonce}:${cnonce}`)
  const ha2 = H(`${method.toUpperCase()}:${uri}`)

  const ncHex = formatNc(nc)
  const response = challenge.qop
    ? H(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${challenge.qop}:${ha2}`)
    : H(`${ha1}:${challenge.nonce}:${ha2}`)

  const parts = [
    `username="${ctx.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ]
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`)
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`)
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`)
  return `Digest ${parts.join(', ')}`
}

// --- Scheme detection & the shared request wrapper -------------------------

/**
 * Sends unauthenticated PROPFINDs and reads the `WWW-Authenticate` challenge
 * to decide how the app should authenticate. Baikal (and other sabre/dav
 * deployments) commonly offer only Digest; when a server advertises Basic at
 * all we prefer it (simpler, stateless). Falls back to Basic when nothing
 * challenges.
 *
 * Tries `baseUrl` as given, then -- for setups that 404/405 a PROPFIND on
 * the bare origin but publish the real endpoint via a redirect (Baikal
 * behind nginx does exactly this) -- whatever `/.well-known/caldav` (or
 * `/.well-known/carddav`) points at.
 *
 * The caller is responsible for host-allowlisting `baseUrl` first (the
 * login route does, via `assertHostAllowed`, before calling this).
 */
export async function detectAuthMethod(baseUrl: string): Promise<AuthMethod> {
  async function probe(url: string): Promise<{ status: number; wa: string; location: string | null }> {
    const res = await fetch(url, withTimeout({
      method: 'PROPFIND',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/xml', Depth: '0' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    }))
    await res.body?.cancel().catch(() => {})
    return {
      status: res.status,
      wa: res.headers.get('www-authenticate') ?? '',
      location: res.headers.get('location'),
    }
  }

  function fromChallenge(wa: string): AuthMethod {
    return /\bDigest\b/i.test(wa) && !/\bBasic\b/i.test(wa) ? 'Digest' : 'Basic'
  }

  const candidates = [baseUrl]
  // CalDAV first (the login protocol), then CardDAV for servers that only
  // publish one of the two well-known paths.
  for (const service of ['caldav', 'carddav']) {
    try {
      const wk = await probe(new URL(`/.well-known/${service}`, baseUrl).href)
      if (wk.status === 401) return fromChallenge(wk.wa)
      if (wk.status >= 300 && wk.status < 400 && wk.location) {
        const redirect = new URL(wk.location, baseUrl)
        // A redirect off the allowlist would let an allowed host steer this probe elsewhere.
        try {
          assertHostAllowed(redirect.href)
          candidates.push(redirect.href)
        } catch {
          // skip it; the baseUrl candidate is still probed
        }
        break
      }
    } catch {
      // ignore -- try the next well-known path, then the candidate list
    }
  }

  for (const url of candidates) {
    try {
      const r = await probe(url)
      if (r.status === 401) return fromChallenge(r.wa)
    } catch {
      // try the next candidate
    }
  }
  return 'Basic'
}

function targetUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function withAuthHeader(init: RequestInit | undefined, authorization: string): RequestInit {
  const headers = new Headers(init?.headers as HeadersInit | undefined)
  headers.set('Authorization', authorization)
  return { ...init, headers }
}

// A bodyless copy of the request init, used to probe for the Digest
// challenge: some servers reject or 500 an empty body, and there's no point
// sending the real body on a request we expect to be 401'd. Only used for
// methods where the body is optional (see davFetch).
function withoutBody(init: RequestInit | undefined, method: string): RequestInit {
  return { method, headers: init?.headers, redirect: 'manual', signal: init?.signal }
}

// --- Digest challenge cache ------------------------------------------------
//
// One negotiated challenge per credentials + origin, reused with an
// incrementing nonce count so a Digest request normally costs a single round
// trip instead of a 401 + retry. Keyed on the password too (hashed), so a
// challenge negotiated during a failed login can never be reused by the
// next attempt -- that leftover-nonce case is what turned an earlier
// per-origin cache into a 401 loop. Loops are also ruled out structurally:
// a refused cached challenge is dropped and renegotiated exactly once, and
// a refusal of the renegotiated one is a DavAuthError, never another retry.

interface CachedChallenge {
  challenge: DigestChallenge
  nc: number
  // Fixed for the entry's life: -sess algorithms fold it into HA1, so it
  // must not change between requests that reuse the same nonce.
  cnonce: string
  lastUsed: number
}

// Same lifetime as the cached DAVClient (dav/client.ts).
const CHALLENGE_TTL_MS = 10 * 60 * 1000
const challengeCache = new Map<string, CachedChallenge>()

setInterval(
  () => {
    const cutoff = Date.now() - CHALLENGE_TTL_MS
    for (const [key, entry] of challengeCache) {
      if (entry.lastUsed <= cutoff) challengeCache.delete(key)
    }
  },
  CHALLENGE_TTL_MS,
).unref()

function challengeKey(ctx: DavContext, origin: string): string {
  return createHash('sha256').update(`${origin}\n${ctx.username}\n${ctx.password}`).digest('hex')
}

/** Test hook: forget every cached Digest challenge. */
export function clearDigestChallengeCache(): void {
  challengeCache.clear()
}

// Methods where a request with no body is well-formed, so the Digest
// challenge probe can skip sending one. REPORT/PROPPATCH/PUT/POST/... all
// require a body (sabre 500s on an empty one).
const BODY_OPTIONAL_METHODS = new Set(['PROPFIND', 'OPTIONS', 'GET', 'HEAD'])

/**
 * Drop-in replacement for `fetch()` on every authenticated DAV request
 * (used directly by the raw sharing/PROPPATCH calls and wired in as tsdav's
 * `fetch` override). Basic just attaches the header; Digest reuses the
 * cached challenge for this credentials + origin when there is one, and
 * otherwise does the 401 challenge/response handshake and caches the result.
 */
export async function davFetch(
  ctx: DavContext,
  input: string | URL | Request,
  requestInit?: RequestInit,
): Promise<Response> {
  // Every credentialed request must stay on the authenticated origin: tsdav
  // follows principal/home URLs the server returns, and a hostile server could
  // point them elsewhere to harvest the Basic header or Digest response.
  assertHrefSameHost(ctx.baseUrl, targetUrl(input))
  const init = withTimeout(requestInit)
  if (ctx.authMethod !== 'Digest') {
    return rejectIfUnauthorized(await fetch(input, withAuthHeader(init, basicAuthHeader(ctx).Authorization)))
  }

  const url = targetUrl(input)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const parsed = new URL(url)
  const uri = parsed.pathname + parsed.search
  const key = challengeKey(ctx, parsed.origin)

  const send = (entry: CachedChallenge): Promise<Response> => {
    const cnonce = (entry.challenge.algorithm ?? '').toUpperCase().endsWith('-SESS')
      ? entry.cnonce
      : randomBytes(16).toString('hex')
    const header = buildDigestHeader(ctx, { method, uri, challenge: entry.challenge, nc: entry.nc, cnonce })
    return fetch(input, withAuthHeader(init, header))
  }

  // Authenticate with a freshly negotiated challenge. A 401 here means the
  // credentials themselves are refused -- no further retry.
  const authenticate = async (challenge: DigestChallenge): Promise<Response> => {
    const entry: CachedChallenge = {
      challenge,
      nc: 1,
      cnonce: randomBytes(16).toString('hex'),
      lastUsed: Date.now(),
    }
    const res = await send(entry)
    if (res.status === 401) {
      challengeCache.delete(key)
      return rejectIfUnauthorized(res)
    }
    challengeCache.set(key, entry)
    return res
  }

  const cached = challengeCache.get(key)
  if (cached && Date.now() - cached.lastUsed < CHALLENGE_TTL_MS) {
    // nc is bumped synchronously, so concurrent requests reusing the entry
    // each get a distinct count.
    cached.nc += 1
    cached.lastUsed = Date.now()
    const res = await send(cached)
    if (res.status !== 401) return res
    // The cached nonce was refused (stale, expired, or the server lost its
    // nonce state). Drop it and renegotiate once from this 401's challenge.
    challengeCache.delete(key)
    const fresh = parseDigestChallenge(res.headers.get('www-authenticate') ?? '')
    if (!fresh) return rejectIfUnauthorized(res)
    await res.body?.cancel().catch(() => {})
    return authenticate(fresh)
  }

  let challenge: DigestChallenge | null = null

  if (BODY_OPTIONAL_METHODS.has(method)) {
    const probe = await fetch(input, withoutBody(init, method))
    if (probe.status === 401) {
      challenge = parseDigestChallenge(probe.headers.get('www-authenticate') ?? '')
    }
    await probe.body?.cancel().catch(() => {})
  }

  if (!challenge) {
    // No challenge yet (a body-required method, or the probe wasn't 401'd):
    // send the real request unauthenticated and negotiate from its response.
    const res = await fetch(input, init)
    if (res.status !== 401) return res
    challenge = parseDigestChallenge(res.headers.get('www-authenticate') ?? '')
    // 401 with no Digest challenge: the server no longer offers the scheme
    // this session negotiated at login.
    if (!challenge) return rejectIfUnauthorized(res)
    await res.body?.cancel().catch(() => {})
  }

  return authenticate(challenge)
}
