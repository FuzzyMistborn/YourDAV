<script setup lang="ts">
import type { Contact, ContactInput, LabeledValue, PostalAddress } from '@yourdav/shared'
import { computed, reactive, ref } from 'vue'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { addressLines, autoName, formatDate, imageToDataUri, typeLabel } from '../lib/labels.js'
import { useContactsStore } from '../stores/contacts.js'
import { useSettingsStore } from '../stores/settings.js'
import ContactAvatar from './ContactAvatar.vue'

// Merges two contacts: the one you keep is saved with the combined details and
// the other card is deleted. Single-valued fields (name, organization, ...) are
// picked with radio buttons; multi-valued ones (phones, emails, ...) are unions
// you can untick. Anything on the kept card that this dialog does not show
// (custom fields, IM handles) survives; the same on the other card does not.
const props = defineProps<{ a: Contact; b: Contact; saving: boolean; error: string | null }>()
const emit = defineEmits<{ cancel: []; merge: [survivor: Contact, other: Contact, input: ContactInput] }>()

type Side = 'a' | 'b'
type ListKey = 'phones' | 'emails' | 'urls' | 'addresses'

const contactsStore = useContactsStore()
const settings = useSettingsStore()

const side = (s: Side): Contact => (s === 'a' ? props.a : props.b)
const bookName = (c: Contact): string => contactsStore.bookOf(c)?.displayName ?? ''

const keep = ref<Side>('a')
const survivor = computed(() => side(keep.value))
const other = computed(() => side(keep.value === 'a' ? 'b' : 'a'))

// --- single-valued fields ----------------------------------------------

interface Field {
  key: 'name' | 'nickname' | 'org' | 'title' | 'birthday' | 'anniversary' | 'notes'
  labelKey: string
  /** What is compared and shown for a card. */
  text: (c: Contact) => string
  /** What counts as "the same" on both cards. */
  raw: (c: Contact) => string
}

const FIELDS: Field[] = [
  { key: 'name', labelKey: 'common.name', text: (c) => c.fullName, raw: (c) => JSON.stringify([c.name, c.fullName]) },
  { key: 'nickname', labelKey: 'contact.nickname', text: (c) => c.nickname, raw: (c) => c.nickname },
  { key: 'org', labelKey: 'contact.org', text: (c) => c.org, raw: (c) => c.org },
  { key: 'title', labelKey: 'contact.jobTitle', text: (c) => c.title, raw: (c) => c.title },
  { key: 'birthday', labelKey: 'contact.birthday', text: (c) => (c.birthday ? formatDate(c.birthday) : ''), raw: (c) => c.birthday },
  {
    key: 'anniversary',
    labelKey: 'contact.anniversary',
    text: (c) => (c.anniversary ? formatDate(c.anniversary) : ''),
    raw: (c) => c.anniversary,
  },
  { key: 'notes', labelKey: 'contact.notes', text: (c) => c.notes, raw: (c) => c.notes },
]

// Default to the first card's value, falling back to the second's when it has none.
const chosen = reactive<Record<Field['key'], Side>>(
  Object.fromEntries(FIELDS.map((f) => [f.key, f.raw(props.a) ? 'a' : f.raw(props.b) ? 'b' : 'a'])) as Record<Field['key'], Side>,
)

/** Fields where the cards differ (so there is a choice to make) and those where they agree. */
const fieldRows = computed(() =>
  FIELDS.map((f) => {
    const ra = f.raw(props.a)
    const rb = f.raw(props.b)
    return { f, ra, rb, empty: !ra && !rb, same: ra === rb }
  }).filter((r) => !r.empty),
)

// --- multi-valued fields -------------------------------------------------

interface Entry {
  id: string
  text: string
  badge: string
  item: LabeledValue | PostalAddress
  from: Side[]
}

function normalised(list: ListKey, item: LabeledValue | PostalAddress): string {
  if (list === 'addresses') return addressLines(item as PostalAddress, 'us').join('|').toLowerCase()
  const v = (item as LabeledValue).value.trim().toLowerCase()
  if (list === 'phones') return v.replace(/[^\d+]/g, '')
  if (list === 'urls') return v.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return v
}

function describe(list: ListKey, item: LabeledValue | PostalAddress): string {
  return list === 'addresses'
    ? addressLines(item as PostalAddress, settings.addressFormat).join(', ')
    : (item as LabeledValue).value
}

/** Union of both cards' entries for a list, the kept card's first, duplicates folded into one row. */
function entries(list: ListKey): Entry[] {
  const out = new Map<string, Entry>()
  for (const s of [keep.value, keep.value === 'a' ? 'b' : 'a'] as Side[]) {
    for (const item of side(s)[list] as (LabeledValue | PostalAddress)[]) {
      const key = normalised(list, item)
      if (!key) continue
      const existing = out.get(key)
      if (existing) existing.from.push(s)
      else out.set(key, { id: `${list}:${key}`, text: describe(list, item), badge: typeLabel(item.types), item, from: [s] })
    }
  }
  return [...out.values()]
}

