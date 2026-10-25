import type { AddressBook } from '@yourdav/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DavContext } from '../dav/context.js'

process.env.SESSION_SECRET ??= 'a'.repeat(64)

const storeMock: Record<string, ReturnType<typeof vi.fn>> = {
  discoverAddressBooks: vi.fn(),
  createAddressBook: vi.fn(),
  deleteAddressBook: vi.fn(),
  getCards: vi.fn(),
  getCard: vi.fn(),
  createCard: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
}
vi.mock('../store/contacts.js', () => ({ contactStore: storeMock }))

const { addressBookRoutes } = await import('./addressbooks.js')
const { ContactNotFoundError } = await import('../store/errors.js')

const dav: DavContext = { baseUrl: 'https://dav.example.com/dav/', username: 'alice', password: 'secret' }

function book(id: string, overrides: Partial<AddressBook> = {}): AddressBook {
  return { id, url: `https://dav.example.com/${id}/`, displayName: id, description: null, readOnly: false, ctag: null, ...overrides }
}

async function buildApp(opts: { authenticated?: boolean } = {}): Promise<FastifyInstance> {
  const { authenticated = true } = opts
  const app = Fastify()
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    req.session = { get: (key: string) => (key === 'dav' && authenticated ? dav : undefined) } as never
  })
  await app.register(addressBookRoutes, { prefix: '/api/addressbooks' })
  return app
}

let app: FastifyInstance
beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(async () => {
  await app?.close()
})

describe('POST /api/addressbooks', () => {
  it('401s when unauthenticated', async () => {
    app = await buildApp({ authenticated: false })
    const res = await app.inject({ method: 'POST', url: '/api/addressbooks', payload: { displayName: 'Work' } })
    expect(res.statusCode).toBe(401)
    expect(storeMock.createAddressBook).not.toHaveBeenCalled()
  })

  it('creates an address book with a trimmed name', async () => {
    storeMock.createAddressBook.mockResolvedValue(book('new', { displayName: 'Work' }))
    app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/api/addressbooks', payload: { displayName: '  Work  ' } })
    expect(res.statusCode).toBe(201)
    expect(storeMock.createAddressBook).toHaveBeenCalledWith(dav, 'Work')
    expect(res.json().displayName).toBe('Work')
  })

  it.each([[''], ['   '], ['x'.repeat(201)]])('rejects the invalid name %j', async (displayName) => {
    app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/api/addressbooks', payload: { displayName } })
    expect(res.statusCode).toBe(400)
    expect(storeMock.createAddressBook).not.toHaveBeenCalled()
  })

  it('rejects a missing body', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/api/addressbooks' })
    expect(res.statusCode).toBe(400)
    expect(storeMock.createAddressBook).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/addressbooks/:id', () => {
  it('401s when unauthenticated', async () => {
    app = await buildApp({ authenticated: false })
    const res = await app.inject({ method: 'DELETE', url: '/api/addressbooks/b1' })
    expect(res.statusCode).toBe(401)
    expect(storeMock.deleteAddressBook).not.toHaveBeenCalled()
  })

  it('deletes a discovered, writable address book', async () => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('b1'), book('b2')])
    storeMock.deleteAddressBook.mockResolvedValue(undefined)
    app = await buildApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/addressbooks/b1' })
    expect(res.statusCode).toBe(204)
    expect(storeMock.deleteAddressBook).toHaveBeenCalledWith(dav, 'b1')
  })

  it('404s for an id that is not a discovered address book, without issuing a DELETE', async () => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('b1')])
    app = await buildApp()
    // e.g. a crafted id pointing at a calendar or the principal collection
    const res = await app.inject({ method: 'DELETE', url: '/api/addressbooks/some-calendar-id' })
    expect(res.statusCode).toBe(404)
    expect(storeMock.deleteAddressBook).not.toHaveBeenCalled()
  })

  it('403s for a read-only address book', async () => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('b1', { readOnly: true })])
    app = await buildApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/addressbooks/b1' })
    expect(res.statusCode).toBe(403)
    expect(storeMock.deleteAddressBook).not.toHaveBeenCalled()
  })
})

const CARD = (uid: string, ...extra: string[]) =>
  ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, 'FN:Jane Doe', 'N:Doe;Jane;;;', ...extra, 'END:VCARD', ''].join('\r\n')

