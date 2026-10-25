import type { AddressBook, Contact, ContactInput } from '@yourdav/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'

const FRESH_MS = 30_000
const STORAGE_KEY_ACTIVE_BOOK = 'yourdav:active-address-book'

/** The "active book" value meaning every address book at once. */
export const ALL_BOOKS = 'all'

/** Sentinel for the "Not grouped" filter; a real category can't collide because it's never user-typed. */
export const UNGROUPED = '\u0000ungrouped'

export interface BatchResult {
  done: number
  failed: number
}

/** Sort key: family name, then given name, falling back to the display name. */
function sortKey(c: Contact): string {
  const { family, given } = c.name
  return (family || given ? `${family} ${given}` : c.fullName).toLocaleLowerCase()
}

function searchText(c: Contact): string {
  return [
    c.fullName,
    c.nickname,
    c.org,
    c.title,
    c.notes,
    ...c.emails.map((e) => e.value),
    ...c.phones.map((p) => p.value.replace(/[^\d+]/g, '')),
    ...c.phones.map((p) => p.value),
    ...c.categories,
  ]
    .join('\n')
    .toLocaleLowerCase()
}

function readActiveBook(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_ACTIVE_BOOK)
  } catch {
    return null
  }
}

function writeActiveBook(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY_ACTIVE_BOOK, id)
    else localStorage.removeItem(STORAGE_KEY_ACTIVE_BOOK)
  } catch {
    // storage unavailable (private window etc.) -- the choice just isn't remembered
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError || err instanceof Error ? err.message : fallback
}

