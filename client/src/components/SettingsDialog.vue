<script setup lang="ts">
import { computed } from 'vue'
import { REMINDER_PRESETS } from '../lib/reminders.js'
import { useCalendarsStore } from '../stores/calendars.js'
import { useSessionStore } from '../stores/session.js'
import {
  DEFAULT_EVENT_LENGTHS,
  useSettingsStore,
  type AddressFormat,
  type CalendarSortOrder,
  type CalendarViewType,
  type ContactSortOrder,
  type DefaultCalendarMode,
  type Theme,
  type TimeFormat,
  type WeekStart,
} from '../stores/settings.js'

const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()
const session = useSessionStore()
const calendarsStore = useCalendarsStore()

const weekStartModel = computed<WeekStart>({
  get: () => settingsStore.weekStart,
  set: (value) => settingsStore.setWeekStart(value),
})

const calendarSortOrderModel = computed<CalendarSortOrder>({
  get: () => settingsStore.calendarSortOrder,
  set: (value) => settingsStore.setCalendarSortOrder(value),
})

const timeFormatModel = computed<TimeFormat>({
  get: () => settingsStore.timeFormat,
  set: (value) => settingsStore.setTimeFormat(value),
})

const addressFormatModel = computed<AddressFormat>({
  get: () => settingsStore.addressFormat,
  set: (value) => settingsStore.setAddressFormat(value),
})

const contactSortOrderModel = computed<ContactSortOrder>({
  get: () => settingsStore.contactSortOrder,
  set: (value) => settingsStore.setContactSortOrder(value),
})

const defaultViewModel = computed<CalendarViewType>({
  get: () => settingsStore.defaultView,
  set: (value) => settingsStore.setDefaultView(value),
})

const themeModel = computed<Theme>({
  get: () => settingsStore.theme,
  set: (value) => settingsStore.setTheme(value),
})

const nowIndicatorModel = computed<boolean>({
  get: () => settingsStore.nowIndicator,
  set: (value) => settingsStore.setNowIndicator(value),
})

const weekNumbersModel = computed<boolean>({
  get: () => settingsStore.weekNumbers,
  set: (value) => settingsStore.setWeekNumbers(value),
})

const showWeekendsModel = computed<boolean>({
  get: () => settingsStore.showWeekends,
  set: (value) => settingsStore.setShowWeekends(value),
})

const scrollHourModel = computed<number>({
  get: () => settingsStore.scrollHour,
  set: (value) => settingsStore.setScrollHour(value),
})

const defaultEventLengthModel = computed<number>({
  get: () => settingsStore.defaultEventLength,
  set: (value) => settingsStore.setDefaultEventLength(value),
})

const defaultReminderModel = computed<number | null>({
  get: () => settingsStore.defaultReminder,
  set: (value) => settingsStore.setDefaultReminder(value),
})

