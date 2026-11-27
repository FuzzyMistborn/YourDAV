<script setup lang="ts">
import type { Contact, ContactInput, LabeledValue, PostalAddress, StructuredName } from '@yourdav/shared'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'
import AppNavSwitcher from '../components/AppNavSwitcher.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ConflictDialog from '../components/ConflictDialog.vue'
import BookMenu from '../components/BookMenu.vue'
import ContactAvatar from '../components/ContactAvatar.vue'
import GroupMenu from '../components/GroupMenu.vue'
import MergeDialog from '../components/MergeDialog.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import {
  addressLines,
  ADDRESS_TYPES,
  autoName,
  EMAIL_TYPES,
  formatDate,
  imageToDataUri,
  PHONE_TYPES,
  primaryType,
  typeLabel,
  typeName,
  URL_TYPES,
} from '../lib/labels.js'
import { t } from '../i18n.js'
import { ALL_BOOKS, UNGROUPED, useContactsStore } from '../stores/contacts.js'
import { useSessionStore } from '../stores/session.js'
import { useSettingsStore } from '../stores/settings.js'

const contactsStore = useContactsStore()
const session = useSessionStore()
const settings = useSettingsStore()

const showSettingsDialog = ref(false)
const confirmingDelete = ref<Contact | null>(null)
const confirmingDeleteBook = ref<string | null>(null)
const isEditing = ref(false)
const isCreating = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)
const newBookName = ref('')
const showNewBookForm = ref(false)
const newBookInput = ref<HTMLInputElement | null>(null)
const bookError = ref<string | null>(null)
const renamingGroup = ref<string | null>(null)
const renameValue = ref('')
const savingGroup = ref<{ from: string; to: string } | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const importMessage = ref<string | null>(null)

// The selected book (a concrete one, not "all") being read-only blocks creating,
// importing and renaming groups; whether one contact can be edited depends on
// the book that contact lives in.
const activeReadOnly = computed(() => !!contactsStore.activeBook?.readOnly)
const canCreate = computed(() => !!contactsStore.createTargetBook && !activeReadOnly.value)
const selectedReadOnly = computed(() => {
  const c = contactsStore.selectedContact
  return c ? contactsStore.isReadOnly(c) : false
})
const createBookId = ref('')
const selectMode = ref(false)
const confirmingBatchDelete = ref(false)
const mergePair = ref<[Contact, Contact] | null>(null)
const merging = ref(false)
const mergeError = ref<string | null>(null)
const working = ref(false)
const status = ref<{ text: string; error: boolean } | null>(null)
let statusTimer: ReturnType<typeof setTimeout> | undefined
const showUrl = ref(false)
const urlCopied = ref(false)
const urlInput = ref<HTMLInputElement | null>(null)
const editing = computed(() => isCreating.value || isEditing.value)

// --- Edit/create form ---------------------------------------------------

interface FormState {
  name: StructuredName
  /** Only set when the stored display name differs from the one generated from the name parts. */
  fullName: string
  nickname: string
  org: string
  title: string
  emails: LabeledValue[]
  phones: LabeledValue[]
  urls: LabeledValue[]
  addresses: PostalAddress[]
  birthday: string
  anniversary: string
  notes: string
  categories: string[]
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function emptyName(): StructuredName {
  return { family: '', given: '', additional: '', prefix: '', suffix: '' }
}

function emptyAddress(): PostalAddress {
  return { types: ['home'], poBox: '', extended: '', street: '', locality: '', region: '', postalCode: '', country: '' }
}

function emptyForm(): FormState {
  return {
    name: emptyName(),
    fullName: '',
    nickname: '',
    org: '',
    title: '',
    emails: [{ value: '', types: ['work'], pref: false }],
    phones: [{ value: '', types: ['cell'], pref: false }],
    urls: [],
    addresses: [],
    birthday: '',
    anniversary: '',
    notes: '',
    categories: [],
  }
}

function formFrom(c: Contact): FormState {
  return {
    name: { ...emptyName(), ...clone(c.name) },
    fullName: c.fullName !== autoName(c.name, c.org) ? c.fullName : '',
    nickname: c.nickname,
    org: c.org,
    title: c.title,
    emails: clone(c.emails),
    phones: clone(c.phones),
    urls: clone(c.urls),
    addresses: clone(c.addresses),
    birthday: c.birthday,
    anniversary: c.anniversary,
    notes: c.notes,
    categories: [...c.categories],
  }
}

const form = reactive<FormState>(emptyForm())
// undefined = leave the stored photo alone, null = remove it, string = replace it.
const photo = ref<string | null | undefined>(undefined)
const photoError = ref<string | null>(null)
const newCategory = ref('')

const nameMissing = computed(() => !autoName(form.name, form.org) && !form.fullName.trim())
const dateRe = /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})?$/
const dateError = computed(() =>
  dateRe.test(form.birthday.trim()) && dateRe.test(form.anniversary.trim())
    ? null
    : t('contacts.dateFormat'),
)
const categorySuggestions = computed(() =>
  contactsStore.groups.map((g) => g.name).filter((g) => !form.categories.includes(g)),
)

// Preview for the photo picker: the stored photo unless it was removed or replaced.
const previewContact = computed<Contact>(() => {
  const base = isEditing.value ? contactsStore.selectedContact : null
  return {
    ...(base ?? ({ id: '', addressBookId: '', href: '', etag: '', uid: 'new' } as Contact)),
    fullName: autoName(form.name, form.org) || form.fullName || '?',
    hasPhoto: photo.value === undefined && !!base?.hasPhoto,
  }
})
const previewSrc = computed(() => (typeof photo.value === 'string' ? photo.value : null))
const showRemovePhoto = computed(() => typeof photo.value === 'string' || previewContact.value.hasPhoto)

onMounted(async () => {
  await contactsStore.loadAddressBooks()
})

async function onLogout(): Promise<void> {
  await session.logout()
  window.location.href = '/login'
}

function selectContact(contact: Contact): void {
  contactsStore.selectedId = contact.id
  closeEditor()
}

// --- Selection, move/copy and batch actions ------------------------------

function flash(text: string, error = false): void {
  status.value = { text, error }
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => (status.value = null), error ? 8000 : 4000)
}

function contactCount(n: number): string {
  return t('contacts.count', { n }, n)
}

type BatchKind = 'moved' | 'copied' | 'added' | 'removed' | 'deleted'

/** Summarises a batch result as a status line. */
function report(kind: BatchKind, r: { done: number; failed: number }, params: { book?: string; group?: string } = {}): void {
  if (r.failed === 0) flash(t(`contacts.batch.${kind}`, { n: r.done, ...params }, r.done))
  else flash(t(`contacts.batch.${kind}Partial`, { done: r.done, failed: r.failed, ...params }), true)
}

const selecting = computed(() => selectMode.value || contactsStore.checkedIds.length > 0)
const checked = computed(() => contactsStore.checkedContacts)
const checkedWritable = computed(() => checked.value.length > 0 && checked.value.every((c) => !contactsStore.isReadOnly(c)))
const allChecked = computed(
  () => contactsStore.filteredContacts.length > 0 && contactsStore.checkedIds.length === contactsStore.filteredContacts.length,
)

function onRowClick(e: MouseEvent, contact: Contact): void {
  if (e.shiftKey) contactsStore.checkRange(contact.id)
  else if (e.ctrlKey || e.metaKey) contactsStore.toggleChecked(contact.id)
  else selectContact(contact)
}

function onCheck(e: MouseEvent, contact: Contact): void {
  if (e.shiftKey) contactsStore.checkRange(contact.id)
  else contactsStore.toggleChecked(contact.id)
}

function toggleSelectAll(): void {
  if (allChecked.value) contactsStore.clearChecked()
  else contactsStore.checkAll()
}

function clearSelection(): void {
  contactsStore.clearChecked()
  selectMode.value = false
}

/** The one address book every contact in `list` shares, if they all share one. */
function commonBookId(list: Contact[]): string | null {
  const ids = new Set(list.map((c) => c.addressBookId))
  return ids.size === 1 ? [...ids][0] : null
}

