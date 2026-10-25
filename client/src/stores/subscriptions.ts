import type { CalendarObject } from '@yourdav/shared'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'

export interface Subscription {
  id: string
  name: string
  url: string
  color: string
}

const STORAGE_KEY = 'calendar.subscriptions'
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

function rangeKey(id: string, start: string, end: string): string {
  return `${id}:${start}:${end}`
}

export const useSubscriptionsStore = defineStore('subscriptions', () => {
  const subscriptions = ref<Subscription[]>(loadSubscriptions())
  const enabled = reactive<Record<string, boolean>>(Object.fromEntries(subscriptions.value.map((s) => [s.id, true])))
  const byRange = ref<Record<string, CalendarObject[]>>({})
  const errors = reactive<Record<string, string>>({})

  // The list lives on the DAV server (see server/src/dav/userSettings.ts) so
  // it follows the account across browsers and logouts; localStorage stays as
  // a mirror and as the whole store on servers that can't hold the property.
  const serverBacked = ref(true)
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
      } catch (err) {
        // 501 = this DAV server can't store it: stay browser-local from now on.
        if (err instanceof ApiRequestError && err.status === 501) serverBacked.value = false
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
    try {
      const { subscriptions: stored } = await api.getStoredSubscriptions()
      if (stored === null) {
        // Nothing saved yet: seed the server from this browser's list.
        if (subscriptions.value.length > 0) pushToServer()
        return
      }
      subscriptions.value = stored
      for (const sub of stored) if (!(sub.id in enabled)) enabled[sub.id] = true
      writeLocal()
    } catch {
      // Server unreachable: keep working from the browser-local list.
    }
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
    delete errors[id]
    persist()
  }

  function toggle(id: string): void {
    enabled[id] = !enabled[id]
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

  return { subscriptions, enabled, errors, serverBacked, init, add, update, remove, toggle, setColor, loadRange, eventsFor }
})