// Labels follow the time-format setting, e.g. "8 AM" vs "08:00".
function hourLabel(hour: number): string {
  if (settingsStore.timeFormat === '24h') return `${String(hour).padStart(2, '0')}:00`
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`
}

function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  return minutes === 60 ? '1 hour' : `${minutes / 60} hours`
}

// Same "writable + currently enabled" restriction CalendarView applies when
// seeding the new-event dialog's default calendar -- a default that's
// read-only or hidden can't actually be used to create an event.
const writableEnabledCalendarIds = computed(() =>
  calendarsStore.calendars.filter((c) => calendarsStore.enabled[c.id] && !c.readOnly).map((c) => c.id),
)

const preferredDefaultCalendarId = computed(() =>
  writableEnabledCalendarIds.value.includes(settingsStore.defaultCalendarId)
    ? settingsStore.defaultCalendarId
    : (writableEnabledCalendarIds.value[0] ?? ''),
)

const defaultCalendarModel = computed<string>({
  get: () => preferredDefaultCalendarId.value,
  set: (value) => settingsStore.setDefaultCalendarId(value),
})

const defaultCalendarModeModel = computed<DefaultCalendarMode>({
  get: () => settingsStore.defaultCalendarMode,
  set: (value) => settingsStore.setDefaultCalendarMode(value),
})

// An empty preference list means "no explicit choice yet" -- every calendar
// is visible, same as before this setting existed -- so an unset checkbox
// still reads as checked.
function isDefaultVisible(id: string): boolean {
  const ids = settingsStore.defaultVisibleCalendarIds
  return ids.length === 0 || ids.includes(id)
}

function toggleDefaultVisible(id: string): void {
  const allIds = calendarsStore.calendars.map((c) => c.id)
  const current = settingsStore.defaultVisibleCalendarIds.length === 0 ? allIds : settingsStore.defaultVisibleCalendarIds
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
  settingsStore.setDefaultVisibleCalendarIds(next)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <h2>Settings</h2>

      <label class="dialog__field dialog__field--row">
        <span>Theme</span>
        <select v-model="themeModel">
          <option value="auto">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>

      <label class="dialog__field dialog__field--row">
        <span>Week starts on</span>
        <select v-model="weekStartModel">
          <option value="sunday">Sunday</option>
          <option value="monday">Monday</option>
        </select>
      </label>

      <label class="dialog__field dialog__field--row">
        <span>Default view</span>
        <select v-model="defaultViewModel">
          <option value="multiMonthYear">Year</option>
          <option value="dayGridMonth">Month</option>
          <option value="timeGridWeek">Week</option>
          <option value="timeGridDay">Day</option>
          <option value="listUpcoming">Agenda</option>
        </select>
      </label>

      <label class="dialog__field dialog__field--row">
        <span>Day/week view opens at</span>
        <select v-model.number="scrollHourModel">
          <option v-for="hour in 24" :key="hour - 1" :value="hour - 1">{{ hourLabel(hour - 1) }}</option>
        </select>
      </label>

      <label class="dialog__checkbox dialog__field">
        <input v-model="showWeekendsModel" type="checkbox" />
        Show weekends
      </label>

      <label class="dialog__checkbox dialog__field">
        <input v-model="weekNumbersModel" type="checkbox" />
        Show week numbers
      </label>

      <label class="dialog__checkbox dialog__field">
        <input v-model="nowIndicatorModel" type="checkbox" />
        Show current-time line
      </label>

      <label class="dialog__field dialog__field--row">
        <span>Sort calendars by</span>
        <select v-model="calendarSortOrderModel">
          <option value="server">Server order</option>
          <option value="name-asc">Name (A→Z)</option>
          <option value="name-desc">Name (Z→A)</option>
        </select>
      </label>

      <label class="dialog__field dialog__field--row">
        <span>Time format</span>
        <select v-model="timeFormatModel">
          <option value="12h">12-hour</option>
          <option value="24h">24-hour</option>
        </select>
      </label>

      <label
        class="dialog__field dialog__field--row"
        title="US: city, state ZIP. International: postal code before the city."
      >
        <span>Address format</span>
        <select v-model="addressFormatModel">
          <option value="us">US</option>
          <option value="intl">International</option>
        </select>
      </label>

      <label class="dialog__field dialog__field--row" title="Which name contacts are sorted by first.">
        <span>Sort contacts by</span>
        <select v-model="contactSortOrderModel">
          <option value="last-first">Last name</option>
          <option value="first-last">First name</option>
        </select>
      </label>

      <label v-if="writableEnabledCalendarIds.length > 0" class="dialog__field dialog__field--row">
        <span>Default calendar</span>
        <select v-model="defaultCalendarModel">
          <option v-for="id in writableEnabledCalendarIds" :key="id" :value="id">
            {{ calendarsStore.calendars.find((c) => c.id === id)?.displayName }}
          </option>
        </select>
      </label>

      <label v-if="writableEnabledCalendarIds.length > 0" class="dialog__field dialog__field--row">
        <span>New events use</span>
        <select v-model="defaultCalendarModeModel">
          <option value="fixed">Default calendar</option>
          <option value="last-used">Last used calendar</option>
        </select>
      </label>

      <label class="dialog__field dialog__field--row">
        <span>Default event length</span>
        <select v-model.number="defaultEventLengthModel">
          <option v-for="minutes in DEFAULT_EVENT_LENGTHS" :key="minutes" :value="minutes">
            {{ lengthLabel(minutes) }}
          </option>
        </select>
      </label>

      <label class="dialog__field dialog__field--row">
        <span>Default reminder</span>
        <select v-model="defaultReminderModel">
          <option :value="null">None</option>
          <option v-for="preset in REMINDER_PRESETS" :key="preset.minutes" :value="preset.minutes">
            {{ preset.label }}
          </option>
        </select>
      </label>

      <div v-if="calendarsStore.calendars.length > 0" class="dialog__field">
        <span>Default visible calendars</span>
        <label v-for="cal in calendarsStore.calendars" :key="cal.id" class="dialog__checkbox">
          <input
            type="checkbox"
            :checked="isDefaultVisible(cal.id)"
            @change="toggleDefaultVisible(cal.id)"
          />
          {{ cal.displayName }}
        </label>
      </div>

      <div class="dialog__actions">
        <span v-if="session.info?.version" class="dialog__version">Version {{ session.info.version }}</span>
        <button type="button" class="btn btn-primary" @click="emit('close')">Done</button>
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
  width: 320px;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  animation: pop-in 0.14s ease;
}
.dialog h2 {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}
.dialog__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.75rem;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.dialog__field--row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}
.dialog__checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: inherit;
}
/* Standalone toggle rows match the other setting labels. */
.dialog__field.dialog__checkbox {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.dialog__field select {
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  background: var(--color-surface);
  color: inherit;
}
.dialog__version {
  margin-right: auto;
  align-self: center;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
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