// Targets for the move/copy menu, for the contact in the detail pane...
const detailMoveTargets = computed(() => {
  const c = contactsStore.selectedContact
  if (!c || contactsStore.isReadOnly(c)) return []
  return contactsStore.writableBooks.filter((b) => b.id !== c.addressBookId)
})
const detailCopyTargets = computed(() => {
  const c = contactsStore.selectedContact
  return c ? contactsStore.writableBooks.filter((b) => b.id !== c.addressBookId) : []
})
// ...and for the ticked batch. Copying out of a read-only book is fine; moving is not.
const batchMoveTargets = computed(() => {
  if (!checkedWritable.value) return []
  const only = commonBookId(checked.value)
  return contactsStore.writableBooks.filter((b) => b.id !== only)
})
const batchCopyTargets = computed(() => {
  const only = commonBookId(checked.value)
  return contactsStore.writableBooks.filter((b) => b.id !== only)
})
const selectionGroups = computed(() => [...new Set(checked.value.flatMap((c) => c.categories))].sort())
const allGroupNames = computed(() => contactsStore.groups.map((g) => g.name))

async function guarded(fn: () => Promise<void>): Promise<void> {
  if (working.value) return
  working.value = true
  try {
    await fn()
  } catch (err) {
    flash(err instanceof Error ? err.message : t('common.somethingWrong'), true)
  } finally {
    working.value = false
  }
}

function bookName(id: string): string {
  return contactsStore.booksById.get(id)?.displayName ?? t('contacts.theBook')
}

function onTransfer(bookId: string, mode: 'move' | 'copy'): Promise<void> {
  const c = contactsStore.selectedContact
  if (!c) return Promise.resolve()
  return guarded(async () => {
    await contactsStore.transferContact(c, bookId, mode)
    flash(t(mode === 'move' ? 'contacts.movedOne' : 'contacts.copiedOne', { name: c.fullName, book: bookName(bookId) }))
  })
}

function onBatchTransfer(bookId: string, mode: 'move' | 'copy'): Promise<void> {
  // A move skips contacts already in the target; there is nothing to do for them.
  const list = checked.value.filter((c) => mode === 'copy' || c.addressBookId !== bookId)
  return guarded(async () => {
    const r = await contactsStore.transferContacts(list, bookId, mode)
    contactsStore.clearChecked()
    report(mode === 'move' ? 'moved' : 'copied', r, { book: bookName(bookId) })
  })
}

function onBatchGroup(change: { add: string } | { remove: string }): Promise<void> {
  const list = [...checked.value]
  return guarded(async () => {
    const r = await contactsStore.setGroup(list, change)
    const name = 'add' in change ? change.add : change.remove
    report('add' in change ? 'added' : 'removed', r, { group: name })
  })
}

/** Exactly two ticked contacts, both editable, can be merged. */
const canMerge = computed(() => checked.value.length === 2 && checkedWritable.value)

function startMerge(): void {
  if (!canMerge.value) return
  // Present them in list order so "first card" is the one that sorts first.
  const order = contactsStore.filteredContacts.map((c) => c.id)
  const [x, y] = [...checked.value].sort((p, q) => order.indexOf(p.id) - order.indexOf(q.id))
  mergeError.value = null
  mergePair.value = [x, y]
}

async function onMerge(survivor: Contact, other: Contact, input: ContactInput): Promise<void> {
  if (merging.value) return
  merging.value = true
  mergeError.value = null
  try {
    const merged = await contactsStore.mergeContacts(survivor, other, input)
    mergePair.value = null
    contactsStore.clearChecked()
    flash(t('contacts.merged', { name: merged.fullName }))
  } catch (err) {
    mergeError.value = err instanceof Error ? err.message : t('contacts.mergeFailed')
  } finally {
    merging.value = false
  }
}

function onBatchDelete(): Promise<void> {
  const list = [...checked.value]
  confirmingBatchDelete.value = false
  return guarded(async () => {
    const r = await contactsStore.deleteContacts(list)
    report('deleted', r)
  })
}

function openEditor(): void {
  saveError.value = null
  photo.value = undefined
  photoError.value = null
  newCategory.value = ''
}

function closeEditor(): void {
  isEditing.value = false
  isCreating.value = false
  saveError.value = null
}

function startCreate(): void {
  const target = contactsStore.createTargetBook
  if (!canCreate.value || !target) return
  createBookId.value = target.id
  contactsStore.selectedId = null
  Object.assign(form, emptyForm())
  openEditor()
  isEditing.value = false
  isCreating.value = true
}

function startEdit(): void {
  const c = contactsStore.selectedContact
  if (!c || selectedReadOnly.value) return
  Object.assign(form, formFrom(c))
  openEditor()
  isCreating.value = false
  isEditing.value = true
}

function cancelEdit(): void {
  closeEditor()
}

// Editing a type through the select keeps any extra tokens (e.g. 'voice') so
// an untouched row round-trips as it was stored.
function onType(v: LabeledValue | PostalAddress, known: readonly string[], e: Event): void {
  const picked = (e.target as HTMLSelectElement).value
  const extra = v.types.filter((x) => !known.includes(x))
  v.types = picked ? [picked, ...extra] : extra
}

function addEmail(): void {
  form.emails.push({ value: '', types: ['work'], pref: false })
}
function addPhone(): void {
  form.phones.push({ value: '', types: ['cell'], pref: false })
}
function addUrl(): void {
  form.urls.push({ value: '', types: [], pref: false })
}
function addAddress(): void {
  form.addresses.push(emptyAddress())
}

function addCategory(name = newCategory.value): void {
  for (const part of name.split(',')) {
    const group = part.trim()
    if (group && !form.categories.includes(group)) form.categories.push(group)
  }
  newCategory.value = ''
}

async function onPhoto(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  photoError.value = null
  try {
    photo.value = await imageToDataUri(file)
  } catch (err) {
    photoError.value = err instanceof Error ? err.message : t('contacts.imageFailed')
  }
}

function buildInput(): ContactInput {
  return clone({
    name: form.name,
    fullName: form.fullName.trim() || undefined,
    nickname: form.nickname,
    org: form.org,
    title: form.title,
    emails: form.emails.filter((e) => e.value.trim()),
    phones: form.phones.filter((p) => p.value.trim()),
    urls: form.urls.filter((u) => u.value.trim()),
    addresses: form.addresses.filter((a) =>
      [a.poBox, a.extended, a.street, a.locality, a.region, a.postalCode, a.country].some((x) => x.trim()),
    ),
    birthday: form.birthday.trim(),
    anniversary: form.anniversary.trim(),
    notes: form.notes,
    categories: form.categories,
    ...(photo.value !== undefined ? { photo: photo.value } : {}),
  })
}

// A save or delete that loses the etag race (412) reloads the book and asks
// whether to discard or reapply against the fresh etag -- last-write-wins, the
// same as the calendar side, rather than leaving a stale etag in the cache that
// would make every retry fail.
type PendingConflict =
  | { kind: 'update'; contact: Contact; input: ContactInput }
  | { kind: 'delete'; contact: Contact }
const pendingConflict = ref<PendingConflict | null>(null)
const conflictServerContact = ref<Contact | null>(null)
const conflictServerVersion = computed(() => {
  const c = conflictServerContact.value
  if (!c) return null
  return { title: c.fullName || t('contacts.noName'), detail: c.org || c.emails[0]?.value || c.phones[0]?.value || '' }
})

function attemptedName(input: ContactInput): string {
  return input.fullName || [input.name.given, input.name.family].filter(Boolean).join(' ') || t('contacts.noName')
}

async function openConflict(conflict: PendingConflict): Promise<void> {
  await contactsStore.loadContacts(conflict.contact.addressBookId, true)
  conflictServerContact.value = contactsStore.contacts.find((c) => c.id === conflict.contact.id) ?? null
  pendingConflict.value = conflict
}

