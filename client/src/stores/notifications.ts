import type { CalendarObject } from '@yourdav/shared'
import { DateTime } from 'luxon'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { t } from '../i18n.js'
import { useSettingsStore } from './settings.js'

// Only reminders whose fire time falls within this window of "now" get a
// setTimeout scheduled -- an alarm three months out would need a timer
// that outlives any realistic tab lifetime anyway, and timers don't
// survive a reload regardless, so this just re-arms on every subsequent
// load instead of trying to schedule far in advance.
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000

export const useNotificationsStore = defineStore('notifications', () => {
  const permission = ref<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const scheduled = new Map<string, { handle: ReturnType<typeof setTimeout>; fireAt: number }>()

  // Never call this unprompted on load -- browsers throttle/block
  // permission requests not triggered by a real user gesture, and it's
  // poor UX regardless. Call from an explicit settings toggle/button.
  async function requestPermission(): Promise<void> {
    if (typeof Notification === 'undefined') return
    permission.value = await Notification.requestPermission()
  }

  function fire(event: CalendarObject, minutesBefore: number): void {
    if (permission.value !== 'granted') return
    const when = DateTime.fromISO(event.start)
    const timeFmt = useSettingsStore().timeFormat === '24h' ? 'HH:mm' : 'h:mm a'
    new Notification(event.summary || t('common.noTitle'), {
      body: minutesBefore === 0 ? t('notifications.startingNow') : t('notifications.reminder', { time: when.toFormat(timeFmt), n: minutesBefore }),
      tag: `${event.calendarId}:${event.uid}:${event.recurrenceId ?? ''}:${minutesBefore}`,
    })
  }

  // Reminders only fire while this tab is open (or backgrounded but not
  // closed) -- no service worker, no push, no background delivery when
  // the tab isn't running. Call this after every successful events load.
  function scheduleForEvents(events: CalendarObject[]): void {
    if (permission.value !== 'granted') return
    const now = Date.now()

    // For every event this batch has full knowledge of (i.e. it's present,
    // so event.alarms is its complete current alarm list), clear any
    // previously scheduled timer for an alarm that no longer exists on it
    // -- otherwise removing a reminder (or the whole event, so long as it's
    // still in the reloaded batch as having zero alarms) leaves the old
    // timer active and it still fires later.
    const validKeysByEvent = new Map<string, Set<string>>()
    for (const event of events) {
      const eventPrefix = `${event.calendarId}:${event.uid}:${event.recurrenceId ?? ''}`
      validKeysByEvent.set(eventPrefix, new Set(event.alarms.map((a) => `${eventPrefix}:${a.minutesBefore}`)))
    }
    for (const [key, entry] of scheduled) {
      const eventPrefix = key.slice(0, key.lastIndexOf(':'))
      const validKeys = validKeysByEvent.get(eventPrefix)
      if (validKeys && !validKeys.has(key)) {
        clearTimeout(entry.handle)
        scheduled.delete(key)
      }
    }

    for (const event of events) {
      for (const alarm of event.alarms) {
        const key = `${event.calendarId}:${event.uid}:${event.recurrenceId ?? ''}:${alarm.minutesBefore}`
        const fireAt = DateTime.fromISO(event.start).minus({ minutes: alarm.minutesBefore }).toMillis()

        // Editing an event (e.g. moving its start time) doesn't change this
        // key, only fireAt -- without checking fireAt too, the stale timer
        // from before the edit would stay scheduled and fire at the old
        // time instead of being replaced.
        const existing = scheduled.get(key)
        if (existing) {
          if (existing.fireAt === fireAt) continue
          clearTimeout(existing.handle)
          scheduled.delete(key)
        }

        const delay = fireAt - now
        if (delay < 0 || delay > LOOKAHEAD_MS) continue

        const handle = setTimeout(() => {
          scheduled.delete(key)
          fire(event, alarm.minutesBefore)
        }, delay)
        scheduled.set(key, { handle, fireAt })
      }
    }
  }

  function clear(): void {
    for (const { handle } of scheduled.values()) clearTimeout(handle)
    scheduled.clear()
  }

  return { permission, requestPermission, scheduleForEvents, clear }
})
