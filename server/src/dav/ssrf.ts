import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIPv4, isIPv6, type LookupFunction } from 'node:net'
import { config } from '../config.js'

export class BlockedUrlError extends Error {}

const MAX_REDIRECTS = 5
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5MB, generous for an ICS feed

type IpClass = 'public' | 'lan' | 'blocked'

/**
 * 'blocked': loopback, link-local (incl. cloud metadata endpoints at
 * 169.254.169.254), "this network" and unrecognized addresses -- never
 * reachable unless the host is explicitly allowlisted.
 * 'lan': RFC1918 / CGNAT / IPv6 unique-local -- reachable only when
 * ALLOW_PRIVATE_SUBSCRIPTIONS is set (or the host is allowlisted).
 */
function classifyIp(ip: string): IpClass {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127) return 'blocked' // loopback
    if (a === 169 && b === 254) return 'blocked' // link-local, incl. cloud metadata
    if (a === 0) return 'blocked' // "this network"
    if (a === 10) return 'lan'
    if (a === 172 && b >= 16 && b <= 31) return 'lan'
    if (a === 192 && b === 168) return 'lan'
    if (a === 100 && b >= 64 && b <= 127) return 'lan' // carrier-grade NAT
    return 'public'
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return 'blocked' // loopback
    if (/^fe[89ab]/.test(lower)) return 'blocked' // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'lan' // unique local
    if (lower.startsWith('::ffff:')) return classifyIp(lower.slice('::ffff:'.length))
    return 'public'
  }
  return 'blocked' // unrecognized -- fail closed
}

function isDisallowedIp(ip: string, hostname: string): boolean {
  if (isPrivateAllowed(hostname)) return false
  const cls = classifyIp(ip)
  return cls === 'blocked' || (cls === 'lan' && !config.allowPrivateSubscriptions)
}

function isPrivateAllowed(hostname: string): boolean {
  return config.allowedSubscriptionPrivateHosts.includes(hostname.replace(/^\[|\]$/g, '').toLowerCase())
}

/**
 * Resolves `hostname` and throws if it (or any resolved address) points at
 * a private/internal network. Returns the validated addresses.
 */
async function resolvePublicAddresses(hostname: string): Promise<{ address: string; family: number }[]> {
  if (hostname === 'localhost' && !isPrivateAllowed(hostname)) {
    throw new BlockedUrlError('Refusing to fetch from "localhost"')
  }
  let addresses: { address: string; family: number }[]
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new BlockedUrlError(`Could not resolve host "${hostname}"`)
  }
  if (addresses.length === 0) throw new BlockedUrlError(`Could not resolve host "${hostname}"`)
  for (const { address } of addresses) {
    if (isDisallowedIp(address, hostname)) {
      throw new BlockedUrlError(`Refusing to fetch from "${hostname}" (resolves to private address ${address})`)
    }
  }
  return addresses
}

/**
 * Used as the socket's `lookup`, so the addresses validated here are the
 * very ones the TCP connection is made to -- there is no second resolution
 * for a rebinding DNS server to answer differently. The hostname itself is
 * left untouched, so TLS SNI/certificate checks and the Host header still
 * use it.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  resolvePublicAddresses(hostname).then(
    (addresses) => {
      if (options.all) {
        callback(null, addresses)
      } else {
        callback(null, addresses[0].address, addresses[0].family)
      }
    },
    (err) => callback(err, '', 0),
  )
}

function assertPublicLiteral(hostname: string): void {
  if (isDisallowedIp(hostname, hostname)) {
    throw new BlockedUrlError(`Refusing to fetch from private/reserved address "${hostname}"`)
  }
}

function requestOnce(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<http.IncomingMessage> {
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: 'GET', headers, lookup: guardedLookup, signal }, resolve)
    req.on('error', reject)
    req.end()
  })
}

/**
 * SSRF-hardened fetch for arbitrary user-supplied URLs (subscription
 * feeds): refuses private/internal targets (the connection is pinned to
 * the validated address, see `guardedLookup`), follows redirects manually
 * so every hop is re-validated, caps the response body size, and bounds
 * the whole exchange -- connect, headers and body -- by the outbound
 * timeout.
 */
export async function safeFetchExternal(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<{ text: string }> {
  const signal = AbortSignal.timeout(config.outboundTimeoutMs)
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BlockedUrlError(`Unsupported protocol "${parsed.protocol}"`)
    }
    // Literal IPs skip DNS entirely (so never reach guardedLookup).
    const literal = parsed.hostname.replace(/^\[|\]$/g, '')
    if (isIPv4(literal) || isIPv6(literal)) assertPublicLiteral(literal)

    const response = await requestOnce(parsed, init?.headers ?? {}, signal)
    const status = response.statusCode ?? 0

    if (status >= 300 && status < 400) {
      response.resume()
      const location = response.headers.location
      if (!location) throw new BlockedUrlError('Redirect response had no Location header')
      current = new URL(location, current).toString()
      continue
    }

    if (status < 200 || status >= 300) {
      response.resume()
      throw new Error(`Request failed: ${status} ${response.statusMessage ?? ''}`.trim())
    }

    const contentLength = response.headers['content-length']
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      response.destroy()
      throw new BlockedUrlError('Response exceeds maximum allowed size')
    }

    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response as AsyncIterable<Buffer>) {
      total += chunk.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        response.destroy()
        throw new BlockedUrlError('Response exceeds maximum allowed size')
      }
      chunks.push(chunk)
    }
    return { text: Buffer.concat(chunks).toString('utf-8') }
  }
  throw new BlockedUrlError('Too many redirects')
}