describe('PUT /api/addressbooks/:id/contacts', () => {
  const href = 'https://dav.example.com/a/jane.vcf'
  const payload = {
    href,
    etag: '"e1"',
    name: { given: 'Jane', family: 'Doe', prefix: '', additional: '', suffix: '' },
    nickname: '',
    org: '',
    title: '',
    emails: [],
    phones: [],
    urls: [],
    addresses: [],
    birthday: '',
    anniversary: '',
    notes: '',
    categories: [],
  }
  const put = () => app.inject({ method: 'PUT', url: '/api/addressbooks/a/contacts', payload })

  beforeEach(() => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a')])
  })

  it('412s when the card changed since the client read it', async () => {
    storeMock.getCard.mockResolvedValue({ href, etag: '"changed"', vcard: CARD('uid-1') })
    app = await buildApp()
    expect((await put()).statusCode).toBe(412)
    expect(storeMock.updateCard).not.toHaveBeenCalled()
  })

  it('412s, not 404/500, when the card was deleted elsewhere, so the client can say so', async () => {
    storeMock.getCard.mockRejectedValue(new ContactNotFoundError('gone'))
    app = await buildApp()
    const res = await put()
    expect(res.statusCode).toBe(412)
    expect(res.json().error).toBe('conflict')
    expect(storeMock.updateCard).not.toHaveBeenCalled()
  })
})

describe('POST /api/addressbooks/:id/contacts/transfer', () => {
  const body = { href: 'https://dav.example.com/a/jane.vcf', etag: '"e1"', targetBookId: 'b', mode: 'move' }
  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/addressbooks/a/contacts/transfer', payload: payload as object })

  beforeEach(() => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a'), book('b')])
    storeMock.getCard.mockResolvedValue({ href: body.href, etag: '"e1"', vcard: CARD('uid-1') })
    storeMock.createCard.mockResolvedValue({ href: 'https://dav.example.com/b/new.vcf', etag: '"n1"', vcard: CARD('uid-1') })
    storeMock.deleteCard.mockResolvedValue(undefined)
  })

  it('401s when unauthenticated', async () => {
    app = await buildApp({ authenticated: false })
    expect((await post(body)).statusCode).toBe(401)
  })

  it.each([
    ['a missing href', { ...body, href: '' }],
    ['a missing target', { ...body, targetBookId: '' }],
    ['an unknown mode', { ...body, mode: 'teleport' }],
    ['a move into the same book', { ...body, targetBookId: 'a' }],
  ])('400s for %s', async (_label, payload) => {
    app = await buildApp()
    expect((await post(payload)).statusCode).toBe(400)
    expect(storeMock.createCard).not.toHaveBeenCalled()
  })

  it('404s when either address book is unknown', async () => {
    app = await buildApp()
    expect((await post({ ...body, targetBookId: 'nope' })).statusCode).toBe(404)
  })

  it('403s when the target is read-only', async () => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a'), book('b', { readOnly: true })])
    app = await buildApp()
    expect((await post(body)).statusCode).toBe(403)
    expect(storeMock.createCard).not.toHaveBeenCalled()
  })

  it('refuses to move out of a read-only book, but allows copying out of one', async () => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a', { readOnly: true }), book('b')])
    app = await buildApp()
    expect((await post(body)).statusCode).toBe(403)
    expect((await post({ ...body, mode: 'copy' })).statusCode).toBe(201)
  })

  it('moves: creates in the target with the same UID, then deletes the original', async () => {
    app = await buildApp()
    const res = await post(body)
    expect(res.statusCode).toBe(201)
    expect(storeMock.createCard).toHaveBeenCalledWith(dav, 'b', CARD('uid-1'))
    expect(storeMock.deleteCard).toHaveBeenCalledWith(dav, 'a', body.href, '"e1"')
    expect(res.json()).toMatchObject({ addressBookId: 'b', href: 'https://dav.example.com/b/new.vcf' })
  })

  it('copies: new UID in the target, original untouched', async () => {
    app = await buildApp()
    const res = await post({ ...body, mode: 'copy' })
    expect(res.statusCode).toBe(201)
    const created = storeMock.createCard.mock.calls[0][2] as string
    expect(created).not.toContain('UID:uid-1')
    expect(created).toMatch(/UID:[0-9a-f-]{36}/)
    expect(storeMock.deleteCard).not.toHaveBeenCalled()
  })

  it('removes the new card again if deleting the original fails', async () => {
    storeMock.deleteCard.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)
    app = await buildApp()
    const res = await post(body)
    expect(res.statusCode).toBe(500)
    expect(storeMock.deleteCard).toHaveBeenCalledTimes(2)
    expect(storeMock.deleteCard).toHaveBeenLastCalledWith(dav, 'b', 'https://dav.example.com/b/new.vcf', '"n1"')
  })

  it('412s on a stale etag without creating anything', async () => {
    storeMock.getCard.mockResolvedValue({ href: body.href, etag: '"changed"', vcard: CARD('uid-1') })
    app = await buildApp()
    expect((await post(body)).statusCode).toBe(412)
    expect(storeMock.createCard).not.toHaveBeenCalled()
  })
})

