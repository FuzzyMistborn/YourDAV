import { createHash } from 'node:crypto'
import type {
  AddressBook,
  Contact,
  CreateAddressBookInput,
  ContactInput,
  DeleteContactInput,
  GroupMembersInput,
  GroupMembersResult,
  ImportResult,
  RenameGroupInput,
  RenameGroupResult,
  TransferContactInput,
  UpdateContactInput,
} from '@yourdav/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  applyContactInput,
  editCategories,
  ensureUid,
  photoFromCard,
  renameCategory,
  replaceUid,
  splitVcf,
  vcardToContact,
} from '../vcard/card.js'
import type { DavContext } from '../dav/context.js'
import { ContactNotFoundError, EtagConflictError } from '../store/errors.js'
import { encodeId } from '../store/idCodec.js'
import type { RawCard } from '../store/ContactStore.js'
import { contactStore } from '../store/contacts.js'
import { requireSession } from './requireSession.js'

const MAX_PHOTO_BYTES = 2 * 1024 * 1024

/** Runs `fn` over `items` with at most `limit` asynchronous invocations in flight concurrently. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let nextIdx = 0
  const workerCount = Math.min(limit, items.length)
  if (workerCount === 0) return results
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

function toContact(addressBookId: string, card: RawCard): Contact {
  return vcardToContact(card.vcard, addressBookId, encodeId(card.href), card.href, card.etag)
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '').slice(0, 100) || 'export'
}

function validInput(body: ContactInput | undefined): string | null {
  if (!body || typeof body !== 'object') return 'body is required'
  if (!body.name || typeof body.name !== 'object') return 'name is required'
  for (const k of ['emails', 'phones', 'urls', 'addresses', 'categories'] as const) {
    if (!Array.isArray(body[k])) return `${k} must be an array`
  }
  const hasAny =
    Object.values(body.name).some((v) => String(v).trim()) || body.org?.trim() || body.fullName?.trim()
  if (!hasAny) return 'A name or organization is required'
  if (typeof body.photo === 'string') {
    if (!/^data:image\/(jpeg|png|gif|webp);base64,/i.test(body.photo)) return 'photo must be a base64 image data URI'
    if (body.photo.length > MAX_PHOTO_BYTES * 1.4) return 'photo is too large'
  }
  return null
}

/** Loads the address book and rejects writes to a read-only one. Replies and returns false on failure. */
async function writable(dav: DavContext, id: string, reply: FastifyReply): Promise<boolean> {
  const book = (await contactStore.discoverAddressBooks(dav)).find((b) => b.id === id)
  if (!book) {
    reply.code(404).send({ error: 'not_found', message: 'Address book not found' })
    return false
  }
  if (book.readOnly) {
    reply.code(403).send({ error: 'forbidden', message: 'This address book is read-only' })
    return false
  }
  return true
}

