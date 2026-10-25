import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// config.ts throws at import time if SESSION_SECRET is unset -- set required
// env before importing anything that pulls it in transitively.
process.env.SESSION_SECRET ??= 'a'.repeat(64)

describe('assertHostAllowed', () => {
  afterEach(() => {
    vi.resetModules()
    delete process.env.ALLOWED_DAV_HOSTS
  })

  it('allows any host when no allowlist is configured', async () => {
    delete process.env.ALLOWED_DAV_HOSTS
    vi.resetModules()
    const { assertHostAllowed } = await import('./hostAllowlist.js')
    expect(() => assertHostAllowed('https://anything.example.com/dav/')).not.toThrow()
  })

  it('allows a host present in the allowlist', async () => {
    process.env.ALLOWED_DAV_HOSTS = 'caldav.example.com, other.example.com'
    vi.resetModules()
    const { assertHostAllowed } = await import('./hostAllowlist.js')
    expect(() => assertHostAllowed('https://caldav.example.com/dav/')).not.toThrow()
  })

  it('rejects a host not present in the allowlist', async () => {
    process.env.ALLOWED_DAV_HOSTS = 'caldav.example.com'
    vi.resetModules()
    const { assertHostAllowed, DisallowedHostError } = await import('./hostAllowlist.js')
    expect(() => assertHostAllowed('https://evil.example.com/dav/')).toThrow(DisallowedHostError)
  })

  it('pins scheme and port when an entry is a full origin', async () => {
    process.env.ALLOWED_DAV_HOSTS = 'https://caldav.example.com:8443'
    vi.resetModules()
    const { assertHostAllowed, DisallowedHostError } = await import('./hostAllowlist.js')
    expect(() => assertHostAllowed('https://caldav.example.com:8443/dav/')).not.toThrow()
    expect(() => assertHostAllowed('https://caldav.example.com/dav/')).toThrow(DisallowedHostError)
    expect(() => assertHostAllowed('http://caldav.example.com:8443/dav/')).toThrow(DisallowedHostError)
  })

  it('rejects non-http(s) schemes even without an allowlist', async () => {
    delete process.env.ALLOWED_DAV_HOSTS
    vi.resetModules()
    const { assertHostAllowed, DisallowedHostError } = await import('./hostAllowlist.js')
    expect(() => assertHostAllowed('ftp://caldav.example.com/')).toThrow(DisallowedHostError)
  })
})

describe('assertHrefSameHost', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('allows a same-origin relative href', async () => {
    const { assertHrefSameHost } = await import('./hostAllowlist.js')
    expect(() => assertHrefSameHost('https://caldav.example.com/dav/cal/', 'events/abc.ics')).not.toThrow()
  })

  it('allows a same-origin absolute href', async () => {
    const { assertHrefSameHost } = await import('./hostAllowlist.js')
    expect(() =>
      assertHrefSameHost('https://caldav.example.com/dav/cal/', 'https://caldav.example.com/dav/cal/abc.ics'),
    ).not.toThrow()
  })

  it('rejects a different hostname', async () => {
    const { assertHrefSameHost, DisallowedHostError } = await import('./hostAllowlist.js')
    expect(() =>
      assertHrefSameHost('https://caldav.example.com/dav/cal/', 'https://attacker.example.com/steal'),
    ).toThrow(DisallowedHostError)
  })

  it('rejects a same-hostname but different protocol', async () => {
    const { assertHrefSameHost, DisallowedHostError } = await import('./hostAllowlist.js')
    expect(() =>
      assertHrefSameHost('https://caldav.example.com/dav/cal/', 'http://caldav.example.com/dav/cal/abc.ics'),
    ).toThrow(DisallowedHostError)
  })

  it('rejects a same-hostname but different port', async () => {
    const { assertHrefSameHost, DisallowedHostError } = await import('./hostAllowlist.js')
    expect(() =>
      assertHrefSameHost('https://caldav.example.com/dav/cal/', 'https://caldav.example.com:8443/dav/cal/abc.ics'),
    ).toThrow(DisallowedHostError)
  })
})
