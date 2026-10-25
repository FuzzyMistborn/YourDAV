import { xml2js } from 'xml-js'
import { davFetch } from './auth.js'
import { createClient } from './client.js'
import type { DavContext } from './context.js'
import { escapeXml } from './sharing.js'

/**
 * Per-account app settings kept as a single custom ("dead") WebDAV property on
 * the user's calendar home, so they follow the account across browsers and
 * logouts without this server needing a database of its own. Verified against
 * Radicale and Baikal (both store arbitrary properties on the home and keep
 * them private to the owner); servers that refuse the PROPPATCH raise
 * SettingsUnsupportedError and the client falls back to browser storage.
 */
const NS = 'https://yourdav.app/ns'
const PROP = 'yourdav-subscriptions'

export class SettingsUnsupportedError extends Error {}

async function homeUrl(ctx: DavContext): Promise<string> {
  const client = await createClient(ctx)
  const url = client.account?.homeUrl
  if (!url) throw new SettingsUnsupportedError('No calendar home found')
  return url
}

function findText(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key.includes(':') ? key.split(':').pop() : key) === PROP) {
      const el = value as { _text?: unknown; _cdata?: unknown }
      const text = el?._text ?? el?._cdata
      return typeof text === 'string' ? text : null
    }
    const nested = findText(value)
    if (nested !== null) return nested
  }
  return null
}

/** The stored JSON text, or null when the property is absent or unreadable. */
export async function readSubscriptionsProp(ctx: DavContext): Promise<string | null> {
  let url: string
  try {
    url = await homeUrl(ctx)
  } catch {
    return null
  }
  const res = await davFetch(ctx, url, {
    method: 'PROPFIND',
    headers: { 'Content-Type': 'application/xml', Depth: '0' },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:y="${NS}"><d:prop><y:${PROP}/></d:prop></d:propfind>`,
  })
  if (!res.ok) return null
  const parsed = xml2js(await res.text(), { compact: true, ignoreDeclaration: true })
  return findText(parsed)
}

/** Throws SettingsUnsupportedError if the server won't store the property. */
export async function writeSubscriptionsProp(ctx: DavContext, json: string): Promise<void> {
  const url = await homeUrl(ctx)
  const res = await davFetch(ctx, url, {
    method: 'PROPPATCH',
    headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:y="${NS}">
  <d:set><d:prop><y:${PROP}>${escapeXml(json)}</y:${PROP}></d:prop></d:set>
</d:propertyupdate>`,
  })
  if (!res.ok) throw new SettingsUnsupportedError(`PROPPATCH refused: ${res.status}`)
  // A 207 can still carry a per-property failure (403/409/...).
  const body = await res.text()
  if (/<[^>]*status[^>]*>[^<]*\b(4\d\d|5\d\d)\b/i.test(body)) {
    throw new SettingsUnsupportedError('Server rejected the settings property')
  }
}