export async function addressBookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    return reply.send(await contactStore.discoverAddressBooks(dav))
  })

  app.post<{ Body: CreateAddressBookInput }>('/', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const name = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : ''
    if (!name || name.length > 200) {
      return reply.code(400).send({ error: 'bad_request', message: 'A name of up to 200 characters is required' })
    }
    return reply.code(201).send(await contactStore.createAddressBook(dav, name))
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    // Only a discovered, writable address book can be deleted -- never an
    // arbitrary collection a crafted id happens to point at.
    if (!(await writable(dav, req.params.id, reply))) return
    await contactStore.deleteAddressBook(dav, req.params.id)
    return reply.code(204).send()
  })

  app.get<{ Params: { id: string } }>('/:id/contacts', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const cards = await contactStore.getCards(dav, req.params.id)
    return reply.send(cards.map((c) => toContact(req.params.id, c)))
  })

  app.post<{ Params: { id: string }; Body: ContactInput }>('/:id/contacts', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const err = validInput(req.body)
    if (err) return reply.code(400).send({ error: 'bad_request', message: err })
    if (!(await writable(dav, req.params.id, reply))) return

    const created = await contactStore.createCard(dav, req.params.id, applyContactInput(null, req.body))
    // Re-read so the client gets the server's etag even if it omitted one on 201.
    const card = created.etag ? created : await contactStore.getCard(dav, req.params.id, created.href)
    return reply.code(201).send(toContact(req.params.id, card))
  })

  app.put<{ Params: { id: string }; Body: UpdateContactInput }>('/:id/contacts', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const err = validInput(req.body)
    if (err || !req.body.href || !req.body.etag) {
      return reply.code(400).send({ error: 'bad_request', message: err ?? 'href and etag are required' })
    }
    if (!(await writable(dav, req.params.id, reply))) return

    try {
      // Edit against the server's current copy so unmanaged properties are never lost.
      // A card deleted from another client is a conflict too: the client reloads
      // and tells the user it is gone, rather than showing a bare 404.
      const current = await contactStore.getCard(dav, req.params.id, req.body.href).catch((e: unknown) => {
        throw e instanceof ContactNotFoundError ? new EtagConflictError('Contact deleted') : e
      })
      if (current.etag && current.etag !== req.body.etag) throw new EtagConflictError('Contact changed')
      const updated = await contactStore.updateCard(
        dav,
        req.params.id,
        req.body.href,
        req.body.etag,
        applyContactInput(current.vcard, req.body),
      )
      return reply.send(toContact(req.params.id, updated))
    } catch (e) {
      if (e instanceof EtagConflictError) {
        return reply
          .code(412)
          .send({ error: 'conflict', message: 'This contact was changed elsewhere. Reload and try again.' })
      }
      throw e
    }
  })

  app.delete<{ Params: { id: string }; Querystring: DeleteContactInput }>('/:id/contacts', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const { href, etag } = req.query
    if (!href || !etag) return reply.code(400).send({ error: 'bad_request', message: 'href and etag are required' })
    if (!(await writable(dav, req.params.id, reply))) return
    try {
      await contactStore.deleteCard(dav, req.params.id, href, etag)
      return reply.code(204).send()
    } catch (e) {
      if (e instanceof EtagConflictError) {
        return reply
          .code(412)
          .send({ error: 'conflict', message: 'This contact was changed elsewhere. Reload and try again.' })
      }
      throw e
    }
  })

  app.get<{ Params: { id: string }; Querystring: { href?: string } }>('/:id/photo', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    if (!req.query.href) return reply.code(400).send({ error: 'bad_request', message: 'href is required' })
    const card = await contactStore.getCard(dav, req.params.id, req.query.href)
    const photo = photoFromCard(card.vcard)
    if (!photo) return reply.code(404).send({ error: 'not_found', message: 'No photo' })
    // Served inline into <img>; never let the browser sniff it into something executable.
    return reply
      .header('Content-Type', /^image\/(jpeg|png|gif|webp)$/.test(photo.mime) ? photo.mime : 'application/octet-stream')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=300')
      .send(photo.data)
  })

  app.get<{ Params: { id: string } }>('/:id/export', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const [books, cards] = await Promise.all([contactStore.discoverAddressBooks(dav), contactStore.getCards(dav, req.params.id)])
    const name = books.find((b) => b.id === req.params.id)?.displayName ?? 'contacts'
    return reply
      .header('Content-Type', 'text/vcard; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${sanitizeFilename(name)}.vcf"`)
      .send(cards.map((c) => c.vcard.trim().replace(/\r?\n/g, '\r\n') + '\r\n').join(''))
  })

  app.post<{ Params: { id: string }; Body: string }>('/:id/import', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    if (typeof req.body !== 'string' || !req.body.includes('BEGIN:VCARD')) {
      return reply.code(400).send({ error: 'bad_request', message: 'Expected a .vcf file' })
    }
    if (!(await writable(dav, req.params.id, reply))) return

    const existing = new Set((await contactStore.getCards(dav, req.params.id)).map((c) => vcardToContact(c.vcard, '', '', '', '').uid))
    const result: ImportResult = { imported: 0, skipped: 0 }
    for (const raw of splitVcf(req.body)) {
      // A card with no UID gets one derived from its content, so importing the
      // same file twice skips it rather than duplicating it.
      const { card, uid } = ensureUid(raw, `import-${createHash('sha1').update(raw).digest('hex')}`)
      if (existing.has(uid)) {
        result.skipped++
        continue
      }
      try {
        await contactStore.createCard(dav, req.params.id, card)
        existing.add(uid)
        result.imported++
      } catch (e) {
        req.log.warn({ err: e }, 'vCard import: card rejected')
        result.skipped++
      }
    }
    return reply.send(result)
  })

  // Groups are vCard CATEGORIES, so renaming one rewrites that line on every card carrying it.
  app.post<{ Params: { id: string }; Body: RenameGroupInput }>('/:id/groups/rename', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const from = typeof req.body?.from === 'string' ? req.body.from.trim() : ''
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : ''
    if (!from || !to) return reply.code(400).send({ error: 'bad_request', message: 'from and to are required' })
    if (!(await writable(dav, req.params.id, reply))) return

    const cards = (await contactStore.getCards(dav, req.params.id))
      .map((card) => ({ card, next: renameCategory(card.vcard, from, to) }))
      .filter((c): c is { card: RawCard; next: string } => c.next !== null)

    const result: RenameGroupResult = { updated: 0, failed: 0 }
    await mapConcurrent(cards, 6, async ({ card, next }) => {
      try {
        await contactStore.updateCard(dav, req.params.id, card.href, card.etag, next)
        result.updated++
      } catch (e) {
        req.log.warn({ err: e }, 'group rename failed for a card')
        result.failed++
      }
    })
    return reply.send(result)
  })

  // Moves a contact to another address book, or copies it (copies get a new UID
  // so the two cards stay distinct). A move is create-then-delete; if the delete
  // fails the new card is removed again so the contact never ends up in both.
  app.post<{ Params: { id: string }; Body: TransferContactInput }>('/:id/contacts/transfer', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const { href, etag, targetBookId, mode } = req.body ?? ({} as Partial<TransferContactInput>)
    if (!href || !etag || !targetBookId || (mode !== 'move' && mode !== 'copy')) {
      return reply.code(400).send({ error: 'bad_request', message: 'href, etag, targetBookId and mode are required' })
    }
    if (mode === 'move' && targetBookId === req.params.id) {
      return reply.code(400).send({ error: 'bad_request', message: 'Choose a different address book' })
    }
    const books = await contactStore.discoverAddressBooks(dav)
    const source: AddressBook | undefined = books.find((b) => b.id === req.params.id)
    const target: AddressBook | undefined = books.find((b) => b.id === targetBookId)
    if (!source || !target) return reply.code(404).send({ error: 'not_found', message: 'Address book not found' })
    if (target.readOnly || (mode === 'move' && source.readOnly)) {
      return reply.code(403).send({ error: 'forbidden', message: 'That address book is read-only' })
    }

    try {
      const current = await contactStore.getCard(dav, source.id, href)
      if (current.etag && current.etag !== etag) throw new EtagConflictError('Contact changed')
      const vcard = mode === 'copy' ? replaceUid(current.vcard, crypto.randomUUID()) : current.vcard
      const created = await contactStore.createCard(dav, target.id, vcard)
      const card = created.etag ? created : await contactStore.getCard(dav, target.id, created.href)
      if (mode === 'move') {
        try {
          await contactStore.deleteCard(dav, source.id, href, current.etag)
        } catch (e) {
          await contactStore.deleteCard(dav, target.id, card.href, card.etag).catch(() => undefined)
          throw e
        }
      }
      return reply.code(201).send(toContact(target.id, card))
    } catch (e) {
      if (e instanceof EtagConflictError) {
        return reply
          .code(412)
          .send({ error: 'conflict', message: 'This contact was changed elsewhere. Reload and try again.' })
      }
      throw e
    }
  })

  // Adds or removes one group on many contacts. Only the CATEGORIES line of
  // each card is edited, so nothing else on the card is renormalised.
  app.post<{ Params: { id: string }; Body: GroupMembersInput }>('/:id/groups/members', async (req, reply) => {
    const dav = requireSession(req, reply)
    if (!dav) return
    const body = req.body
    const add = typeof body?.add === 'string' ? body.add.trim() : ''
    const remove = typeof body?.remove === 'string' ? body.remove.trim() : ''
    const items = Array.isArray(body?.items) ? body.items : []
    if (!!add === !!remove || add.length > 200 || remove.length > 200) {
      return reply.code(400).send({ error: 'bad_request', message: 'Give exactly one group to add or remove' })
    }
    if (items.length === 0 || items.length > 200 || items.some((i) => typeof i?.href !== 'string' || !i.href)) {
      return reply.code(400).send({ error: 'bad_request', message: 'items must list 1 to 200 contacts' })
    }
    if (!(await writable(dav, req.params.id, reply))) return

    const result: GroupMembersResult = { updated: 0, unchanged: 0, failed: 0 }
    await mapConcurrent(items, 6, async (item) => {
      try {
        const card = await contactStore.getCard(dav, req.params.id, item.href)
        const next = editCategories(card.vcard, add ? { add } : { remove })
        if (next === null) {
          result.unchanged++
          return
        }
        await contactStore.updateCard(dav, req.params.id, card.href, card.etag, next)
        result.updated++
      } catch (e) {
        req.log.warn({ err: e }, 'group membership change failed for a card')
        result.failed++
      }
    })
    return reply.send(result)
  })
}
