import { config } from '../config.js'
import { InvalidIdError } from '../store/errors.js'

export class DisallowedHostError extends Error {}

export function assertHostAllowed(serverUrl: string): void {
  const url = new URL(serverUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DisallowedHostError(`DAV URL scheme "${url.protocol}" is not allowed`)
  }
  if (!config.allowedDavHosts) return

  // An entry is either a bare hostname (any port/scheme on that host) or a
  // full origin like https://host:8443, which pins scheme and port too.
  const allowed = config.allowedDavHosts.some((entry) => {
    if (!entry.includes('://')) return entry === url.hostname
    try {
      return new URL(entry).origin === url.origin
    } catch {
      return false
    }
  })
  if (!allowed) {
    throw new DisallowedHostError(`DAV host "${url.host}" is not on the allowlist`)
  }
}

/**
 * Guards against a client-supplied href (from a write/delete request body)
 * pointing at a different host than the one the session authenticated
 * against -- without this, an authenticated user could pass an arbitrary
 * URL as `href` and have the server issue a WebDAV request to it carrying
 * their DAV credentials (SSRF + credential exfiltration).
 */
export function assertHrefSameHost(baseUrl: string, href: string): void {
  const base = new URL(baseUrl)
  let target: URL
  try {
    target = new URL(href, baseUrl)
  } catch {
    throw new InvalidIdError(`Malformed href "${href}"`)
  }
  // Origin, not just hostname: a same-host URL on a different port or
  // protocol (e.g. http:// instead of https://, or an internal port
  // exposed on the same box) would otherwise pass this check and still
  // receive the session's Basic-auth credentials.
  if (target.protocol !== base.protocol || target.hostname !== base.hostname || target.port !== base.port) {
    throw new DisallowedHostError(`href "${href}" does not belong to the authenticated DAV host`)
  }
}