async function saveContact(): Promise<void> {
  const bookId = isCreating.value ? createBookId.value : (contactsStore.selectedContact?.addressBookId ?? '')
  if (!bookId || saving.value || nameMissing.value || dateError.value) return
  addCategory()
  saving.value = true
  saveError.value = null
  try {
    const input = buildInput()
    if (isCreating.value) {
      await contactsStore.createContact(bookId, input)
    } else if (isEditing.value && contactsStore.selectedContact) {
      const contact = contactsStore.selectedContact
      try {
        await contactsStore.updateContact(contact, input)
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 412) {
          await openConflict({ kind: 'update', contact, input })
          return
        }
        throw err
      }
    }
    closeEditor()
  } catch (err) {
    saveError.value = err instanceof ApiRequestError ? err.message : t('contacts.saveFailed')
  } finally {
    saving.value = false
  }
}

async function onDeleteContact(): Promise<void> {
  const contact = confirmingDelete.value
  confirmingDelete.value = null
  if (!contact) return
  try {
    await contactsStore.deleteContact(contact)
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 412) {
      await openConflict({ kind: 'delete', contact })
      return
    }
    contactsStore.error = err instanceof ApiRequestError ? err.message : t('contacts.deleteFailed')
  }
}

function onConflictDiscard(): void {
  const conflict = pendingConflict.value
  pendingConflict.value = null
  conflictServerContact.value = null
  // Edits are dropped: the form would otherwise keep showing a version that no
  // longer exists (or, if it was deleted elsewhere, has nothing to save onto).
  if (conflict?.kind === 'update') closeEditor()
}

async function onConflictReapply(): Promise<void> {
  const conflict = pendingConflict.value
  const fresh = conflictServerContact.value
  pendingConflict.value = null
  conflictServerContact.value = null
  if (!conflict || !fresh) return

  if (conflict.kind === 'delete') {
    await onRetryDelete(fresh)
    return
  }
  saving.value = true
  saveError.value = null
  try {
    await contactsStore.updateContact(fresh, conflict.input)
    closeEditor()
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 412) {
      await openConflict({ kind: 'update', contact: fresh, input: conflict.input })
      return
    }
    saveError.value = err instanceof ApiRequestError ? err.message : t('contacts.saveFailed')
  } finally {
    saving.value = false
  }
}

async function onRetryDelete(contact: Contact): Promise<void> {
  try {
    await contactsStore.deleteContact(contact)
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 412) {
      await openConflict({ kind: 'delete', contact })
      return
    }
    contactsStore.error = err instanceof ApiRequestError ? err.message : t('contacts.deleteFailed')
  }
}

// --- Address books ------------------------------------------------------

function toggleNewBookForm(): void {
  showNewBookForm.value = !showNewBookForm.value
  bookError.value = null
  if (showNewBookForm.value) {
    newBookName.value = ''
    void nextTick(() => newBookInput.value?.focus())
  }
}

async function createBook(): Promise<void> {
  const name = newBookName.value.trim()
  if (!name) return
  bookError.value = null
  try {
    await contactsStore.createAddressBook(name)
    newBookName.value = ''
    showNewBookForm.value = false
    closeEditor()
  } catch (err) {
    bookError.value = err instanceof ApiRequestError ? err.message : t('contacts.bookCreateFailed')
  }
}

async function onDeleteBook(): Promise<void> {
  const id = confirmingDeleteBook.value
  confirmingDeleteBook.value = null
  if (!id) return
  try {
    await contactsStore.deleteAddressBook(id)
    closeEditor()
  } catch (err) {
    bookError.value = err instanceof ApiRequestError ? err.message : t('contacts.bookDeleteFailed')
  }
}

function pickBook(id: string): void {
  closeEditor()
  void contactsStore.selectAddressBook(id)
}

// --- Groups, import & export --------------------------------------------

// Only one group is ever being renamed, so a plain function ref is enough
// (a template ref inside v-for would be an array).
let renameInputEl: HTMLInputElement | null = null
function setRenameInput(el: unknown): void {
  renameInputEl = el as HTMLInputElement | null
}

function startRename(name: string): void {
  if (savingGroup.value) return
  renamingGroup.value = name
  renameValue.value = name
  // Focus explicitly: `autofocus` is unreliable on elements added after load.
  void nextTick(() => {
    renameInputEl?.focus()
    renameInputEl?.select()
  })
}

function cancelRename(): void {
  renamingGroup.value = null
  renameValue.value = ''
}

function onRenameBlur(): void {
  // If the user cancelled via Escape, renamingGroup is already null.
  if (renamingGroup.value !== null) {
    void submitRename()
  }
}

let isRenaming = false
async function submitRename(): Promise<void> {
  if (isRenaming) return
  const from = renamingGroup.value
  const to = renameValue.value.trim()
  if (!from) return
  renamingGroup.value = null
  renameValue.value = ''
  if (!to || to === from) return

  isRenaming = true
  savingGroup.value = { from, to }
  try {
    const failed = await contactsStore.renameGroup(from, to)
    if (failed > 0) bookError.value = t('contacts.renameFailed', { n: failed }, failed)
  } catch (err) {
    bookError.value = err instanceof ApiRequestError ? err.message : t('contacts.groupRenameFailed')
  } finally {
    isRenaming = false
    if (savingGroup.value?.from === from) {
      savingGroup.value = null
    }
  }
}

async function onImport(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const bookId = contactsStore.activeBook?.id
  if (!file || !bookId) return
  importMessage.value = null
  try {
    const result = await api.importVcf(bookId, await file.text())
    importMessage.value = t('contacts.importResult', { imported: result.imported, skipped: result.skipped })
    await contactsStore.loadContacts(bookId, true)
  } catch (err) {
    importMessage.value = err instanceof ApiRequestError ? err.message : t('contacts.importFailed')
  }
}

async function copyUrl(): Promise<void> {
  const url = contactsStore.activeBook?.url
  if (!url) return
  urlInput.value?.select()
  try {
    // Only available in a secure context (https or localhost); otherwise the
    // text is left selected for a manual copy.
    await navigator.clipboard.writeText(url)
    urlCopied.value = true
    setTimeout(() => (urlCopied.value = false), 1500)
  } catch {
    urlCopied.value = false
  }
}

// --- Display helpers ----------------------------------------------------

function addressLinesFor(a: PostalAddress): string[] {
  return addressLines(a, settings.addressFormat)
}

function mapUrl(a: PostalAddress): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(addressLinesFor(a).join(', '))}`
}

// Only link schemes that are safe to follow from a contact someone else may have authored.
function safeHref(u: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`
  return /^https?:\/\//i.test(withScheme) ? withScheme : null
}

const contactCountLabel = computed(() => {
  return contactCount(contactsStore.filteredContacts.length)
})
</script>

