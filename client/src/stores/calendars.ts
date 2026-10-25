import type { Calendar, UpdateCalendarInput } from '@yourdav/shared'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { api } from '../api.js'
import { loadEnabledState, saveEnabledState } from '../lib/enabledState.js'
import { useSettingsStore } from './settings.js'

const ENABLED_KEY = 'calendar.enabledState'

const COLOR_OVERRIDE_KEY = 'calendar.colorOverrides'
// v2: the original key stored dismissal timestamps from the browser's own
// Date.now(), compared against Radicale's TimestampUpdated -- a different
// clock that (confirmed by testing) can be hours off from real UTC on a
// non-UTC host, since Radicale computes it from the server's naive local
// time treated as UTC. Any value saved under the v1 key is permanently
// wrong (almost always larger than any real updatedAt it's compared
// against, so it suppresses that share forever, even after the owner
// re-shares). Renamed rather than migrated in place -- there's no way to
// tell a "corrupted" v1 entry from a valid one after the fact, and losing
// a dismissal is a no-cost, self-correcting mistake (the Dismiss button
// on PendingSharesList.vue re-hides it with a single click), whereas a
// silently-still-wrong entry from either individual detection or a
// blanket per-clock offset guess is not.
const DISMISSED_PENDING_KEY = 'calendar.dismissedPendingShares.v2'

function loadColorOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(COLOR_OVERRIDE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// pathOrToken -> the dismissedAt timestamp (ms) from the unsubscribe that
// hid it. Radicale's map "hide" has no separate "declined" state -- a
// hidden-but-still-owner-enabled share otherwise resurfaces in the pending
// list exactly like a fresh invite, so this suppresses any pending entry
// whose own `updatedAt` hasn't moved past the point it was dismissed (see
// PendingSharesList.vue and UnsubscribeResult in shared/src/index.ts).
function loadDismissedPending(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DISMISSED_PENDING_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export const useCalendarsStore = defineStore('calendars', () => {
  const calendars = ref<Calendar[]>([])
  const enabled = reactive<Record<string, boolean>>({})
  const savedEnabled = loadEnabledState(ENABLED_KEY)
  const colorOverrides = reactive<Record<string, string>>(loadColorOverrides())
  const dismissedPending = reactive<Record<string, number>>(loadDismissedPending())
  const loading = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      calendars.value = await api.listCalendars()
      const defaultVisibleIds = useSettingsStore().defaultVisibleCalendarIds
      for (const cal of calendars.value) {
        if (!(cal.id in enabled)) {
          enabled[cal.id] = savedEnabled[cal.id] ?? (defaultVisibleIds.length === 0 || defaultVisibleIds.includes(cal.id))
        }
      }
    } finally {
      loading.value = false
    }
  }

  function toggle(id: string): void {
    enabled[id] = !enabled[id]
    savedEnabled[id] = enabled[id]
    saveEnabledState(ENABLED_KEY, savedEnabled)
  }

  async function create(displayName: string, color?: string): Promise<Calendar> {
    const created = await api.createCalendar({ displayName, color })
    calendars.value.push(created)
    enabled[created.id] = true
    return created
  }

  async function renameCalendar(id: string, input: UpdateCalendarInput): Promise<void> {
    const updated = await api.updateCalendar(id, input)
    const idx = calendars.value.findIndex((c) => c.id === id)
    if (idx >= 0) calendars.value[idx] = updated
    if (input.color !== undefined && id in colorOverrides) {
      delete colorOverrides[id]
      persistOverrides()
    }
  }

  // The swatch previews live through a local override (setColorOverride);
  // this commits the final pick to the DAV server so it follows the user to
  // other browsers/clients. If the server refuses (e.g. a read-only share),
  // the local override simply stays.
  async function saveColor(id: string, color: string): Promise<void> {
    try {
      await renameCalendar(id, { color })
    } catch {
      setColorOverride(id, color)
    }
  }

  function forget(id: string): void {
    calendars.value = calendars.value.filter((c) => c.id !== id)
    delete enabled[id]
    delete savedEnabled[id]
    saveEnabledState(ENABLED_KEY, savedEnabled)
    delete colorOverrides[id]
    persistOverrides()
  }

  async function deleteCalendar(id: string): Promise<void> {
    await api.deleteCalendar(id)
    forget(id)
  }

  function dismissPending(pathOrToken: string, dismissedAt: number): void {
    dismissedPending[pathOrToken] = dismissedAt
    localStorage.setItem(DISMISSED_PENDING_KEY, JSON.stringify(dismissedPending))
  }

  async function unsubscribeCalendar(id: string): Promise<void> {
    const result = await api.unsubscribeCalendar(id)
    if (result.dismissedPending) {
      dismissPending(result.dismissedPending.pathOrToken, result.dismissedPending.dismissedAt)
    }
    forget(id)
  }

  function colorFor(id: string): string {
    return colorOverrides[id] ?? calendars.value.find((c) => c.id === id)?.color ?? '#0082c9'
  }

  function persistOverrides(): void {
    localStorage.setItem(COLOR_OVERRIDE_KEY, JSON.stringify(colorOverrides))
  }

  function setColorOverride(id: string, color: string): void {
    colorOverrides[id] = color
    persistOverrides()
  }

  function resetColorOverride(id: string): void {
    delete colorOverrides[id]
    persistOverrides()
  }

  return {
    calendars,
    enabled,
    colorOverrides,
    dismissedPending,
    loading,
    load,
    toggle,
    create,
    renameCalendar,
    saveColor,
    deleteCalendar,
    unsubscribeCalendar,
    dismissPending,
    colorFor,
    setColorOverride,
    resetColorOverride,
  }
})