describe('POST /api/addressbooks/:id/groups/members', () => {
  const items = [
    { href: 'https://dav.example.com/a/1.vcf', etag: '"1"' },
    { href: 'https://dav.example.com/a/2.vcf', etag: '"2"' },
  ]
  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/addressbooks/a/groups/members', payload: payload as object })

  beforeEach(() => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a')])
    storeMock.updateCard.mockResolvedValue({ href: '', etag: '"x"', vcard: '' })
  })

  it('401s when unauthenticated', async () => {
    app = await buildApp({ authenticated: false })
    expect((await post({ items, add: 'g' })).statusCode).toBe(401)
  })

  it.each([
    ['neither add nor remove', { items }],
    ['both add and remove', { items, add: 'a', remove: 'b' }],
    ['no items', { items: [], add: 'a' }],
    ['too many items', { items: Array.from({ length: 201 }, (_, i) => ({ href: `h${i}`, etag: 'e' })), add: 'a' }],
  ])('400s for %s', async (_label, payload) => {
    app = await buildApp()
    expect((await post(payload)).statusCode).toBe(400)
    expect(storeMock.updateCard).not.toHaveBeenCalled()
  })

  it('403s for a read-only address book', async () => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a', { readOnly: true })])
    app = await buildApp()
    expect((await post({ items, add: 'g' })).statusCode).toBe(403)
  })

  it('edits only cards that need it and reports the counts', async () => {
    storeMock.getCard
      .mockResolvedValueOnce({ href: items[0].href, etag: '"1"', vcard: CARD('u1', 'CATEGORIES:old') })
      .mockResolvedValueOnce({ href: items[1].href, etag: '"2"', vcard: CARD('u2', 'CATEGORIES:old,g') })
    app = await buildApp()
    const res = await post({ items, add: 'g' })
    expect(res.json()).toEqual({ updated: 1, unchanged: 1, failed: 0 })
    expect(storeMock.updateCard).toHaveBeenCalledTimes(1)
    expect(storeMock.updateCard).toHaveBeenCalledWith(dav, 'a', items[0].href, '"1"', CARD('u1', 'CATEGORIES:old,g'))
  })

  it('removes a group', async () => {
    storeMock.getCard.mockResolvedValue({ href: items[0].href, etag: '"1"', vcard: CARD('u1', 'CATEGORIES:g') })
    app = await buildApp()
    const res = await post({ items: [items[0]], remove: 'g' })
    expect(res.json()).toEqual({ updated: 1, unchanged: 0, failed: 0 })
    expect(storeMock.updateCard.mock.calls[0][4]).toBe(CARD('u1'))
  })

  it('counts a failing card without aborting the rest', async () => {
    storeMock.getCard
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce({ href: items[1].href, etag: '"2"', vcard: CARD('u2') })
    app = await buildApp()
    const res = await post({ items, add: 'g' })
    expect(res.json()).toEqual({ updated: 1, unchanged: 0, failed: 1 })
  })
})