<template>
  <div class="layout">
    <!-- Sidebar: Exactly mirrors CalendarView.vue dimensions & structure -->
    <aside class="sidebar">
      <AppNavSwitcher />

      <div class="sidebar__actions">
        <button
          class="btn btn-primary sidebar__new"
          :disabled="!canCreate"
          :title="canCreate ? $t('contacts.createTitle') : $t('contacts.bookReadOnly')"
          @click="startCreate"
        >
          <span aria-hidden="true">+</span> {{ $t('contacts.newContact') }}
        </button>
      </div>

      <div v-if="contactsStore.activeBook" class="sidebar__io">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="activeReadOnly" @click="importInput?.click()">
          {{ $t('contacts.importVcf') }}
        </button>
        <a class="btn btn-ghost btn-sm" :href="api.exportUrl(contactsStore.activeBook.id)" download>{{ $t('common.export') }}</a>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :aria-pressed="showUrl"
          :title="$t('contacts.urlTitle')"
          @click="showUrl = !showUrl"
        >
          {{ $t('contacts.url') }}
        </button>
        <input ref="importInput" type="file" accept=".vcf,text/vcard" hidden @change="onImport" />
      </div>
      <p v-else-if="contactsStore.isAllBooks" class="sidebar__note">
        {{ $t('contacts.pickBook') }}
      </p>
      <div v-if="showUrl && contactsStore.activeBook" class="sidebar__url">
        <label for="carddav-url">{{ $t('contacts.carddavUrl') }}</label>
        <div class="sidebar__url-row">
          <input
            id="carddav-url"
            ref="urlInput"
            class="address-books__new-input"
            type="text"
            readonly
            :value="contactsStore.activeBook.url"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button type="button" class="btn btn-secondary btn-sm" @click="copyUrl">
            {{ urlCopied ? $t('contacts.copied') : $t('contacts.copy') }}
          </button>
        </div>
      </div>
      <p v-if="importMessage" class="sidebar__note">{{ importMessage }}</p>

      <!-- Address Books Section (Mirrors CalendarList.vue) -->
      <div class="address-books">
        <div class="address-books__header">
          <h2 class="address-books__heading">{{ $t('contacts.books') }}</h2>
          <button type="button" class="icon-add-btn" :title="$t('contacts.newBook')" @click="toggleNewBookForm">+</button>
        </div>

        <form
          v-if="showNewBookForm"
          class="address-books__new-form"
          @submit.prevent="createBook"
          @keydown.esc="showNewBookForm = false"
        >
          <input
            ref="newBookInput"
            v-model="newBookName"
            type="text"
            :placeholder="$t('contacts.bookNamePlaceholder')"
            class="address-books__new-input"
          />
          <div class="address-books__new-row">
            <button type="button" class="btn btn-ghost btn-sm" @click="showNewBookForm = false">{{ $t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary btn-sm" :disabled="!newBookName.trim()">{{ $t('common.save') }}</button>
          </div>
        </form>

        <ul class="address-books__list">
          <li
            v-if="contactsStore.addressBooks.length > 1"
            class="address-books__item"
            :class="{ 'address-books__item--active': contactsStore.isAllBooks }"
            @click="pickBook(ALL_BOOKS)"
          >
            <span class="address-books__icon" aria-hidden="true">📚</span>
            <span class="address-books__name">{{ $t('contacts.allBooks') }}</span>
          </li>
          <li
            v-for="book in contactsStore.addressBooks"
            :key="book.id"
            class="address-books__item"
            :class="{ 'address-books__item--active': book.id === contactsStore.activeBookId }"
            @click="pickBook(book.id)"
          >
            <span class="address-books__icon" aria-hidden="true">📇</span>
            <span class="address-books__name" :title="book.displayName">{{ book.displayName }}</span>
            <button
              v-if="contactsStore.addressBooks.length > 1 && !book.readOnly"
              type="button"
              class="icon-remove-btn address-books__delete"
              :title="$t('contacts.deleteBook')"
              @click.stop="confirmingDeleteBook = book.id"
            >
              ×
            </button>
          </li>
        </ul>
        <p v-if="bookError" class="sidebar__error">{{ bookError }}</p>
      </div>

      <!-- Groups (vCard CATEGORIES) of the active address book -->
      <div v-if="contactsStore.groups.length > 0" class="address-books">
        <div class="address-books__header">
          <h2 class="address-books__heading">{{ $t('contact.groups') }}</h2>
        </div>
        <ul class="address-books__list">
          <li
            class="address-books__item"
            :class="{ 'address-books__item--active': contactsStore.selectedGroup === null }"
            @click="contactsStore.selectedGroup = null"
          >
            <span class="address-books__name">{{ $t('contacts.allContacts') }}</span>
            <span class="address-books__count">{{ contactsStore.contacts.length }}</span>
          </li>
          <li
            v-for="g in contactsStore.groups"
            :key="g.name"
            class="address-books__item"
            :class="{
              'address-books__item--active':
                contactsStore.selectedGroup === g.name ||
                (savingGroup?.from === g.name && contactsStore.selectedGroup === savingGroup.to),
              'address-books__item--saving': savingGroup?.from === g.name,
            }"
            @click="contactsStore.selectedGroup = g.name"
          >
            <form
              v-if="renamingGroup === g.name"
              class="address-books__rename"
              @click.stop
              @submit.prevent="submitRename"
              @keydown.esc="cancelRename"
            >
              <input
                :ref="setRenameInput"
                v-model="renameValue"
                type="text"
                class="address-books__new-input"
                :aria-label="$t('contacts.groupName')"
                @blur="onRenameBlur"
              />
            </form>
            <template v-else>
              <span class="address-books__name" :title="savingGroup?.from === g.name ? savingGroup.to : g.name">
                {{ savingGroup?.from === g.name ? savingGroup.to : g.name }}
              </span>
              <!-- The count and the rename button share one right-aligned slot:
                   the count shows at rest, the button replaces it on hover/focus.
                   While saving, a spinner replaces both. -->
              <span class="address-books__trail">
                <span
                  v-if="savingGroup?.from === g.name"
                  class="address-books__spinner"
                  role="status"
                  :aria-label="$t('contacts.savingGroup')"
                  :title="$t('common.saving')"
                ></span>
                <template v-else>
                  <span class="address-books__count">{{ g.count }}</span>
                  <button
                    v-if="!activeReadOnly"
                    type="button"
                    class="address-books__edit"
                    :title="$t('contacts.renameGroup')"
                    :aria-label="$t('contacts.renameGroup')"
                    @click.stop="startRename(g.name)"
                  >
                    ✎
                  </button>
                </template>
              </span>
            </template>
          </li>
          <li
            v-if="contactsStore.ungroupedCount > 0"
            class="address-books__item"
            :class="{ 'address-books__item--active': contactsStore.selectedGroup === UNGROUPED }"
            @click="contactsStore.selectedGroup = UNGROUPED"
          >
            <span class="address-books__name">{{ $t('contacts.ungrouped') }}</span>
            <span class="address-books__count">{{ contactsStore.ungroupedCount }}</span>
          </li>
        </ul>
      </div>

      <!-- User footer: Exactly mirrors CalendarView.vue -->
      <div class="sidebar__user">
        <div class="sidebar__username-row">
          <span class="sidebar__avatar">{{ (session.info?.username ?? '?').slice(0, 1).toUpperCase() }}</span>
          <span class="sidebar__username">{{ session.info?.username }}</span>
        </div>
        <div class="sidebar__user-actions">
          <button
            type="button"
            class="btn btn-ghost sidebar__settings-btn"
            :title="$t('settings.title')"
            @click="showSettingsDialog = true"
          >
            <span aria-hidden="true">⚙️</span> {{ $t('settings.title') }}
          </button>
          <button class="btn btn-ghost sidebar__signout" @click="onLogout">{{ $t('common.signOut') }}</button>
        </div>
      </div>
    </aside>

    <!-- Main Content: Framed inside the exact same card style as CalendarView -->
    <main class="main">
      <div class="contacts-card">
        <!-- Middle Column: Contacts List -->
        <section class="contacts-list-pane">
          <div class="contacts-list-header">
            <div class="search-box-wrap">
              <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                v-model="contactsStore.searchQuery"
                type="text"
                class="search-input"
                :placeholder="$t('contacts.searchPlaceholder')"
              />
            </div>
            <div class="contacts-list-header__row">
              <span class="contacts-count">{{ contactCountLabel }}</span>
              <button
                type="button"
                class="btn-text"
                :aria-pressed="selectMode"
                :title="$t('contacts.selectTitle')"
                @click="selectMode ? clearSelection() : (selectMode = true)"
              >
                {{ selecting ? $t('common.done') : $t('contacts.select') }}
              </button>
            </div>
          </div>

          <div v-if="contactsStore.checkedIds.length > 0" class="batch-bar">
            <div class="batch-bar__top">
              <strong>{{ $t('contacts.selected', { n: contactsStore.checkedIds.length }, contactsStore.checkedIds.length) }}</strong>
              <button type="button" class="btn-text" @click="toggleSelectAll">
                {{ allChecked ? $t('contacts.selectNone') : $t('contacts.selectAll') }}
              </button>
            </div>
            <div class="batch-bar__actions">
              <BookMenu
                :label="$t('contacts.moveCopy')"
                :move-targets="batchMoveTargets"
                :copy-targets="batchCopyTargets"
                @pick="onBatchTransfer"
              />
              <GroupMenu
                v-if="checkedWritable"
                :groups="allGroupNames"
                :removable="selectionGroups"
                @add="(name) => onBatchGroup({ add: name })"
                @remove="(name) => onBatchGroup({ remove: name })"
              />
              <button
                v-if="contactsStore.checkedIds.length === 2"
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="!canMerge || working"
                :title="canMerge ? $t('contacts.mergeTitle') : $t('contacts.someReadOnly')"
                @click="startMerge"
              >
                {{ $t('contacts.merge') }}
              </button>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                :disabled="!checkedWritable || working"
                :title="checkedWritable ? $t('contacts.deleteSelected') : $t('contacts.someReadOnly')"
                @click="confirmingBatchDelete = true"
              >
                {{ $t('common.delete') }}
              </button>
            </div>
          </div>
          <p v-if="status" class="list-status" :class="{ 'list-status--error': status.error }" role="status">
            {{ status.text }}
          </p>

          <div v-if="contactsStore.error" class="pane-state pane-state--error">{{ contactsStore.error }}</div>
          <div v-else-if="contactsStore.loading && contactsStore.contacts.length === 0" class="pane-state">{{ $t('contacts.loading') }}</div>
          <div v-else-if="contactsStore.filteredContacts.length === 0" class="pane-state">
            <p v-if="contactsStore.searchQuery">{{ $t('contacts.noMatch') }}</p>
            <p v-else>{{ $t('contacts.emptyBook') }}</p>
          </div>
          <ul v-else class="contact-items">
            <li
              v-for="contact in contactsStore.filteredContacts"
              :key="contact.id"
              class="contact-item"
              :class="{
                'contact-item--active': contact.id === contactsStore.selectedId && !isCreating,
                'contact-item--checked': contactsStore.checkedIds.includes(contact.id),
              }"
              @click="onRowClick($event, contact)"
            >
              <div class="contact-item__lead" :class="{ 'contact-item__lead--selecting': selecting }">
                <ContactAvatar class="contact-item__avatar" :contact="contact" />
                <input
                  type="checkbox"
                  class="contact-item__check"
                  :checked="contactsStore.checkedIds.includes(contact.id)"
                  :aria-label="$t('contacts.selectOne', { name: contact.fullName })"
                  @click.stop="onCheck($event, contact)"
                />
              </div>
              <div class="contact-item__info">
                <span class="contact-item__name">{{ contact.fullName }}</span>
                <span class="contact-item__sub">
                  {{ contact.org || contact.emails[0]?.value || contact.phones[0]?.value || '' }}
                </span>
              </div>
              <span v-if="contactsStore.isAllBooks" class="contact-item__book">
                {{ contactsStore.bookOf(contact)?.displayName }}
              </span>
            </li>
          </ul>
        </section>

        <!-- Right Column: Contact Details / Edit View -->
        <section class="contact-detail-pane">
          <!-- Editor Mode -->
          <div v-if="editing" class="detail-card edit-card">
            <div class="edit-card__header">
              <div class="edit-card__header-main">
                <h2>{{ isCreating ? $t('contacts.newContact') : $t('contacts.editTitle') }}</h2>
                <div class="edit-card__actions">
                  <button type="button" class="btn btn-ghost" :disabled="saving" @click="cancelEdit">{{ $t('common.cancel') }}</button>
                  <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="saving || nameMissing || !!dateError"
                    @click="saveContact"
                  >
                    {{ saving ? $t('common.saving') : $t('common.save') }}
                  </button>
                </div>
              </div>
              <p v-if="saveError" class="edit-form__error">{{ saveError }}</p>
            </div>

            <form class="edit-form" @submit.prevent="saveContact">
              <div v-if="isCreating && contactsStore.writableBooks.length > 1" class="form-group">
                <label for="new-contact-book">{{ $t('contacts.book') }}</label>
                <select id="new-contact-book" v-model="createBookId" class="select">
                  <option v-for="b in contactsStore.writableBooks" :key="b.id" :value="b.id">{{ b.displayName }}</option>
                </select>
              </div>

              <div class="photo-row">
                <ContactAvatar class="photo-row__avatar" :contact="previewContact" :preview-src="previewSrc" />
                <label class="btn btn-secondary btn-sm">
                  {{ $t('contacts.choosePhoto') }}
                  <input type="file" accept="image/*" hidden @change="onPhoto" />
                </label>
                <button v-if="showRemovePhoto" type="button" class="btn btn-ghost btn-sm" @click="photo = null">
                  {{ $t('common.remove') }}
                </button>
                <span v-if="photoError" class="edit-form__error">{{ photoError }}</span>
              </div>

              <div class="form-row">
                <div class="form-group flex-1">
                  <label>{{ $t('contacts.firstName') }}</label>
                  <input v-model="form.name.given" type="text" class="input" :placeholder="$t('contacts.firstNamePh')" />
                </div>
                <div class="form-group flex-1">
                  <label>{{ $t('contacts.lastName') }}</label>
                  <input v-model="form.name.family" type="text" class="input" :placeholder="$t('contacts.lastNamePh')" />
                </div>
              </div>

              <div class="form-row">
                <div class="form-group flex-1">
                  <label>{{ $t('contacts.prefix') }}</label>
                  <input v-model="form.name.prefix" type="text" class="input" :placeholder="$t('contacts.prefixPh')" />
                </div>
                <div class="form-group flex-1">
                  <label>{{ $t('contacts.middle') }}</label>
                  <input v-model="form.name.additional" type="text" class="input" :placeholder="$t('contacts.middlePh')" />
                </div>
                <div class="form-group flex-1">
                  <label>{{ $t('contacts.suffix') }}</label>
                  <input v-model="form.name.suffix" type="text" class="input" :placeholder="$t('contacts.suffixPh')" />
                </div>
              </div>

              <div class="form-row">
                <div class="form-group flex-1">
                  <label>{{ $t('contact.nickname') }}</label>
                  <input v-model="form.nickname" type="text" class="input" :placeholder="$t('contacts.nicknamePh')" />
                </div>
                <div class="form-group flex-1">
                  <label>{{ $t('contacts.fullName') }}</label>
                  <input v-model="form.fullName" type="text" class="input" :placeholder="$t('contacts.fullNamePh')" />
                </div>
              </div>

              <div class="form-row">
                <div class="form-group flex-1">
                  <label>{{ $t('contact.org') }}</label>
                  <input v-model="form.org" type="text" class="input" :placeholder="$t('contacts.orgPh')" />
                </div>
                <div class="form-group flex-1">
                  <label>{{ $t('contacts.jobTitle') }}</label>
                  <input v-model="form.title" type="text" class="input" :placeholder="$t('contacts.jobTitlePh')" />
                </div>
              </div>

              <!-- Email Rows -->
              <div class="form-section">
                <div class="form-section__header">
                  <label>{{ $t('contacts.emailAddresses') }}</label>
                  <button type="button" class="btn-text" @click="addEmail">{{ $t('contacts.addEmail') }}</button>
                </div>
                <div v-for="(em, idx) in form.emails" :key="idx" class="multi-row">
                  <select
                    :value="primaryType(em.types, EMAIL_TYPES)"
                    class="select select-sm"
                    :aria-label="$t('contacts.emailType')"
                    @change="onType(em, EMAIL_TYPES, $event)"
                  >
                    <option value="">{{ $t('contacts.otherType') }}</option>
                    <option v-for="t in EMAIL_TYPES" :key="t" :value="t">{{ typeName(t) }}</option>
                  </select>
                  <input v-model="em.value" type="email" class="input flex-1" :placeholder="$t('contacts.emailPh')" />
                  <button type="button" class="icon-remove-btn" :aria-label="$t('contacts.removeEmail')" @click="form.emails.splice(idx, 1)">
                    ×
                  </button>
                </div>
              </div>

              <!-- Phone Rows -->
              <div class="form-section">
                <div class="form-section__header">
                  <label>{{ $t('contacts.phoneNumbers') }}</label>
                  <button type="button" class="btn-text" @click="addPhone">{{ $t('contacts.addPhone') }}</button>
                </div>
                <div v-for="(ph, idx) in form.phones" :key="idx" class="multi-row">
                  <select
                    :value="primaryType(ph.types, PHONE_TYPES)"
                    class="select select-sm"
                    :aria-label="$t('contacts.phoneType')"
                    @change="onType(ph, PHONE_TYPES, $event)"
                  >
                    <option value="">{{ $t('contacts.otherType') }}</option>
                    <option v-for="t in PHONE_TYPES" :key="t" :value="t">{{ typeName(t) }}</option>
                  </select>
                  <input v-model="ph.value" type="tel" class="input flex-1" :placeholder="$t('contacts.phonePh')" />
                  <button type="button" class="icon-remove-btn" :aria-label="$t('contacts.removePhone')" @click="form.phones.splice(idx, 1)">
                    ×
                  </button>
                </div>
              </div>

              <!-- Website Rows -->
              <div class="form-section">
                <div class="form-section__header">
                  <label>{{ $t('contacts.websites') }}</label>
                  <button type="button" class="btn-text" @click="addUrl">{{ $t('contacts.addUrl') }}</button>
                </div>
                <div v-for="(u, idx) in form.urls" :key="idx" class="multi-row">
                  <select
                    :value="primaryType(u.types, URL_TYPES)"
                    class="select select-sm"
                    :aria-label="$t('contacts.urlType')"
                    @change="onType(u, URL_TYPES, $event)"
                  >
                    <option value="">{{ $t('contacts.otherType') }}</option>
                    <option v-for="t in URL_TYPES" :key="t" :value="t">{{ typeName(t) }}</option>
                  </select>
                  <input v-model="u.value" type="text" class="input flex-1" placeholder="https://example.com" />
                  <button type="button" class="icon-remove-btn" :aria-label="$t('contacts.removeUrl')" @click="form.urls.splice(idx, 1)">
                    ×
                  </button>
                </div>
              </div>

              <!-- Address Rows -->
              <div class="form-section">
                <div class="form-section__header">
                  <label>{{ $t('contacts.postalAddresses') }}</label>
                  <button type="button" class="btn-text" @click="addAddress">{{ $t('contacts.addAddress') }}</button>
                </div>
                <div v-for="(ad, idx) in form.addresses" :key="idx" class="address-box">
                  <div class="address-box__header">
                    <select
                      :value="primaryType(ad.types, ADDRESS_TYPES)"
                      class="select select-sm"
                      :aria-label="$t('contacts.addressType')"
                      @change="onType(ad, ADDRESS_TYPES, $event)"
                    >
                      <option value="">{{ $t('contacts.otherType') }}</option>
                      <option v-for="t in ADDRESS_TYPES" :key="t" :value="t">{{ typeName(t) }}</option>
                    </select>
                    <button type="button" class="icon-remove-btn" :aria-label="$t('contacts.removeAddress')" @click="form.addresses.splice(idx, 1)">
                      ×
                    </button>
                  </div>
                  <input v-model="ad.street" type="text" class="input" :placeholder="$t('contacts.street')" />
                  <input v-model="ad.extended" type="text" class="input" :placeholder="$t('contacts.extended')" />
                  <div v-if="settings.addressFormat === 'us'" class="form-row">
                    <input v-model="ad.locality" type="text" class="input flex-1" :placeholder="$t('contacts.city')" />
                    <input v-model="ad.region" type="text" class="input flex-1" :placeholder="$t('contacts.state')" />
                    <input v-model="ad.postalCode" type="text" class="input flex-1" :placeholder="$t('contacts.zip')" />
                  </div>
                  <div v-else class="form-row">
                    <input v-model="ad.postalCode" type="text" class="input flex-1" :placeholder="$t('contacts.postalCode')" />
                    <input v-model="ad.locality" type="text" class="input flex-1" :placeholder="$t('contacts.city')" />
                    <input v-model="ad.region" type="text" class="input flex-1" :placeholder="$t('contacts.region')" />
                  </div>
                  <input v-model="ad.country" type="text" class="input" :placeholder="$t('common.country')" />
                </div>
              </div>

              <div class="form-row">
                <div class="form-group flex-1">
                  <label>{{ $t('contact.birthday') }}</label>
                  <input v-model="form.birthday" type="text" class="input" :placeholder="$t('contacts.birthdayPh')" />
                </div>
                <div class="form-group flex-1">
                  <label>{{ $t('contact.anniversary') }}</label>
                  <input v-model="form.anniversary" type="text" class="input" placeholder="2015-06-20" />
                </div>
              </div>
              <p v-if="dateError" class="edit-form__error">{{ dateError }}</p>

              <!-- Groups -->
              <div class="form-section">
                <div class="form-section__header">
                  <label>{{ $t('contact.groups') }}</label>
                </div>
                <div v-if="form.categories.length" class="chips">
                  <span v-for="g in form.categories" :key="g" class="chip">
                    {{ g }}
                    <button
                      type="button"
                      :aria-label="$t('contacts.removeGroup')"
                      @click="form.categories.splice(form.categories.indexOf(g), 1)"
                    >
                      ×
                    </button>
                  </span>
                </div>
                <input
                  v-model="newCategory"
                  type="text"
                  class="input"
                  list="group-suggestions"
                  :placeholder="$t('contacts.addToGroupPh')"
                  @keydown.enter.prevent="addCategory()"
                  @change="addCategory()"
                />
                <datalist id="group-suggestions">
                  <option v-for="g in categorySuggestions" :key="g" :value="g" />
                </datalist>
              </div>

              <div class="form-group">
                <label>{{ $t('contact.notes') }}</label>
                <textarea v-model="form.notes" class="input textarea" rows="3" :placeholder="$t('contacts.notesPh')"></textarea>
              </div>
            </form>
          </div>

          <!-- View Mode: Contact Selected -->
          <div v-else-if="contactsStore.selectedContact" class="detail-card">
            <div class="detail-header">
              <ContactAvatar class="detail-avatar" :contact="contactsStore.selectedContact" />
              <div class="detail-titles">
                <h1 class="detail-name">{{ contactsStore.selectedContact.fullName }}</h1>
                <p v-if="contactsStore.selectedContact.nickname" class="detail-org">
                  “{{ contactsStore.selectedContact.nickname }}”
                </p>
                <p v-if="contactsStore.selectedContact.title || contactsStore.selectedContact.org" class="detail-org">
                  {{ [contactsStore.selectedContact.title, contactsStore.selectedContact.org].filter(Boolean).join(' • ') }}
                </p>
                <p v-if="contactsStore.selectedContact.categories.length" class="chips chips--detail">
                  <span v-for="g in contactsStore.selectedContact.categories" :key="g" class="chip">{{ g }}</span>
                </p>
              </div>
              <div class="detail-actions">
                <template v-if="!selectedReadOnly">
                  <button type="button" class="btn btn-secondary" @click="startEdit">{{ $t('common.edit') }}</button>
                  <button type="button" class="btn btn-danger" @click="confirmingDelete = contactsStore.selectedContact">
                    {{ $t('common.delete') }}
                  </button>
                </template>
                <BookMenu
                  v-if="detailMoveTargets.length || detailCopyTargets.length"
                  :label="$t('contacts.moveCopy')"
                  :move-targets="detailMoveTargets"
                  :copy-targets="detailCopyTargets"
                  @pick="onTransfer"
                />
              </div>
            </div>

            <div class="detail-body">
              <!-- Phones -->
              <div v-if="contactsStore.selectedContact.phones.length > 0" class="detail-group">
                <span class="detail-label">{{ $t('contacts.phone') }}</span>
                <div v-for="(ph, i) in contactsStore.selectedContact.phones" :key="i" class="detail-entry">
                  <a :href="`tel:${ph.value.replace(/[^\d+*#]/g, '')}`" class="detail-link">{{ ph.value }}</a>
                  <span v-if="typeLabel(ph.types)" class="badge">{{ typeLabel(ph.types) }}</span>
                </div>
              </div>

              <!-- Emails -->
              <div v-if="contactsStore.selectedContact.emails.length > 0" class="detail-group">
                <span class="detail-label">{{ $t('contacts.email') }}</span>
                <div v-for="(em, i) in contactsStore.selectedContact.emails" :key="i" class="detail-entry">
                  <a :href="`mailto:${em.value}`" class="detail-link">{{ em.value }}</a>
                  <span v-if="typeLabel(em.types)" class="badge">{{ typeLabel(em.types) }}</span>
                </div>
              </div>

              <!-- Websites -->
              <div v-if="contactsStore.selectedContact.urls.length > 0" class="detail-group">
                <span class="detail-label">{{ $t('contacts.website') }}</span>
                <div v-for="(u, i) in contactsStore.selectedContact.urls" :key="i" class="detail-entry">
                  <a
                    v-if="safeHref(u.value)"
                    :href="safeHref(u.value)!"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="detail-link"
                  >
                    {{ u.value }}
                  </a>
                  <template v-else>{{ u.value }}</template>
                  <span v-if="typeLabel(u.types)" class="badge">{{ typeLabel(u.types) }}</span>
                </div>
              </div>

              <!-- Addresses -->
              <div v-if="contactsStore.selectedContact.addresses.length > 0" class="detail-group">
                <span class="detail-label">{{ $t('contacts.address') }}</span>
                <div v-for="(ad, i) in contactsStore.selectedContact.addresses" :key="i" class="detail-address">
                  <span v-if="typeLabel(ad.types)" class="badge mb-1">{{ typeLabel(ad.types) }}</span>
                  <a :href="mapUrl(ad)" target="_blank" rel="noopener noreferrer" class="detail-link">
                    <p v-for="(line, j) in addressLinesFor(ad)" :key="j">{{ line }}</p>
                  </a>
                </div>
              </div>

              <!-- Birthday / Anniversary -->
              <div v-if="contactsStore.selectedContact.birthday" class="detail-group">
                <span class="detail-label">{{ $t('contact.birthday') }}</span>
                <div class="detail-entry">{{ formatDate(contactsStore.selectedContact.birthday) }}</div>
              </div>
              <div v-if="contactsStore.selectedContact.anniversary" class="detail-group">
                <span class="detail-label">{{ $t('contact.anniversary') }}</span>
                <div class="detail-entry">{{ formatDate(contactsStore.selectedContact.anniversary) }}</div>
              </div>

              <!-- Notes -->
              <div v-if="contactsStore.selectedContact.notes" class="detail-group">
                <span class="detail-label">{{ $t('contact.notes') }}</span>
                <div class="detail-notes">{{ contactsStore.selectedContact.notes }}</div>
              </div>

              <p class="detail-foot">
                {{ contactsStore.bookOf(contactsStore.selectedContact)?.displayName }}<template v-if="selectedReadOnly">
                  · {{ $t('contacts.readOnly') }}</template
                >
                · vCard
                {{ contactsStore.selectedContact.version }}
              </p>
            </div>
          </div>

          <!-- View Mode: Empty Selection -->
          <div v-else class="detail-card empty-card">
            <div class="empty-state">
              <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <h3>{{ $t('contacts.noneSelected') }}</h3>
              <p>{{ $t('contacts.noneSelectedHint') }}</p>
              <button v-if="canCreate" class="btn btn-primary mt-3" @click="startCreate">+ {{ $t('contacts.newContact') }}</button>
            </div>
          </div>
        </section>
      </div>
    </main>

    <!-- Dialogs -->
    <SettingsDialog v-if="showSettingsDialog" @close="showSettingsDialog = false" />

    <ConflictDialog
      v-if="pendingConflict"
      :kind="pendingConflict.kind"
      noun="contact"
      :server-version="conflictServerVersion"
      :attempted-summary="pendingConflict.kind === 'update' ? attemptedName(pendingConflict.input) : ''"
      @discard="onConflictDiscard"
      @reapply="onConflictReapply"
    />

    <ConfirmDialog
      v-if="confirmingDelete"
      :title="$t('contacts.confirmDeleteTitle')"
      :message="$t('contacts.confirmDelete', { name: confirmingDelete.fullName })"
      :confirm-label="$t('common.delete')"
      @confirm="onDeleteContact"
      @cancel="confirmingDelete = null"
    />

    <MergeDialog
      v-if="mergePair"
      :a="mergePair[0]"
      :b="mergePair[1]"
      :saving="merging"
      :error="mergeError"
      @cancel="mergePair = null"
      @merge="onMerge"
    />

    <ConfirmDialog
      v-if="confirmingBatchDelete"
      :title="$t('contacts.confirmDeleteManyTitle')"
      :message="$t('contacts.confirmDeleteMany', { count: contactCount(contactsStore.checkedIds.length) })"
      :confirm-label="$t('common.delete')"
      @confirm="onBatchDelete"
      @cancel="confirmingBatchDelete = false"
    />

    <ConfirmDialog
      v-if="confirmingDeleteBook"
      :title="$t('contacts.confirmDeleteBookTitle')"
      :message="$t('contacts.confirmDeleteBook')"
      :confirm-label="$t('common.delete')"
      @confirm="onDeleteBook"
      @cancel="confirmingDeleteBook = null"
    />
  </div>
