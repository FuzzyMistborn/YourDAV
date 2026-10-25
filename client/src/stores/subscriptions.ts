import type { CalendarObject } from '@yourdav/shared'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'
import { loadEnabledState, saveEnabledState } from '../lib/enabledState.js'

export interface Subscription {
  id: string
  name: string
  url: string
  color: string
}

const STORAGE_KEY = 'calendar.subscriptions'
const ENABLED_KEY = 'calendar.subscriptionsEnabled'
const DEFAULT_COLOR = '#8e5fd4'

// crypto.randomUUID() only exists in secure contexts (HTTPS, or the
// literal hostname "localhost") -- accessing the app over plain HTTP via a
// LAN IP leaves crypto.randomUUID undefined, which threw here uncaught.
// This id is only ever used as a local-storage key, not sent to any
// server, so a non-cryptographic fallback is fine.
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function loadSubscriptions(): Subscription[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Subscription[]) : []
  } catch {
    return []
  }
}

/** Replays edits made locally since `before` (add/remove/change by id) onto the server's list. */
function mergeEdits(
  stored: Subscription[],
  before: Subscription[],
  current: Subscription[],
): { list: Subscription[]; edited: boolean } {
  const beforeById = new Map(before.map((s) => [s.id, s]))
  const currentById = new Map(current.map((s) => [s.id, s]))
  let edited = false
  const list: Subscription[] = []
  for (const sub of stored) {
    const prev = beforeById.get(sub.id)
    const now = currentById.get(sub.id)
    if (prev && !now) {
      edited = true // removed locally
      continue
    }
    if (prev && now && (prev.name !== now.name || prev.url !== now.url || prev.color !== now.color)) {
      edited = true
      list.push({ ...now })
    } else {
      list.push(sub)
    }
  }
  const storedIds = new Set(stored.map((s) => s.id))
  for (const sub of current) {
    if (!beforeById.has(sub.id) && !storedIds.has(sub.id)) {
      edited = true // added locally
      list.push(sub)
    }
  }
  return { list, edited }
}