const LISTS: { key: ListKey; labelKey: string }[] = [
  { key: 'phones', labelKey: 'contact.phones' },
  { key: 'emails', labelKey: 'contact.emails' },
  { key: 'urls', labelKey: 'contact.urls' },
  { key: 'addresses', labelKey: 'contact.addresses' },
]

const listRows = computed(() => LISTS.map((l) => ({ ...l, entries: entries(l.key) })).filter((l) => l.entries.length > 0))

const groups = computed(() => [...new Set([...survivor.value.categories, ...other.value.categories])])

// Everything starts ticked; the user unticks what they don't want. Keyed so the
// state survives switching which card is kept (which only reorders the rows).
const unticked = reactive(new Set<string>())
function isTicked(id: string): boolean {
  return !unticked.has(id)
}
function tick(id: string, on: boolean): void {
  if (on) unticked.delete(id)
  else unticked.add(id)
}

function origin(from: Side[]): string {
  if (from.length === 2) return t('merge.bothCards')
  return bookName(side(from[0])) || t(from[0] === keep.value ? 'merge.keptCard' : 'merge.otherCard')
}

// --- photo -----------------------------------------------------------------

const photoChoice = ref<Side | 'none'>(props.a.hasPhoto ? 'a' : props.b.hasPhoto ? 'b' : 'none')
const anyPhoto = computed(() => props.a.hasPhoto || props.b.hasPhoto)

/** undefined = leave the kept card's photo alone, null = remove it, string = a new photo (data URI). */
async function photoValue(): Promise<string | null | undefined> {
  if (photoChoice.value === 'none') return survivor.value.hasPhoto ? null : undefined
  const src = side(photoChoice.value)
  if (src.id === survivor.value.id) return undefined
  const res = await fetch(api.photoUrl(src.addressBookId, src.href, src.etag), { credentials: 'include' })
  if (!res.ok) throw new Error(t('merge.photoFailed'))
  const blob = await res.blob()
  return imageToDataUri(new File([blob], 'photo', { type: blob.type || 'image/jpeg' }))
}

// --- submit ---------------------------------------------------------------

const localError = ref<string | null>(null)
const preparing = ref(false)

function build(): ContactInput {
  const nameSrc = side(chosen.name)
  const pick = (k: Field['key']): Contact => side(chosen[k])
  const chosenItems = <T extends LabeledValue | PostalAddress>(list: ListKey): T[] =>
    entries(list)
      .filter((e) => isTicked(e.id))
      .map((e) => JSON.parse(JSON.stringify(e.item)) as T)
  return {
    name: { ...nameSrc.name },
    // Keep a custom display name only if the chosen card had one.
    fullName: nameSrc.fullName !== autoName(nameSrc.name, nameSrc.org) ? nameSrc.fullName : undefined,
    nickname: pick('nickname').nickname,
    org: pick('org').org,
    title: pick('title').title,
    birthday: pick('birthday').birthday,
    anniversary: pick('anniversary').anniversary,
    notes: pick('notes').notes,
    emails: chosenItems<LabeledValue>('emails'),
    phones: chosenItems<LabeledValue>('phones'),
    urls: chosenItems<LabeledValue>('urls'),
    addresses: chosenItems<PostalAddress>('addresses'),
    categories: groups.value.filter((g) => isTicked(`group:${g}`)),
  }
}