</template>

<style scoped>
/* Top-level layout: Exactly matching CalendarView.vue */
.layout {
  display: flex;
  height: 100vh;
  background: var(--color-bg);
}

.sidebar {
  width: 256px;
  flex-shrink: 0;
  padding: 1.25rem 1rem;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  overflow-y: auto;
}

.sidebar__actions {
  display: flex;
  gap: 0.5rem;
}

.sidebar__new {
  flex: 1;
  font-size: 0.88rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
}

.sidebar__new span {
  font-size: 1.05rem;
  line-height: 1;
}

/* Address Books Section (Mirrors CalendarList.vue) */
.address-books {
  display: flex;
  flex-direction: column;
}

.address-books__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}

.address-books__heading {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-faint);
  margin: 0;
}

.address-books__new-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem;
  margin-bottom: 0.4rem;
  background: var(--color-surface-hover);
  border-radius: var(--radius-sm);
}

.address-books__new-input {
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  background: var(--color-surface);
  color: inherit;
  box-sizing: border-box;
}

.address-books__new-row {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
}

.btn-sm {
  padding: 0.25rem 0.6rem;
  font-size: 0.78rem;
}

.address-books__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.address-books__item {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.35rem 0.5rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.12s ease;
  font-size: 0.88rem;
  color: var(--color-text);
}

