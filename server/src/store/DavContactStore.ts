import type { AddressBook } from '@yourdav/shared'
import type { DAVAddressBook } from 'tsdav'
import { createClient } from '../dav/client.js'
import type { DavContext } from '../dav/context.js'
import { davFetch } from '../dav/auth.js'
import { assertHrefSameHost } from '../dav/hostAllowlist.js'
import { isCollectionReadOnly } from '../dav/privileges.js'
import type { ContactStore, RawCard } from './ContactStore.js'
import { ContactNotFoundError, EtagConflictError, ForbiddenError } from './errors.js'
import { decodeUrlId, encodeId } from './idCodec.js'

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** Segment-boundary check that `href` lives inside the address book collection. */
export function hrefInBook(bookUrl: string, href: string): boolean {
  const bookPath = withSlash(new URL(bookUrl).pathname)
  return new URL(href, bookUrl).pathname.startsWith(bookPath)
}

export class DavContactStore implements ContactStore {
  private async book(ctx: DavContext, addressBookId: string): Promise<DAVAddressBook> {
    const url = decodeUrlId(addressBookId)
    assertHrefSameHost(ctx.baseUrl, url)
    return { url } as DAVAddressBook
  }

  private checkHref(ctx: DavContext, addressBookId: string, href: string): void {
    assertHrefSameHost(ctx.baseUrl, href)
    if (!hrefInBook(decodeUrlId(addressBookId), href)) {
      throw new ForbiddenError('Contact does not belong to this address book')
    }
  }

  async discoverAddressBooks(ctx: DavContext): Promise<AddressBook[]> {
    const client = await createClient(ctx, 'carddav')
    const books = await client.fetchAddressBooks()
    const readOnly = await Promise.all(books.map((b) => isCollectionReadOnly(ctx, String(b.url))))
    return books.map((b, i) => ({
      id: encodeId(String(b.url)),
      url: String(b.url),
      displayName: typeof b.displayName === 'string' && b.displayName ? b.displayName : 'Contacts',
      description: typeof (b as { description?: unknown }).description === 'string'
        ? ((b as { description: string }).description || null)
        : null,
      readOnly: readOnly[i],
      ctag: typeof b.ctag === 'string' ? b.ctag : null,
    }))
  }

  async createAddressBook(ctx: DavContext, displayName: string): Promise<AddressBook> {
    const client = await createClient(ctx, 'carddav')
    const homeUrl = client.account?.homeUrl
    if (!homeUrl) throw new Error('CardDAV account has no addressbook-home-set URL')
    const url = new URL(`${crypto.randomUUID()}/`, withSlash(homeUrl)).toString()
    assertHrefSameHost(ctx.baseUrl, url)
    const name = displayName.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
    const response = await davFetch(ctx, url, {
      method: 'MKCOL',
      headers: { 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8" ?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:set>
    <D:prop>
      <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
      <D:displayname>${name}</D:displayname>
    </D:prop>
  </D:set>
</D:mkcol>`,
    })
    if (!response.ok) throw new Error(`Failed to create address book: ${response.status} ${response.statusText}`)
    return { id: encodeId(url), url, displayName, description: null, readOnly: false, ctag: null }
  }

  async deleteAddressBook(ctx: DavContext, addressBookId: string): Promise<void> {
    const url = decodeUrlId(addressBookId)
    assertHrefSameHost(ctx.baseUrl, url)
    const response = await davFetch(ctx, url, { method: 'DELETE' })
    if (!response.ok) throw new Error(`Failed to delete address book: ${response.status} ${response.statusText}`)
  }

  async getCards(ctx: DavContext, addressBookId: string): Promise<RawCard[]> {
    const client = await createClient(ctx, 'carddav')
    const addressBook = await this.book(ctx, addressBookId)
    const cards = await client.fetchVCards({ addressBook })
    return cards
      .filter((c) => typeof c.data === 'string' && c.data.includes('BEGIN:VCARD'))
      .map((c) => ({ href: String(c.url), etag: String(c.etag ?? ''), vcard: c.data as string }))
  }

  async getCard(ctx: DavContext, addressBookId: string, href: string): Promise<RawCard> {
    this.checkHref(ctx, addressBookId, href)
    const client = await createClient(ctx, 'carddav')
    const addressBook = await this.book(ctx, addressBookId)
    let cards: Awaited<ReturnType<typeof client.fetchVCards>>
    try {
      cards = await client.fetchVCards({ addressBook, objectUrls: [href], useMultiGet: false })
    } catch (err) {
      // tsdav reports a missing card as a generic "incomplete response", which
      // is indistinguishable from a real failure -- confirm it's a 404 before
      // calling it deleted.
      const probe = await davFetch(ctx, href, { method: 'HEAD' }).catch(() => null)
      if (probe?.status === 404) throw new ContactNotFoundError(`Contact not found: ${href}`)
      throw err
    }
    const card = cards[0]
    if (!card || typeof card.data !== 'string') throw new ContactNotFoundError(`Contact not found: ${href}`)
    return { href: String(card.url), etag: String(card.etag ?? ''), vcard: card.data }
  }

  async createCard(ctx: DavContext, addressBookId: string, vcard: string): Promise<RawCard> {
    const client = await createClient(ctx, 'carddav')
    const addressBook = await this.book(ctx, addressBookId)
    const filename = `${crypto.randomUUID()}.vcf`
    const response = await client.createVCard({ addressBook, filename, vCardString: vcard })
    if (!response.ok) {
      throw new Error(`Failed to create contact: ${response.status} ${response.statusText}`)
    }
    const href = new URL(filename, withSlash(decodeUrlId(addressBookId))).toString()
    return { href, etag: response.headers.get('etag') ?? '', vcard }
  }

  async updateCard(ctx: DavContext, addressBookId: string, href: string, etag: string, vcard: string): Promise<RawCard> {
    this.checkHref(ctx, addressBookId, href)
    const client = await createClient(ctx, 'carddav')
    const response = await client.updateVCard({
      vCard: { url: href, data: vcard, etag },
      headers: { 'If-Match': etag },
    })
    if (response.status === 412) throw new EtagConflictError('Contact changed since it was last read')
    if (!response.ok) {
      throw new Error(`Failed to update contact: ${response.status} ${response.statusText}`)
    }
    return { href, etag: response.headers.get('etag') ?? etag, vcard }
  }

  async deleteCard(ctx: DavContext, addressBookId: string, href: string, etag: string): Promise<void> {
    this.checkHref(ctx, addressBookId, href)
    const client = await createClient(ctx, 'carddav')
    const response = await client.deleteVCard({
      vCard: { url: href, etag },
      headers: { 'If-Match': etag },
    })
    if (response.status === 412) throw new EtagConflictError('Contact changed since it was last read')
    // Already gone (deleted from another client): the delete's intent is met.
    if (response.status === 404) return
    if (!response.ok) {
      throw new Error(`Failed to delete contact: ${response.status} ${response.statusText}`)
    }
  }
}