function rangeKey(id: string, start: string, end: string): string {
  return `${id}:${start}:${end}`
}

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const subscriptions = ref<Subscription[]>(loadSubscriptions())
  const savedEnabled = loadEnabledState(ENABLED_KEY)
  const enabled = reactive<Record<string, boolean>>(
    Object.fromEntries(subscriptions.value.map((s) => [s.id, savedEnabled[s.id] ?? true])),
  )
  const byRange = ref<Record<string, CalendarObject[]>>({})
  const errors = reactive<Record<string, string>>({})

  // The list lives on the DAV server (see server/src/dav/userSettings.ts) so
  // it follows the account across browsers and logouts; localStorage stays as
  // a mirror and as the whole store on servers that can't hold the property.
  const serverBacked = ref(true)
  // Set when the last save to the server failed for a reason other than
  // "unsupported", so the edit is only held in this browser for now.
  const syncError = ref<string | null>(null)
  let initialized = false
  let initDone: Promise<void> = Promise.resolve()
  let pendingPush: Promise<void> = Promise.resolve()

  function writeLocal(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(subscriptions.value))
    } catch {
      // Storage unavailable -- the server copy (if any) still holds the list.
    }
  }

  // Pushes are chained so a slow earlier write can't land after a later one.
  function pushToServer(): void {
    if (!serverBacked.value) return
    pendingPush = pendingPush.then(async () => {
      // Wait for init() so an edit made while the stored list is still
      // loading can't overwrite it, and snapshot at send time.
      await initDone
      if (!serverBacked.value) return
      const snapshot = subscriptions.value.map(({ id, name, url, color }) => ({ id, name, url, color }))
      try {
        await api.putStoredSubscriptions(snapshot)
        syncError.value = null
      } catch (err) {
        // 501 = this DAV server can't store it: stay browser-local from now on.
        if (err instanceof ApiRequestError && err.status === 501) {
          serverBacked.value = false
          syncError.value = null
        } else {
          syncError.value =
            err instanceof ApiRequestError ? err.message : 'Could not save subscriptions to the server'
        }
      }
    })
  }

  function persist(): void {
    writeLocal()
    pushToServer()
  }

  /** Loads the account's list from the DAV server; migrates the browser-local list if the server has none yet. */
  async function init(): Promise<void> {
    if (initialized) return initDone
    initialized = true
    initDone = load()
    return initDone
  }

  async function load(): Promise<void> {
    const before = subscriptions.value.map((s) => ({ ...s }))
    try {
      const { subscriptions: stored, invalid } = await api.getStoredSubscriptions()
      if (stored === null) {
        // Nothing saved yet: seed the server from this browser's list. An
        // unreadable stored list is left alone rather than overwritten.
        if (!invalid && subscriptions.value.length > 0) pushToServer()
        return
      }
      const merged = mergeEdits(stored, before, subscriptions.value)
      subscriptions.value = merged.list
      for (const sub of merged.list) if (!(sub.id in enabled)) enabled[sub.id] = savedEnabled[sub.id] ?? true
      writeLocal()
      // Edits made while the fetch was in flight still need to reach the server.
      if (merged.edited) pushToServer()
    } catch {
      // Server unreachable: keep working from the browser-local list.
    }
  }

  /** Drops all in-memory state so the next account starts clean. */
  function clear(): void {
    subscriptions.value = []
    for (const key of Object.keys(enabled)) delete enabled[key]
    for (const key of Object.keys(savedEnabled)) delete savedEnabled[key]
    for (const key of Object.keys(errors)) delete errors[key]
    byRange.value = {}
    serverBacked.value = true
    syncError.value = null
    initialized = false
    initDone = Promise.resolve()
    pendingPush = Promise.resolve()
  }

  function add(name: string, url: string, color = DEFAULT_COLOR): void {
    const sub: Subscription = { id: generateId(), name, url, color }
    subscriptions.value.push(sub)
    enabled[sub.id] = true
    persist()
  }

  /** Renames a subscription and/or points it at a different feed. */
  function update(id: string, changes: { name?: string; url?: string }): void {
    const sub = subscriptions.value.find((s) => s.id === id)
    if (!sub) return
    const urlChanged = changes.url !== undefined && changes.url !== sub.url
    if (changes.name !== undefined) sub.name = changes.name
    if (changes.url !== undefined) sub.url = changes.url
    if (urlChanged) {
      // Events cached under the old feed would otherwise linger until the
      // next successful fetch of the new one.
      for (const key of Object.keys(byRange.value)) {
        if (key.startsWith(`${id}:`)) delete byRange.value[key]
      }
      delete errors[id]
    }
    persist()
  }

  function remove(id: string): void {
    subscriptions.value = subscriptions.value.filter((s) => s.id !== id)
    delete enabled[id]
    delete savedEnabled[id]
    saveEnabledState(ENABLED_KEY, savedEnabled)
    delete errors[id]
    persist()
  }

  function toggle(id: string): void {
    enabled[id] = !enabled[id]
    savedEnabled[id] = enabled[id]
    saveEnabledState(ENABLED_KEY, savedEnabled)
  }

  function setColor(id: string, color: string): void {
    const sub = subscriptions.value.find((s) => s.id === id)
    if (sub) {
      sub.color = color
      persist()
    }
  }

  async function loadRange(start: string, end: string): Promise<void> {
    const active = subscriptions.value.filter((s) => enabled[s.id])
    await Promise.all(
      active.map(async (sub) => {
        try {
          const events = await api.getSubscriptionEvents(sub.url, start, end)
          // Remap to the local subscription id so color/name lookups
          // in the UI don't need to know the server's synthetic calendarId.
          byRange.value[rangeKey(sub.id, start, end)] = events.map((e) => ({ ...e, calendarId: sub.id }))
          delete errors[sub.id]
        } catch (err) {
          errors[sub.id] = err instanceof Error ? err.message : 'Failed to load subscription'
          byRange.value[rangeKey(sub.id, start, end)] = []
        }
      }),
    )
  }

  function eventsFor(start: string, end: string): CalendarObject[] {
    return subscriptions.value
      .filter((s) => enabled[s.id])
      .flatMap((s) => byRange.value[rangeKey(s.id, start, end)] ?? [])
  }

  return { subscriptions, enabled, errors, serverBacked, syncError, init, clear, add, update, remove, toggle, setColor, loadRange, eventsFor }
})