.address-books__item:hover {
  background: var(--color-surface-hover);
}

.address-books__item--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 600;
}

.address-books__icon {
  font-size: 0.95rem;
  flex-shrink: 0;
}

.address-books__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.address-books__delete {
  opacity: 0;
  transition: opacity 0.12s ease;
}

.address-books__item:hover .address-books__delete {
  opacity: 1;
}

/* User footer: Exactly matching CalendarView.vue */
.sidebar__user {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.6rem 0.25rem 0;
  border-top: 1px solid var(--color-border);
  font-size: 0.85rem;
}

.sidebar__username-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  justify-content: flex-start;
  padding: 0.3rem 0.35rem;
}

.sidebar__avatar {
  width: 1.6rem;
  height: 1.6rem;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 600;
  font-size: 0.75rem;
}

.sidebar__username {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  color: var(--color-text-muted);
}

.sidebar__user-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.sidebar__settings-btn {
  padding: 0.3rem 0.5rem;
  font-size: 0.78rem;
  flex-shrink: 0;
}

.sidebar__signout {
  padding: 0.3rem 0.5rem;
  font-size: 0.8rem;
  flex-shrink: 0;
  margin-left: auto;
}

/* Main & Card: Exactly matching CalendarView.vue framing */
.main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
}

.contacts-card {
  flex: 1;
  min-height: 0;
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--color-border);
  display: flex;
  overflow: hidden;
}