async function submit(): Promise<void> {
  if (props.saving || preparing.value) return
  localError.value = null
  preparing.value = true
  try {
    const input = build()
    const photo = await photoValue()
    if (photo !== undefined) input.photo = photo
    emit('merge', survivor.value, other.value, input)
  } catch (err) {
    localError.value = err instanceof Error ? err.message : t('merge.prepareFailed')
  } finally {
    preparing.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="merge-title">
      <h2 id="merge-title">{{ $t('merge.title') }}</h2>
      <p class="dialog__intro">
        {{ $t('merge.intro') }}
      </p>

      <div class="merge-grid merge-grid--head">
        <span />
        <label v-for="s in ['a', 'b'] as const" :key="s" class="merge-card" :class="{ 'merge-card--kept': keep === s }">
          <input v-model="keep" type="radio" name="keep" :value="s" />
          <ContactAvatar class="merge-card__avatar" :contact="side(s)" />
          <span class="merge-card__text">
            <strong>{{ side(s).fullName }}</strong>
            <small>{{ bookName(side(s)) }}</small>
            <small class="merge-card__keep">{{ keep === s ? $t('merge.keeping') : $t('merge.willDelete') }}</small>
          </span>
        </label>
      </div>

      <div v-for="row in fieldRows" :key="row.f.key" class="merge-grid merge-row">
        <span class="merge-row__label">{{ $t(row.f.labelKey) }}</span>
        <template v-if="row.same">
          <span class="merge-row__same">{{ row.f.text(a) }} <em>{{ $t('merge.same') }}</em></span>
        </template>
        <template v-else>
          <label v-for="s in ['a', 'b'] as const" :key="s" class="merge-row__option" :class="{ 'merge-row__option--off': !row.f.raw(side(s)) }">
            <input v-model="chosen[row.f.key]" type="radio" :name="`f-${row.f.key}`" :value="s" :disabled="!row.f.raw(side(s))" />
            <span class="merge-row__value">{{ row.f.text(side(s)) || '—' }}</span>
          </label>
        </template>
      </div>

      <div v-if="anyPhoto" class="merge-grid merge-row">
        <span class="merge-row__label">{{ $t('contact.photo') }}</span>
        <label v-for="s in ['a', 'b'] as const" :key="s" class="merge-row__option" :class="{ 'merge-row__option--off': !side(s).hasPhoto }">
          <input v-model="photoChoice" type="radio" name="photo" :value="s" :disabled="!side(s).hasPhoto" />
          <ContactAvatar v-if="side(s).hasPhoto" class="merge-row__thumb" :contact="side(s)" />
          <span v-else class="merge-row__value">—</span>
        </label>
        <span />
        <label class="merge-row__option merge-row__option--span">
          <input v-model="photoChoice" type="radio" name="photo" value="none" />
          <span class="merge-row__value">{{ $t('merge.noPhoto') }}</span>
        </label>
      </div>

      <section v-for="l in listRows" :key="l.key" class="merge-list">
        <h3>{{ $t(l.labelKey) }}</h3>
        <label v-for="e in l.entries" :key="e.id" class="merge-list__item">
          <input type="checkbox" :checked="isTicked(e.id)" @change="tick(e.id, ($event.target as HTMLInputElement).checked)" />
          <span class="merge-list__text">{{ e.text }}</span>
          <span v-if="e.badge" class="badge">{{ e.badge }}</span>
          <span class="merge-list__from">{{ origin(e.from) }}</span>
        </label>
      </section>

      <section v-if="groups.length" class="merge-list">
        <h3>{{ $t('contact.groups') }}</h3>
        <label v-for="g in groups" :key="g" class="merge-list__item">
          <input type="checkbox" :checked="isTicked(`group:${g}`)" @change="tick(`group:${g}`, ($event.target as HTMLInputElement).checked)" />
          <span class="merge-list__text">{{ g }}</span>
        </label>
      </section>

      <p class="dialog__note">
        {{ $t('merge.note') }}
      </p>
      <p v-if="error || localError" class="dialog__error">{{ error || localError }}</p>

      <div class="dialog__actions">
        <button type="button" class="btn btn-ghost" :disabled="saving || preparing" @click="emit('cancel')">{{ $t('common.cancel') }}</button>
        <button type="button" class="btn btn-primary" :disabled="saving || preparing" @click="submit">
          {{ saving || preparing ? $t('merge.merging') : $t('merge.submit') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(16, 20, 26, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  animation: fade-in 0.12s ease;
}
.dialog {
  background: var(--color-surface);
  padding: 1.5rem;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: min(720px, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  animation: pop-in 0.14s ease;
}
.dialog h2 {
  font-size: 1.05rem;
  margin: 0;
}
.dialog__intro,
.dialog__note {
  margin: 0.4rem 0 1rem;
  color: var(--color-text-muted);
  font-size: 0.83rem;
}
.dialog__note {
  margin-top: 1rem;
  font-size: 0.78rem;
}
.dialog__error {
  margin: 0 0 0.75rem;
  color: var(--color-danger, #c0392b);
  font-size: 0.83rem;
}
.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.merge-grid {
  display: grid;
  grid-template-columns: 7rem 1fr 1fr;
  gap: 0.5rem 0.75rem;
  align-items: center;
}
.merge-grid--head {
  margin-bottom: 0.5rem;
}
.merge-card {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}
.merge-card--kept {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.merge-card__avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  font-weight: 600;
  flex-shrink: 0;
}
.merge-card__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.merge-card__text small {
  color: var(--color-text-muted);
  font-size: 0.72rem;
}
.merge-card__keep {
  font-weight: 600;
}

.merge-row {
  padding: 0.4rem 0;
  border-top: 1px solid var(--color-border);
}
.merge-row__label {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.merge-row__option {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.85rem;
  cursor: pointer;
  min-width: 0;
}
.merge-row__option:has(.merge-row__thumb) {
  align-items: center;
}
.merge-row__option--off {
  color: var(--color-text-faint);
  cursor: default;
}
.merge-row__option--span {
  grid-column: 2 / 4;
}
.merge-row__value {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.merge-row__same {
  grid-column: 2 / 4;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.merge-row__same em {
  color: var(--color-text-faint);
  font-size: 0.75rem;
}
.merge-row__thumb {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.merge-list {
  margin-top: 0.9rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--color-border);
}
.merge-list h3 {
  margin: 0 0 0.35rem;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.merge-list__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0;
  font-size: 0.85rem;
  cursor: pointer;
}
.merge-list__text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.merge-list__from {
  font-size: 0.72rem;
  color: var(--color-text-faint);
  flex-shrink: 0;
}

.badge {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
}
@keyframes pop-in {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(4px);
  }
}
</style>