export const useContactsStore = defineStore('contacts', () => {
  const addressBooks = ref<AddressBook[]>([])
  /** An address book id, ALL_BOOKS, or null before anything has loaded. */
  const activeBookId = ref<string | null>(readActiveBook())
  const contactsByBook = ref<Record<string, Contact[]>>({})
  const booksLoadedAt = ref(0)
  const contactsLoadedAt = ref<Record<string, number>>({})
  const selectedId = ref<string | null>(null)
  /** Contacts ticked for a batch action, as opposed to the one shown in the detail pane. */
  const checkedIds = ref<string[]>([])
  let lastCheckedId: string | null = null
  /** null = no group filter; UNGROUPED = contacts with no category; otherwise a category name. */
  const selectedGroup = ref<string | null>(null)
  const searchQuery = ref('')
  const loading = ref(false)
  const isRefreshing = ref(false)
  const error = ref<string | null>(null)

  const isAllBooks = computed(() => activeBookId.value === ALL_BOOKS)
  const activeBook = computed(() => addressBooks.value.find((b) => b.id === activeBookId.value) ?? null)
  const writableBooks = computed(() => addressBooks.value.filter((b) => !b.readOnly))
  const booksById = computed(() => new Map(addressBooks.value.map((b) => [b.id, b])))

  const contacts = computed<Contact[]>(() => {
    if (isAllBooks.value) return addressBooks.value.flatMap((b) => contactsByBook.value[b.id] ?? [])
    return activeBookId.value ? (contactsByBook.value[activeBookId.value] ?? []) : []
  })

  /** The book a brand-new contact goes into by default, or null when nothing is writable. */
  const createTargetBook = computed(() => {
    if (activeBook.value && !activeBook.value.readOnly) return activeBook.value
    return writableBooks.value[0] ?? null
  })

  const groups = computed(() => {
    const counts = new Map<string, number>()
    for (const c of contacts.value) for (const g of c.categories) counts.set(g, (counts.get(g) ?? 0) + 1)
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const ungroupedCount = computed(() => contacts.value.filter((c) => c.categories.length === 0).length)

  const filteredContacts = computed(() => {
    const q = searchQuery.value.trim().toLocaleLowerCase()
    const qDigits = q.replace(/[^\d+]/g, '')
    return contacts.value
      .filter((c) => {
        if (selectedGroup.value === UNGROUPED) return c.categories.length === 0
        if (selectedGroup.value) return c.categories.includes(selectedGroup.value)
        return true
      })
      .filter((c) => {
        if (!q) return true
        const text = searchText(c)
        return text.includes(q) || (qDigits.length >= 3 && text.includes(qDigits))
      })
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  })

  const selectedContact = computed(() => contacts.value.find((c) => c.id === selectedId.value) ?? null)

  const checkedSet = computed(() => new Set(checkedIds.value))
  const checkedContacts = computed(() => contacts.value.filter((c) => checkedSet.value.has(c.id)))

  function bookOf(contact: Contact): AddressBook | undefined {
    return booksById.value.get(contact.addressBookId)
  }

  function isReadOnly(contact: Contact): boolean {
    return bookOf(contact)?.readOnly ?? true
  }

  // --- loading ----------------------------------------------------------

  function setActiveBook(id: string | null): void {
    activeBookId.value = id
    writeActiveBook(id)
  }

  function isFresh(bookId: string): boolean {
    const at = contactsLoadedAt.value[bookId] ?? 0
    return at > 0 && Date.now() - at < FRESH_MS
  }

  /** Which address-book ids the current view needs contacts for. */
  function neededBooks(): string[] {
    if (isAllBooks.value) return addressBooks.value.map((b) => b.id)
    return activeBookId.value ? [activeBookId.value] : []
  }

  function putContacts(bookId: string, list: Contact[]): void {
    contactsByBook.value[bookId] = list
    contactsLoadedAt.value[bookId] = Date.now()
    const present = new Set(contacts.value.map((c) => c.id))
    if (selectedId.value && !present.has(selectedId.value)) selectedId.value = null
    if (checkedIds.value.some((id) => !present.has(id))) checkedIds.value = checkedIds.value.filter((id) => present.has(id))
    const g = selectedGroup.value
    if (g && g !== UNGROUPED && !contacts.value.some((c) => c.categories.includes(g))) selectedGroup.value = null
  }

  /** Where to land given what was remembered and what exists. */
  function resolveTarget(remembered: string | null, books: AddressBook[]): string | null {
    if (remembered && remembered !== ALL_BOOKS && books.some((b) => b.id === remembered)) return remembered
    // Several books default to the combined view; a single book is just that book.
    return books.length > 1 ? ALL_BOOKS : (books[0]?.id ?? null)
  }

  /** Loads contacts for one address book, or for all of them when given ALL_BOOKS. */
  async function loadContacts(bookId: string, force = false): Promise<void> {
    const ids = bookId === ALL_BOOKS ? addressBooks.value.map((b) => b.id) : [bookId]
    const stale = ids.filter((id) => force || !isFresh(id))
    if (stale.length === 0) return

    if (ids.some((id) => (contactsByBook.value[id]?.length ?? 0) > 0)) isRefreshing.value = true
    else loading.value = true
    error.value = null

    try {
      const results = await Promise.allSettled(stale.map(async (id) => putContacts(id, await api.getContacts(id))))
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) error.value = errorMessage(failed.reason, 'Failed to load contacts')
    } finally {
      loading.value = false
      isRefreshing.value = false
    }
  }

  async function loadAddressBooks(force = false): Promise<void> {
    const remembered = activeBookId.value
    const booksFresh = !force && booksLoadedAt.value > 0 && Date.now() - booksLoadedAt.value < FRESH_MS
    const needed = neededBooks()
    if (booksFresh && needed.length > 0 && needed.every(isFresh)) return

    // Only show the blocking spinner when there is nothing cached to show.
    if (needed.some((id) => (contactsByBook.value[id]?.length ?? 0) > 0)) isRefreshing.value = true
    else loading.value = true
    error.value = null

    try {
      // For a remembered concrete book, fetch its contacts in parallel with the book
      // list. A failure there (e.g. the book was deleted elsewhere) is not fatal --
      // the book-existence check below decides where to land.
      const parallel = remembered && remembered !== ALL_BOOKS && (force || !isFresh(remembered)) ? remembered : null
      const [books, list] = await Promise.all([
        booksFresh ? Promise.resolve(addressBooks.value) : api.getAddressBooks(),
        parallel ? api.getContacts(parallel).catch(() => null) : Promise.resolve(null),
      ])
      addressBooks.value = books
      booksLoadedAt.value = Date.now()

      const target = resolveTarget(remembered, books)
      if (target !== remembered) {
        setActiveBook(target)
        selectedId.value = null
        selectedGroup.value = null
        checkedIds.value = []
      }
      if (!target) return
      if (target === parallel && list) {
        putContacts(target, list)
      } else {
        // loadContacts manages the flags itself; let it start from a clean slate.
        loading.value = false
        isRefreshing.value = false
        await loadContacts(target, force || target !== remembered)
      }
    } catch (err) {
      error.value = errorMessage(err, 'Failed to load address books')
    } finally {
      loading.value = false
      isRefreshing.value = false
    }
  }

  async function selectAddressBook(id: string, force = false): Promise<void> {
    setActiveBook(id)
    selectedId.value = null
    selectedGroup.value = null
    checkedIds.value = []
    await loadContacts(id, force)
  }

  // --- single-contact changes ---------------------------------------------

  function removeFromCache(contact: Contact): void {
    const bookId = contact.addressBookId
    contactsByBook.value[bookId] = (contactsByBook.value[bookId] ?? []).filter((c) => c.id !== contact.id)
    checkedIds.value = checkedIds.value.filter((id) => id !== contact.id)
    if (selectedId.value === contact.id) selectedId.value = null
  }

  function addToCache(contact: Contact): void {
    const bookId = contact.addressBookId
    contactsByBook.value[bookId] = [...(contactsByBook.value[bookId] ?? []), contact]
  }

  async function createContact(bookId: string, input: ContactInput): Promise<Contact> {
    const created = await api.createContact(bookId, input)
    addToCache(created)
    contactsLoadedAt.value[bookId] = Date.now()
    selectedId.value = created.id
    return created
  }

  async function updateContact(existing: Contact, input: ContactInput): Promise<Contact> {
    const bookId = existing.addressBookId
    const updated = await api.updateContact(bookId, { ...input, href: existing.href, etag: existing.etag })
    contactsByBook.value[bookId] = (contactsByBook.value[bookId] ?? []).map((c) => (c.id === existing.id ? updated : c))
    contactsLoadedAt.value[bookId] = Date.now()
    // The id is derived from the href, so it is stable across an edit.
    selectedId.value = updated.id
    return updated
  }

  async function deleteContact(contact: Contact): Promise<void> {
    await api.deleteContact(contact.addressBookId, contact.href, contact.etag)
    removeFromCache(contact)
    contactsLoadedAt.value[contact.addressBookId] = Date.now()
  }

  async function transferContact(contact: Contact, targetBookId: string, mode: 'move' | 'copy'): Promise<Contact> {
    const created = await api.transferContact(contact.addressBookId, {
      href: contact.href,
      etag: contact.etag,
      targetBookId,
      mode,
    })
    if (mode === 'move') removeFromCache(contact)
    addToCache(created)
    contactsLoadedAt.value[contact.addressBookId] = Date.now()
    contactsLoadedAt.value[targetBookId] = Date.now()
    // In a single-book view the moved contact has left it; in the combined view it is still there.
    if (isAllBooks.value) selectedId.value = created.id
    return created
  }

  /**
   * Replaces `survivor` with the merged `input` and deletes `other`. If the delete
   * fails the survivor has already been updated, so say so rather than hiding it.
   */
  async function mergeContacts(survivor: Contact, other: Contact, input: ContactInput): Promise<Contact> {
    const updated = await updateContact(survivor, input)
    try {
      await deleteContact(other)
    } catch (err) {
      throw new Error(`The contacts were merged, but the second card could not be deleted: ${errorMessage(err, 'unknown error')}`)
    }
    selectedId.value = updated.id
    return updated
  }

  // --- batch actions ------------------------------------------------------

  function toggleChecked(id: string): void {
    checkedIds.value = checkedSet.value.has(id) ? checkedIds.value.filter((x) => x !== id) : [...checkedIds.value, id]
    lastCheckedId = id
  }

  /** Ticks every contact between the last one ticked and `id`, in list order. */
  function checkRange(id: string): void {
    const order = filteredContacts.value.map((c) => c.id)
    const from = lastCheckedId ? order.indexOf(lastCheckedId) : -1
    const to = order.indexOf(id)
    if (from === -1 || to === -1) return toggleChecked(id)
    const [a, b] = from < to ? [from, to] : [to, from]
    checkedIds.value = [...new Set([...checkedIds.value, ...order.slice(a, b + 1)])]
    lastCheckedId = id
  }

  function checkAll(): void {
    checkedIds.value = filteredContacts.value.map((c) => c.id)
  }

  function clearChecked(): void {
    checkedIds.value = []
    lastCheckedId = null
  }

  async function eachContact(list: Contact[], fn: (c: Contact) => Promise<unknown>): Promise<BatchResult> {
    const result: BatchResult = { done: 0, failed: 0 }
    for (const c of list) {
      try {
        await fn(c)
        result.done++
      } catch {
        result.failed++
      }
    }
    return result
  }

  function deleteContacts(list: Contact[]): Promise<BatchResult> {
    return eachContact(list, deleteContact)
  }

  function transferContacts(list: Contact[], targetBookId: string, mode: 'move' | 'copy'): Promise<BatchResult> {
    return eachContact(list, (c) => transferContact(c, targetBookId, mode))
  }

  /** Adds or removes one group on many contacts; only their CATEGORIES line is edited on the server. */
  async function setGroup(list: Contact[], change: { add: string } | { remove: string }): Promise<BatchResult> {
    const byBook = new Map<string, Contact[]>()
    for (const c of list) byBook.set(c.addressBookId, [...(byBook.get(c.addressBookId) ?? []), c])

    const result: BatchResult = { done: 0, failed: 0 }
    for (const [bookId, members] of byBook) {
      for (let i = 0; i < members.length; i += 200) {
        const chunk = members.slice(i, i + 200)
        try {
          const r = await api.setGroupMembers(bookId, { items: chunk.map((c) => ({ href: c.href, etag: c.etag })), ...change })
          result.done += r.updated + r.unchanged
          result.failed += r.failed
        } catch {
          result.failed += chunk.length
        }
      }
    }
    // The response doesn't carry the new cards, so re-read the books that changed.
    await Promise.all([...byBook.keys()].map((id) => loadContacts(id, true)))
    return result
  }

  /** Renames a group in every writable address book the current view covers. Returns how many cards failed. */
  async function renameGroup(from: string, to: string): Promise<number> {
    const bookIds = new Set(
      contacts.value.filter((c) => c.categories.includes(from) && !isReadOnly(c)).map((c) => c.addressBookId),
    )
    const results = await Promise.all([...bookIds].map((id) => api.renameGroup(id, from, to)))
    const failed = results.reduce((sum, r) => sum + r.failed, 0)
    const wasSelected = selectedGroup.value === from
    await Promise.all([...bookIds].map((id) => loadContacts(id, true)))
    if (wasSelected) selectedGroup.value = to
    return failed
  }

  // --- address books ------------------------------------------------------

  async function createAddressBook(displayName: string): Promise<AddressBook> {
    const created = await api.createAddressBook({ displayName })
    addressBooks.value = [...addressBooks.value, created]
    booksLoadedAt.value = Date.now()
    await selectAddressBook(created.id, true)
    return created
  }

  async function deleteAddressBook(id: string): Promise<void> {
    await api.deleteAddressBook(id)
    addressBooks.value = addressBooks.value.filter((b) => b.id !== id)
    booksLoadedAt.value = Date.now()
    delete contactsByBook.value[id]
    delete contactsLoadedAt.value[id]
    if (activeBookId.value === id || (isAllBooks.value && addressBooks.value.length < 2)) {
      const next = resolveTarget(null, addressBooks.value)
      setActiveBook(next)
      selectedId.value = null
      selectedGroup.value = null
      checkedIds.value = []
      if (next) await loadContacts(next, true)
    }
  }

  function clear(): void {
    addressBooks.value = []
    activeBookId.value = null
    contactsByBook.value = {}
    booksLoadedAt.value = 0
    contactsLoadedAt.value = {}
    selectedId.value = null
    checkedIds.value = []
    lastCheckedId = null
    selectedGroup.value = null
    searchQuery.value = ''
    loading.value = false
    isRefreshing.value = false
    error.value = null
  }

  return {
    addressBooks,
    writableBooks,
    booksById,
    activeBookId,
    activeBook,
    isAllBooks,
    createTargetBook,
    contacts,
    groups,
    ungroupedCount,
    filteredContacts,
    selectedId,
    selectedGroup,
    selectedContact,
    checkedIds,
    checkedContacts,
    searchQuery,
    loading,
    isRefreshing,
    error,
    bookOf,
    isReadOnly,
    loadAddressBooks,
    selectAddressBook,
    loadContacts,
    createContact,
    updateContact,
    deleteContact,
    transferContact,
    mergeContacts,
    toggleChecked,
    checkRange,
    checkAll,
    clearChecked,
    deleteContacts,
    transferContacts,
    setGroup,
    renameGroup,
    createAddressBook,
    deleteAddressBook,
    clear,
  }
})