/* Contacts List Pane (Left of Card) */
.contacts-list-pane {
  width: 290px;
  min-width: 290px;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface);
}

.contacts-list-header {
  padding: 0.75rem 0.85rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.search-box-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 0.6rem;
  width: 14px;
  height: 14px;
  color: var(--color-text-faint);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 0.35rem 0.5rem 0.35rem 1.9rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-hover);
  color: var(--color-text);
  font-size: 0.85rem;
  outline: none;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.search-input:focus {
  border-color: var(--color-primary);
  background: var(--color-surface);
}

.contacts-count {
  font-size: 0.75rem;
  color: var(--color-text-faint);
  padding-left: 0.2rem;
}

.contact-items {
  list-style: none;
  padding: 0;
  margin: 0;
  flex: 1;
  overflow-y: auto;
}

.contact-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.contact-item:hover {
  background: var(--color-surface-hover);
}

.contact-item--active {
  background: var(--color-primary-soft) !important;
}

.contact-item__avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  flex-shrink: 0;
}

.contact-item--active .contact-item__avatar {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}

.contact-item__info {
  flex: 1;
  min-width: 0;
}

.contact-item__name {
  display: block;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contact-item__sub {
  display: block;
  font-size: 0.78rem;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pane-state {
  padding: 2.5rem 1rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.85rem;
}

/* Contact Details Pane (Right of Card) */
.contact-detail-pane {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 1.5rem 2rem;
  background: var(--color-surface);
}

.detail-card {
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--color-border);
}

.detail-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 1.3rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.detail-titles {
  flex: 1;
  min-width: 0;
}

.detail-name {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--color-text);
}