describe('POST /api/addressbooks/:id/groups/rename', () => {
  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/addressbooks/a/groups/rename', payload: payload as object })

  beforeEach(() => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a')])
    storeMock.updateCard.mockResolvedValue({ href: '', etag: '"x"', vcard: '' })
  })

  it('401s when unauthenticated', async () => {
    app = await buildApp({ authenticated: false })
    expect((await post({ from: 'old', to: 'new' })).statusCode).toBe(401)
  })

  it.each([
    ['missing from', { to: 'new' }],
    ['empty from', { from: '  ', to: 'new' }],
    ['missing to', { from: 'old' }],
    ['empty to', { from: 'old', to: '  ' }],
  ])('400s for %s', async (_label, payload) => {
    app = await buildApp()
    expect((await post(payload)).statusCode).toBe(400)
    expect(storeMock.updateCard).not.toHaveBeenCalled()
  })

  it('403s for a read-only address book', async () => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a', { readOnly: true })])
    app = await buildApp()
    expect((await post({ from: 'old', to: 'new' })).statusCode).toBe(403)
  })

  it('renames matching cards and skips cards without that category', async () => {
    storeMock.getCards.mockResolvedValue([
      { href: 'https://dav.example.com/a/1.vcf', etag: '"1"', vcard: CARD('u1', 'CATEGORIES:old,work') },
      { href: 'https://dav.example.com/a/2.vcf', etag: '"2"', vcard: CARD('u2', 'CATEGORIES:other') },
      { href: 'https://dav.example.com/a/3.vcf', etag: '"3"', vcard: CARD('u3', 'CATEGORIES:old') },
    ])
    app = await buildApp()
    const res = await post({ from: 'old', to: 'fresh' })
    expect(res.json()).toEqual({ updated: 2, failed: 0 })
    expect(storeMock.updateCard).toHaveBeenCalledTimes(2)
    expect(storeMock.updateCard).toHaveBeenCalledWith(
      dav,
      'a',
      'https://dav.example.com/a/1.vcf',
      '"1"',
      CARD('u1', 'CATEGORIES:fresh,work'),
    )
    expect(storeMock.updateCard).toHaveBeenCalledWith(
      dav,
      'a',
      'https://dav.example.com/a/3.vcf',
      '"3"',
      CARD('u3', 'CATEGORIES:fresh'),
    )
  })

  it('counts failed card updates without aborting the rest', async () => {
    storeMock.getCards.mockResolvedValue([
      { href: 'https://dav.example.com/a/1.vcf', etag: '"1"', vcard: CARD('u1', 'CATEGORIES:old') },
      { href: 'https://dav.example.com/a/2.vcf', etag: '"2"', vcard: CARD('u2', 'CATEGORIES:old') },
    ])
    storeMock.updateCard
      .mockRejectedValueOnce(new Error('CardDAV update failed'))
      .mockResolvedValueOnce({ href: '', etag: '"2"', vcard: '' })
    app = await buildApp()
    const res = await post({ from: 'old', to: 'fresh' })
    expect(res.json()).toEqual({ updated: 1, failed: 1 })
  })
})

describe('POST /api/addressbooks/:id/import', () => {
  // index.ts registers the text body parser the real app uses for .vcf uploads.
  const buildImportApp = async () => {
    const importApp = Fastify()
    importApp.decorateRequest('session', null as never)
    importApp.addHook('onRequest', async (req) => {
      req.session = { get: (key: string) => (key === 'dav' ? dav : undefined) } as never
    })
    importApp.addContentTypeParser('text/vcard', { parseAs: 'string' }, (_req, body, done) => done(null, body))
    await importApp.register(addressBookRoutes, { prefix: '/api/addressbooks' })
    return importApp
  }
  const post = (payload: string) =>
    app.inject({
      method: 'POST',
      url: '/api/addressbooks/a/import',
      payload,
      headers: { 'content-type': 'text/vcard' },
    })

  beforeEach(() => {
    storeMock.discoverAddressBooks.mockResolvedValue([book('a')])
    storeMock.getCards.mockResolvedValue([])
    storeMock.createCard.mockResolvedValue({ href: '', etag: '"x"', vcard: '' })
  })

  it('creates cards concurrently, capped at 6 in flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    storeMock.createCard.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { href: '', etag: '"x"', vcard: '' }
    })
    app = await buildImportApp()
    const res = await post(Array.from({ length: 20 }, (_, i) => CARD(`u${i}`)).join(''))
    expect(res.json()).toEqual({ imported: 20, skipped: 0 })
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(6)
  })

  it('creates a UID that appears twice in one file only once', async () => {
    app = await buildImportApp()
    const res = await post([CARD('dup'), CARD('other'), CARD('dup')].join(''))
    expect(res.json()).toEqual({ imported: 2, skipped: 1 })
    expect(storeMock.createCard).toHaveBeenCalledTimes(2)
  })

  it('skips cards already in the book and counts rejected ones as skipped', async () => {
    storeMock.getCards.mockResolvedValue([{ href: 'https://dav.example.com/a/1.vcf', etag: '"1"', vcard: CARD('have') }])
    storeMock.createCard.mockRejectedValueOnce(new Error('rejected')).mockResolvedValue({ href: '', etag: '"x"', vcard: '' })
    app = await buildImportApp()
    const res = await post([CARD('have'), CARD('bad'), CARD('good')].join(''))
    expect(res.json()).toEqual({ imported: 1, skipped: 2 })
  })
})