.detail-org {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
  color: var(--color-text-muted);
}

.detail-actions {
  display: flex;
  gap: 0.5rem;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.detail-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.detail-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-faint);
}

.detail-entry {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.92rem;
  color: var(--color-text);
}

.detail-link {
  color: var(--color-primary);
  text-decoration: none;
}

.detail-link:hover {
  text-decoration: underline;
}

.detail-address {
  font-size: 0.9rem;
  line-height: 1.45;
}

.detail-address p {
  margin: 0;
}

.detail-notes {
  white-space: pre-wrap;
  font-size: 0.88rem;
  line-height: 1.5;
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  padding: 0.75rem 1rem;
  border-radius: var(--radius-sm);
  color: var(--color-text);
}

.badge {
  font-size: 0.68rem;
  text-transform: uppercase;
  font-weight: 600;
  padding: 0.15rem 0.45rem;
  border-radius: var(--radius-sm);
  background: var(--color-surface-hover);
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
}

.mb-1 {
  margin-bottom: 0.35rem;
  display: inline-block;
}

/* Edit Form */
.edit-card__header {
  position: sticky;
  top: -1.5rem;
  z-index: 10;
  background: var(--color-surface);
  margin-top: -1.5rem;
  padding-top: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.edit-card__header-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.edit-card__header h2 {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--color-text);
}

.edit-card__actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.edit-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-row {
  display: flex;
  gap: 0.75rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.form-group label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text-muted);
}

.flex-1 {
  flex: 1;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.85rem;
  background: var(--color-surface-hover);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
}

.form-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-section__header label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text);
}

.multi-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.address-box {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.address-box__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.btn-text {
  background: none;
  border: none;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-primary);
  cursor: pointer;
  padding: 0;
}

.btn-text:hover {
  text-decoration: underline;
}

/* base.css gives inputs a border and colours but no padding or sizing, so the
   editor's .input/.select/.textarea need their own (.select-sm below tightens
   the type selects). */
.input,
.select {
  padding: 0.5rem 0.65rem;
  box-sizing: border-box;
  min-width: 0;
}

.input {
  width: 100%;
}

.textarea {
  resize: vertical;
  line-height: 1.4;
}

.select-sm {
  padding: 0.35rem 0.5rem;
  font-size: 0.8rem;
}

.empty-card {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-state {
  text-align: center;
  padding: 2.5rem 1rem;
  color: var(--color-text-muted);
}

.empty-icon {
  width: 44px;
  height: 44px;
  margin-bottom: 0.75rem;
  color: var(--color-text-faint);
}

.empty-state h3 {
  margin: 0 0 0.35rem;
  color: var(--color-text);
  font-size: 1.05rem;
}

.empty-state p {
  margin: 0;
  font-size: 0.88rem;
}

.mt-3 {
  margin-top: 1rem;
}

/* Added alongside the data-model port: groups, import/export, photo, chips */
.sidebar__io {
  display: flex;
  gap: 0.4rem;
}

.sidebar__io .btn {
  flex: 1;
  text-align: center;
  text-decoration: none;
}

.sidebar__note,
.sidebar__error {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-text-muted);
}

.sidebar__error,
.edit-form__error,
.pane-state--error {
  color: var(--color-danger, #c0392b);
}

.address-books__count {
  font-size: 0.75rem;
  color: var(--color-text-faint);
  /* It is faded out (opacity: 0) while the rename button takes its place, and
     a transparent element still catches clicks -- and paints above a plain
     sibling -- so without this it would sit on top of the button. */
  pointer-events: none;
}

/* Count and rename button stacked in one grid cell, right-aligned, so every
   row's number lines up at the right edge and nothing shifts on hover. */
.address-books__trail {
  display: inline-grid;
  align-items: center;
  justify-items: end;
  flex-shrink: 0;
}

.address-books__trail > * {
  grid-area: 1 / 1;
}

.address-books__edit {
  padding: 0 0.1rem;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 0.85rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.address-books__edit:hover {
  color: var(--color-primary);
}

.address-books__item:hover .address-books__trail .address-books__count,
.address-books__item:focus-within .address-books__trail .address-books__count {
  opacity: 0;
}

.address-books__item:hover .address-books__edit,
.address-books__item:focus-within .address-books__edit {
  opacity: 1;
  pointer-events: auto;
}

/* No hover on touch screens: show the button next to the count instead. */
@media (hover: none) {
  .address-books__trail {
    display: inline-flex;
    gap: 0.4rem;
  }

  .address-books__item:hover .address-books__trail .address-books__count {
    opacity: 1;
  }

  .address-books__edit {
    opacity: 1;
    pointer-events: auto;
  }
}

.address-books__rename {
  flex: 1;
}

.address-books__item--saving {
  pointer-events: none;
}

.address-books__spinner {
  width: 0.75rem;
  height: 0.75rem;
  border: 1.5px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: address-books-spin 0.6s linear infinite;
  display: inline-block;
  pointer-events: none;
}

@keyframes address-books-spin {
  to {
    transform: rotate(360deg);
  }
}

.photo-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.photo-row__avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 1.2rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.edit-form__error {
  margin: 0;
  font-size: 0.82rem;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-bottom: 0.4rem;
}

.chips--detail {
  margin: 0.4rem 0 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 0.78rem;
}

.chip button {
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.detail-foot {
  margin: 1rem 0 0;
  font-size: 0.78rem;
  color: var(--color-text-faint);
}

.sidebar__url {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.sidebar__url label {
  font-size: 0.74rem;
  color: var(--color-text-muted);
}

.sidebar__url-row {
  display: flex;
  gap: 0.4rem;
}

.sidebar__url-row input {
  flex: 1;
  min-width: 0;
}

.contact-item__book {
  margin-left: auto;
  max-width: 6rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.7rem;
  color: var(--color-text-faint);
  flex-shrink: 0;
}

/* Selection and batch actions */
.contacts-list-header__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.contact-item__lead {
  position: relative;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
}

/* The checkbox sits over the avatar. While it is hidden it must not take
   clicks (an invisible element still does), so pointer-events follows opacity. */
.contact-item__check {
  position: absolute;
  inset: 0;
  width: 18px;
  height: 18px;
  margin: auto;
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
}

.contact-item:hover .contact-item__check,
.contact-item__lead--selecting .contact-item__check,
.contact-item__check:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.contact-item:hover .contact-item__avatar,
.contact-item__lead--selecting .contact-item__avatar {
  opacity: 0;
}

.contact-item--checked {
  background: var(--color-primary-soft);
}

.batch-bar {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-hover);
  font-size: 0.82rem;
}

.batch-bar__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.batch-bar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.list-status {
  margin: 0;
  padding: 0.45rem 0.85rem;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.list-status--error {
  color: var(--color-danger, #c0392b);
}
</style>
