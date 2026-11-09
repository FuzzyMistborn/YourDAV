<script setup lang="ts">
import type { AlarmFields, Calendar, CalendarObject, EventFields } from '@yourdav/shared'
import { DateTime } from 'luxon'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { sortCalendars } from '../lib/calendarSort.js'
import { REMINDER_PRESETS } from '../lib/reminders.js'
import { useSessionStore } from '../stores/session.js'
import { useSettingsStore } from '../stores/settings.js'
import TimeCombobox from './TimeCombobox.vue'

const session = useSessionStore()
const settingsStore = useSettingsStore()

const props = defineProps<{
  event: CalendarObject | null // null => creating a new event
  calendars: Calendar[]
  defaultCalendarId: string
  initialStart?: string
  initialEnd?: string
  initialAllDay?: boolean
  // When creating (event === null), pre-fill the content fields (title,
  // notes, recurrence, reminders, ...) from this event -- used by
  // "Duplicate" / paste. The title is prefixed with "Copy of ".
  template?: CalendarObject | null
}>()

const emit = defineEmits<{
  save: [calendarId: string, fields: EventFields]
  remove: []
  duplicate: []
  close: []
}>()

// The event whose *content* seeds the form: the one being edited, or the
// duplicate/paste template. Never drives isEditing (that's props.event only).
const source = props.event ?? props.template ?? null

type RepeatOption = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
type RepeatEnd = 'never' | 'count' | 'until'

const FREQ_BY_REPEAT: Record<Exclude<RepeatOption, 'none'>, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
}
const REPEAT_BY_FREQ: Record<string, RepeatOption> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}
const UNIT_LABELS: Record<Exclude<RepeatOption, 'none'>, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
type WeekdayCode = (typeof WEEKDAY_CODES)[number]
const WEEKDAY_BUTTON_LABELS: Record<WeekdayCode, string> = {
  SU: 'Su',
  MO: 'Mo',
  TU: 'Tu',
  WE: 'We',
  TH: 'Th',
  FR: 'Fr',
  SA: 'Sa',
}
const WEEKDAY_SHORT_NAMES: Record<WeekdayCode, string> = {
  SU: 'Sun',
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
}
// Luxon's DateTime.weekday is ISO-8601: 1 = Monday ... 7 = Sunday.
const ISO_WEEKDAY_TO_CODE: WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

type MonthlyMode = 'dayOfMonth' | 'weekday'
const MONTHLY_ORDINAL_LABELS: Record<number, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  '-1': 'last',
}
// -1 means "last" (RRULE's own convention for a negative BYDAY ordinal).
const MONTHLY_ORDINALS = [1, 2, 3, 4, -1] as const

const TIME_STEP_MINUTES = 5

// `iso` is always a UTC instant (mapper.ts serializes via toJSDate().toISOString()),
// so the wall-clock date/time it prints depends entirely on which zone it's
// read back in. Without an explicit zone, Luxon converts to the *browser's*
// local zone by default -- but the form labels these fields with the
// event's own timezone (form.timezone), so that mismatch silently shifts
// the displayed (and, if saved unchanged, re-saved) wall-clock time
// whenever the viewer isn't in the event's zone. Always pass the zone the
// field is actually labeled with.
function initialDate(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat('yyyy-LL-dd')
}
function initialTime(iso: string, zone: string): string {
  const dt = DateTime.fromISO(iso, { zone })
  const roundedMinute = Math.round(dt.minute / TIME_STEP_MINUTES) * TIME_STEP_MINUTES
  return dt.set({ minute: 0, second: 0, millisecond: 0 }).plus({ minutes: roundedMinute }).toFormat('HH:mm')
}

interface ParsedRepeat {
  repeat: RepeatOption | 'custom'
  interval: number
  end: RepeatEnd
  count: number
  until: string
  weekdays: WeekdayCode[]
  monthlyMode: MonthlyMode
  monthlyOrdinal: number
  monthlyWeekday: WeekdayCode
}

// UNTIL is always stored as a UTC instant (or a bare date for all-day
// series) -- like every other date field in this file, it must be read back
// in the event's own zone, not the browser's, or it silently shifts by a
// day for a viewer in a different zone (see initialDate/initialTime above).
function parseIcalUntil(until: string, zone: string): string | null {
  const dt = until.length > 8 ? DateTime.fromFormat(until, "yyyyLLdd'T'HHmmss'Z'", { zone: 'utc' }) : DateTime.fromFormat(until, 'yyyyLLdd')
  return dt.isValid ? dt.setZone(zone).toFormat('yyyy-LL-dd') : null
}

// Recognizes FREQ + optional INTERVAL/COUNT/UNTIL/BYDAY. BYDAY means
// different things depending on FREQ: for weekly, a plain weekday-code list
// (e.g. "TU,TH"); for monthly, a *single* ordinal-prefixed code (e.g. "2TU"
// for "2nd Tuesday", "-1FR" for "last Friday" -- RRULE's own convention for
// "last"). Anything else (yearly BYDAY, multiple monthly BYDAYs, BYSETPOS,
// etc.) falls back to 'custom', which the picker shows but can't produce;
// keep its existing rule unless the user explicitly picks a different option.
function parseRepeat(
  rrule: string | null,
  fallbackUntil: string,
  defaultWeekday: WeekdayCode,
  defaultMonthlyOrdinal: number,
  zone: string,
): ParsedRepeat {
  const fallback: ParsedRepeat = {
    repeat: 'none',
    interval: 1,
    end: 'never',
    count: 1,
    until: fallbackUntil,
    weekdays: [defaultWeekday],
    monthlyMode: 'dayOfMonth',
    monthlyOrdinal: defaultMonthlyOrdinal,
    monthlyWeekday: defaultWeekday,
  }
  if (!rrule) return fallback

  const parts = Object.fromEntries(
    rrule.split(';').map((part) => {
      const [key, value] = part.split('=')
      return [key, value] as [string, string]
    }),
  )
  const repeat = REPEAT_BY_FREQ[parts.FREQ]
  const allowedKeys = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY'])
  const hasUnsupportedKey = Object.keys(parts).some((k) => !allowedKeys.has(k))
  if (!repeat || hasUnsupportedKey) {
    return { ...fallback, repeat: 'custom' }
  }

  let weekdays: WeekdayCode[] = [defaultWeekday]
  let monthlyMode: MonthlyMode = 'dayOfMonth'
  let monthlyOrdinal = defaultMonthlyOrdinal
  let monthlyWeekday = defaultWeekday

  if (parts.BYDAY) {
    if (repeat === 'weekly') {
      const codes = parts.BYDAY.split(',').map((c) => c.trim().toUpperCase())
      if (codes.length === 0 || !codes.every((c) => (WEEKDAY_CODES as readonly string[]).includes(c))) {
        return { ...fallback, repeat: 'custom' }
      }
      weekdays = codes as WeekdayCode[]
    } else if (repeat === 'monthly') {
      const match = /^(-?\d{1,2})(SU|MO|TU|WE|TH|FR|SA)$/.exec(parts.BYDAY.trim().toUpperCase())
      if (!match) return { ...fallback, repeat: 'custom' }
      monthlyMode = 'weekday'
      monthlyOrdinal = parseInt(match[1], 10)
      monthlyWeekday = match[2] as WeekdayCode
    } else {
      return { ...fallback, repeat: 'custom' }
    }
  }

  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1
  const base = { repeat, interval, weekdays, monthlyMode, monthlyOrdinal, monthlyWeekday }
  if (parts.COUNT) {
    return { ...base, end: 'count', count: parseInt(parts.COUNT, 10), until: fallbackUntil }
  }
  if (parts.UNTIL) {
    const until = parseIcalUntil(parts.UNTIL, zone)
    return until ? { ...base, end: 'until', count: 1, until } : { ...fallback, repeat: 'custom' }
  }
  return { ...base, end: 'never', count: 1, until: fallbackUntil }
}

const initialAllDay = props.event?.allDay ?? props.initialAllDay ?? source?.allDay ?? false
const initialStartIso = props.event?.start ?? props.initialStart ?? source?.start ?? new Date().toISOString()
const initialEndIso = props.event?.end ?? props.initialEnd ?? source?.end ?? initialStartIso

// Intl.supportedValuesOf('timeZone') returns every IANA zone name the
// runtime knows -- no separate timezone-data dependency needed client-side.
const TIMEZONES = Intl.supportedValuesOf('timeZone')
// The server's DEFAULT_TIMEZONE (see config.ts), when set and a zone name
// this runtime actually recognizes, takes priority over the browser's own
// auto-detected zone for a *new* event -- useful for a shared/kiosk
// instance where "wherever this browser happens to be" isn't the zone
// events should default to.
const serverDefaultZone = session.info?.defaultTimezone
const configuredDefaultZone =
  serverDefaultZone && (TIMEZONES as string[]).includes(serverDefaultZone) ? serverDefaultZone : null
const browserZone = configuredDefaultZone ?? DateTime.local().zoneName

// The zone every initial date/time field below is read in -- must match
// what the Time zone select ends up labeled with (form.timezone), or the
// displayed wall-clock time silently disagrees with the label (see
// initialDate/initialTime's doc comment). All-day events have no timezone
// of their own; their ISO instants are UTC-midnight-anchored calendar
// dates, so those are read back in UTC rather than the event's/browser's zone.
const initialZone = initialAllDay ? 'utc' : (source?.timezone ?? browserZone)

// All-day events are stored/transmitted with an *exclusive* end (CalDAV's
// DTEND convention: a single-day event has end = start + 1 day) but the
// End field should show the *inclusive* last day, like every calendar UI
// users are used to -- otherwise a plain one-day all-day event defaults to
// showing "tomorrow" in the End field, which reads as a bug.
const initialEndDateDisplay = initialAllDay
  ? DateTime.fromISO(initialEndIso, { zone: initialZone }).minus({ days: 1 }).toFormat('yyyy-LL-dd')
  : initialDate(initialEndIso, initialZone)

const defaultUntil = DateTime.fromISO(initialStartIso, { zone: initialZone }).plus({ months: 3 }).toFormat('yyyy-LL-dd')
const startDt = DateTime.fromISO(initialStartIso, { zone: initialZone })
const defaultWeekday = ISO_WEEKDAY_TO_CODE[startDt.weekday - 1]
// "Nth weekday of the month" ordinal for the start date's own day -- e.g.
// Aug 11 2026 is the 2nd Tuesday, so that's the default if the user
// switches to "on the Nth weekday" mode without picking an ordinal.
const defaultMonthlyOrdinal = Math.ceil(startDt.day / 7)
const parsedRepeat = parseRepeat(source?.rrule ?? null, defaultUntil, defaultWeekday, defaultMonthlyOrdinal, initialZone)

const form = reactive({
  calendarId: props.event?.calendarId ?? props.template?.calendarId ?? props.defaultCalendarId,
  summary: props.event ? props.event.summary : props.template ? `Copy of ${props.template.summary}` : '',
  description: source?.description ?? '',
  location: source?.location ?? '',
  allDay: initialAllDay,
  timezone: source?.timezone ?? browserZone,
  startDate: initialDate(initialStartIso, initialZone),
  startTime: initialTime(initialStartIso, initialZone),
  endDate: initialEndDateDisplay,
  endTime: initialTime(initialEndIso, initialZone),
  repeat: parsedRepeat.repeat,
  repeatInterval: parsedRepeat.interval,
  repeatEnd: parsedRepeat.end,
  repeatCount: parsedRepeat.count,
  repeatUntil: parsedRepeat.until,
  repeatWeekdays: parsedRepeat.weekdays,
  monthlyMode: parsedRepeat.monthlyMode,
  monthlyOrdinal: parsedRepeat.monthlyOrdinal,
  monthlyWeekday: parsedRepeat.monthlyWeekday,
  color: source?.color ?? '',
  // A brand-new event (not an edit, not a duplicate/paste) starts with the
  // user's default reminder, if they've set one.
  reminders: source
    ? (source.alarms?.map((a) => a.minutesBefore) ?? [])
    : settingsStore.defaultReminder !== null
      ? [settingsStore.defaultReminder]
      : [],
  // Extra one-off occurrence dates on top of the RRULE -- date-only
  // ('yyyy-LL-dd'), always interpreted in form.timezone like the rest of
  // the form's date/time fields.
  rdates: (source?.rdate ?? []).map((iso) => DateTime.fromISO(iso, { zone: initialZone }).toFormat('yyyy-LL-dd')),
})

function addRdate(): void {
  form.rdates.push(form.startDate)
}
function removeRdate(index: number): void {
  form.rdates.splice(index, 1)
}

function addReminder(): void {
  form.reminders.push(10)
}
function removeReminder(index: number): void {
  form.reminders.splice(index, 1)
}
function buildAlarms(): AlarmFields[] {
  return form.reminders.map((minutesBefore) => ({ minutesBefore }))
}

function toggleWeekday(code: WeekdayCode): void {
  const idx = form.repeatWeekdays.indexOf(code)
  if (idx >= 0) form.repeatWeekdays.splice(idx, 1)
  else form.repeatWeekdays.push(code)
}

const isEditing = computed(() => props.event !== null)

// Switching off "All day" previously left whatever start/end times happened
// to be there -- for an event that was created as all-day, that's 00:00 for
// both, an instantly-invalid zero-length range once time fields reappear.
// Reset to a sensible default hour block instead.
let suppressDurationSync = false
watch(
  () => form.allDay,
  (allDay, wasAllDay) => {
    if (wasAllDay && !allDay) {
      // Don't let the duration-sync watch below react to these writes.
      suppressDurationSync = true
      form.startTime = '00:00'
      form.endTime = '01:00'
      void nextTick(() => {
        suppressDurationSync = false
      })
    }
  },
)

// Keep the event's length constant when the start changes: shift the end by
// the same amount, like every other calendar app. Skipped while a field is
// mid-edit / unparseable.
watch(
  () => [form.startDate, form.startTime] as const,
  ([newDate, newTime], [oldDate, oldTime]) => {
    if (suppressDurationSync || (newDate === oldDate && newTime === oldTime)) return

    const parse = (d: string, t: string): DateTime =>
      form.allDay
        ? DateTime.fromFormat(d, 'yyyy-LL-dd')
        : DateTime.fromFormat(`${d} ${t}`, 'yyyy-LL-dd HH:mm', { zone: form.timezone })

    const oldStart = parse(oldDate, oldTime)
    const newStart = parse(newDate, newTime)
    const oldEnd = parse(form.endDate, form.endTime)
    if (!oldStart.isValid || !newStart.isValid || !oldEnd.isValid) return

    const newEnd = oldEnd.plus(newStart.diff(oldStart))
    form.endDate = newEnd.toFormat('yyyy-LL-dd')
    if (!form.allDay) form.endTime = newEnd.toFormat('HH:mm')
  },
)

const swatchColor = computed(
  () => form.color || props.calendars.find((c) => c.id === form.calendarId)?.color || '#0082c9',
)

const intervalUnitLabel = computed(() => {
  if (form.repeat === 'none' || form.repeat === 'custom') return ''
  const [singular, plural] = UNIT_LABELS[form.repeat]
  return form.repeatInterval === 1 ? singular : plural
})

function buildRrule(): string | null {
  if (form.repeat === 'none') return null
  if (form.repeat === 'custom') return source?.rrule ?? null

  const parts = [`FREQ=${FREQ_BY_REPEAT[form.repeat]}`]
  if (form.repeatInterval > 1) parts.push(`INTERVAL=${form.repeatInterval}`)
  if (form.repeat === 'weekly' && form.repeatWeekdays.length > 0) {
    parts.push(`BYDAY=${form.repeatWeekdays.join(',')}`)
  }
  if (form.repeat === 'monthly' && form.monthlyMode === 'weekday') {
    parts.push(`BYDAY=${form.monthlyOrdinal}${form.monthlyWeekday}`)
  }
  if (form.repeatEnd === 'count') {
    parts.push(`COUNT=${form.repeatCount}`)
  } else if (form.repeatEnd === 'until') {
    // Parsed in form.timezone, not the browser's local zone -- otherwise a
    // viewer in a different zone than the event would compute the wrong
    // UNTIL instant (see onSubmit's dtStart/dtEnd for the same issue).
    const until = form.allDay
      ? DateTime.fromFormat(form.repeatUntil, 'yyyy-LL-dd')
      : DateTime.fromFormat(`${form.repeatUntil} 23:59:59`, 'yyyy-LL-dd HH:mm:ss', { zone: form.timezone })
    const untilStr = form.allDay ? until.toFormat('yyyyLLdd') : until.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'")
    parts.push(`UNTIL=${untilStr}`)
  }
  return parts.join(';')
}

const repeatPreview = computed<string | null>(() => {
  if (form.repeat === 'none') return null
  if (form.repeat === 'custom') return 'Custom recurrence rule (unchanged by this dialog).'

  let text = form.repeatInterval > 1 ? `Repeats every ${form.repeatInterval} ${intervalUnitLabel.value}` : `Repeats every ${intervalUnitLabel.value}`
  if (form.repeat === 'weekly' && form.repeatWeekdays.length > 0) {
    const ordered = WEEKDAY_CODES.filter((c) => form.repeatWeekdays.includes(c))
    text += ` on ${ordered.map((c) => WEEKDAY_SHORT_NAMES[c]).join(', ')}`
  }
  if (form.repeat === 'monthly' && form.monthlyMode === 'weekday') {
    text += ` on the ${MONTHLY_ORDINAL_LABELS[form.monthlyOrdinal] ?? form.monthlyOrdinal} ${WEEKDAY_SHORT_NAMES[form.monthlyWeekday]}`
  }
  if (form.rdates.length > 0) {
    text += `, plus ${form.rdates.length} extra date${form.rdates.length === 1 ? '' : 's'}`
  }
  if (form.repeatEnd === 'count') {
    text += `, ${form.repeatCount} time${form.repeatCount === 1 ? '' : 's'}`
  } else if (form.repeatEnd === 'until') {
    const until = DateTime.fromFormat(form.repeatUntil, 'yyyy-LL-dd')
    text += until.isValid ? `, until ${until.toFormat('LLL d, yyyy')}` : ''
  }
  return `${text}.`
})

// Compares as plain strings ('yyyy-LL-dd' and 'HH:mm' both sort correctly
// lexicographically) so this doesn't need to touch DateTime at all.
const validationError = computed<string | null>(() => {
  if (form.endDate < form.startDate) {
    return form.allDay ? 'End date must be on or after the start date.' : 'End must be after start.'
  }
  if (!form.allDay && form.endDate === form.startDate && form.endTime <= form.startTime) {
    return 'End must be after start.'
  }
  if (form.repeat !== 'none' && form.repeat !== 'custom') {
    if (form.repeatEnd === 'count' && form.repeatCount < 1) {
      return 'Occurrence count must be at least 1.'
    }
    if (form.repeatEnd === 'until' && form.repeatUntil < form.startDate) {
      return 'Recurrence end date must be on or after the start date.'
    }
    if (form.repeat === 'weekly' && form.repeatWeekdays.length === 0) {
      return 'Select at least one day of the week.'
    }
  }
  if (form.reminders.some((m) => m < 0 || m > 40320)) {
    return 'Reminders must be between 0 minutes and 4 weeks before the event.'
  }
  return null
})

function onSubmit(): void {
  if (validationError.value) return

  // Parsed in form.timezone, not the browser's local zone -- otherwise a
  // viewer in a different zone than the event edits the same wall-clock
  // numbers but gets a different instant (e.g. a Los Angeles-based viewer
  // entering "9:00" for a New York event would silently save it as 9am
  // Pacific instead of 9am Eastern).
  const dtStart = form.allDay
    ? DateTime.fromFormat(form.startDate, 'yyyy-LL-dd')
    : DateTime.fromFormat(`${form.startDate} ${form.startTime}`, 'yyyy-LL-dd HH:mm', { zone: form.timezone })
  // Convert the inclusive last-day the user picked back to CalDAV's
  // exclusive end for all-day events.
  const dtEnd = form.allDay
    ? DateTime.fromFormat(form.endDate, 'yyyy-LL-dd').plus({ days: 1 })
    : DateTime.fromFormat(`${form.endDate} ${form.endTime}`, 'yyyy-LL-dd HH:mm', { zone: form.timezone })

  const fields: EventFields = {
    summary: form.summary,
    description: form.description || null,
    location: form.location || null,
    start: dtStart.toISO() ?? new Date().toISOString(),
    end: dtEnd.toISO() ?? new Date().toISOString(),
    allDay: form.allDay,
    timezone: form.allDay ? null : form.timezone,
    rrule: buildRrule(),
    color: form.color || null,
    alarms: buildAlarms(),
    // Not gated on form.repeat !== 'none' -- an RDATE-only event (extra
    // one-off dates with no RRULE at all) has form.repeat === 'none' too,
    // and gating on it silently dropped those dates on every save. The
    // "Add extra date" control is still repeat-only in the UI, but an
    // existing rdate the form was seeded with must survive an unrelated
    // edit regardless.
    rdate:
      form.rdates.length > 0
        ? form.rdates.map(
            (d) =>
              (form.allDay
                ? DateTime.fromFormat(d, 'yyyy-LL-dd')
                : // Time-of-day, not just the date -- otherwise every extra
                  // occurrence silently starts at midnight instead of the
                  // event's normal start time.
                  DateTime.fromFormat(`${d} ${form.startTime}`, 'yyyy-LL-dd HH:mm', { zone: form.timezone })
              ).toISO() ?? new Date().toISOString(),
          )
        : [],
  }
  emit('save', form.calendarId, fields)
}

const titleInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  titleInput.value?.focus()
})

// Only offer calendars the event could actually be saved to -- a read-only
// calendar would otherwise be pickable here, silently 403ing on submit
// (see requireWritableCalendar server-side). Always keep the event's
// current calendar in the list even if it's since become read-only, so
// switching it away is still possible without losing the selection.
// Ordered per the user's calendar sort setting, matching the sidebar.
const writableCalendars = computed(() =>
  sortCalendars(
    props.calendars.filter((c) => !c.readOnly || c.id === props.event?.calendarId),
    settingsStore.calendarSortOrder,
  ),
)
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <form class="dialog" @submit.prevent="onSubmit" @keydown.esc="emit('close')">
      <input ref="titleInput" v-model="form.summary" class="dialog__title" type="text" placeholder="Add title" required />

      <div class="field-row">
        <label class="field">
          <span>Calendar</span>
          <select v-model="form.calendarId">
            <option v-for="cal in writableCalendars" :key="cal.id" :value="cal.id">{{ cal.displayName }}</option>
          </select>
        </label>
        <label class="field field--color">
          <span>Color</span>
          <div class="color-row">
            <input
              type="color"
              class="color-swatch"
              :value="swatchColor"
              @input="form.color = ($event.target as HTMLInputElement).value"
            />
            <button v-if="form.color" type="button" class="btn btn-ghost color-reset" @click="form.color = ''">
              Use calendar color
            </button>
          </div>
        </label>
      </div>

      <label class="dialog__checkbox">
        <input v-model="form.allDay" type="checkbox" />
        <span>All day</span>
      </label>

      <div class="field-group">
        <span class="field-group__label">Start</span>
        <div class="field-row">
          <input v-model="form.startDate" type="date" required />
          <TimeCombobox v-if="!form.allDay" v-model="form.startTime" />
        </div>
      </div>

      <div class="field-group">
        <span class="field-group__label">End</span>
        <div class="field-row">
          <input v-model="form.endDate" type="date" required />
          <TimeCombobox v-if="!form.allDay" v-model="form.endTime" />
        </div>
      </div>

      <label v-if="!form.allDay" class="field">
        <span>Time zone</span>
        <select v-model="form.timezone">
          <option v-for="tz in TIMEZONES" :key="tz" :value="tz">{{ tz }}</option>
        </select>
      </label>

      <label class="field">
        <span>Repeat</span>
        <select v-model="form.repeat">
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
          <option v-if="form.repeat === 'custom'" value="custom" disabled>Custom (unsupported here)</option>
        </select>
      </label>

      <template v-if="form.repeat !== 'none' && form.repeat !== 'custom'">
        <div class="field-group">
          <span class="field-group__label">Every</span>
          <div class="field-row field-row--tight">
            <input v-model.number="form.repeatInterval" type="number" min="1" max="365" class="repeat-interval" />
            <span class="repeat-unit">{{ intervalUnitLabel }}</span>
          </div>
        </div>

        <div v-if="form.repeat === 'weekly'" class="field-group">
          <span class="field-group__label">On</span>
          <div class="weekday-row">
            <button
              v-for="code in WEEKDAY_CODES"
              :key="code"
              type="button"
              class="weekday-btn"
              :class="{ 'weekday-btn--active': form.repeatWeekdays.includes(code) }"
              @click="toggleWeekday(code)"
            >
              {{ WEEKDAY_BUTTON_LABELS[code] }}
            </button>
          </div>
        </div>

        <div v-if="form.repeat === 'monthly'" class="field-group">
          <span class="field-group__label">On</span>
          <label class="repeat-end-option">
            <input v-model="form.monthlyMode" type="radio" value="dayOfMonth" />
            <span>Day {{ form.startDate ? DateTime.fromFormat(form.startDate, 'yyyy-LL-dd').day : '' }} of the month</span>
          </label>
          <label class="repeat-end-option monthly-weekday-option">
            <input v-model="form.monthlyMode" type="radio" value="weekday" />
            <span>The</span>
            <select v-model.number="form.monthlyOrdinal" :disabled="form.monthlyMode !== 'weekday'">
              <option v-for="ord in MONTHLY_ORDINALS" :key="ord" :value="ord">{{ MONTHLY_ORDINAL_LABELS[ord] }}</option>
            </select>
            <select v-model="form.monthlyWeekday" :disabled="form.monthlyMode !== 'weekday'">
              <option v-for="code in WEEKDAY_CODES" :key="code" :value="code">{{ WEEKDAY_SHORT_NAMES[code] }}</option>
            </select>
          </label>
        </div>

        <div class="field-group">
          <span class="field-group__label">Extra dates</span>
          <div v-for="(date, index) in form.rdates" :key="index" class="reminder-row">
            <input v-model="form.rdates[index]" type="date" />
            <button type="button" class="icon-remove-btn" title="Remove date" @click="removeRdate(index)">×</button>
          </div>
          <button type="button" class="btn btn-ghost reminder-add" @click="addRdate">
            <span class="icon-add-btn" aria-hidden="true">+</span> Add extra date
          </button>
        </div>

        <div class="field-group">
          <span class="field-group__label">Ends</span>
          <label class="repeat-end-option">
            <input v-model="form.repeatEnd" type="radio" value="never" />
            <span>Never</span>
          </label>
          <label class="repeat-end-option">
            <input v-model="form.repeatEnd" type="radio" value="count" />
            <span>After</span>
            <input
              v-model.number="form.repeatCount"
              type="number"
              min="1"
              max="999"
              class="repeat-count"
              :disabled="form.repeatEnd !== 'count'"
            />
            <span>occurrence(s)</span>
          </label>
          <label class="repeat-end-option">
            <input v-model="form.repeatEnd" type="radio" value="until" />
            <span>On</span>
            <input v-model="form.repeatUntil" type="date" :disabled="form.repeatEnd !== 'until'" />
          </label>
        </div>

        <p class="repeat-preview">{{ repeatPreview }}</p>
      </template>
      <p v-else-if="form.repeat === 'custom'" class="repeat-preview">{{ repeatPreview }}</p>

      <div class="field-group">
        <span class="field-group__label">Reminders</span>
        <div v-for="(minutes, index) in form.reminders" :key="index" class="reminder-row">
          <select v-model.number="form.reminders[index]">
            <option v-for="preset in REMINDER_PRESETS" :key="preset.minutes" :value="preset.minutes">
              {{ preset.label }}
            </option>
          </select>
          <button type="button" class="icon-remove-btn" title="Remove reminder" @click="removeReminder(index)">
            ×
          </button>
        </div>
        <button type="button" class="btn btn-ghost reminder-add" @click="addReminder">
          <span class="icon-add-btn" aria-hidden="true">+</span> Add reminder
        </button>
      </div>

      <label class="field">
        <span>Location</span>
        <input v-model="form.location" type="text" placeholder="Optional" />
      </label>

      <label class="field">
        <span>Description</span>
        <textarea v-model="form.description" rows="3" placeholder="Optional" />
      </label>

      <p v-if="validationError" class="dialog__error">{{ validationError }}</p>

      <div class="dialog__actions">
        <button v-if="isEditing" type="button" class="btn btn-ghost" @click="emit('duplicate')">Duplicate</button>
        <button v-if="isEditing" type="button" class="btn btn-danger dialog__delete" @click="emit('remove')">
          Delete
        </button>
        <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn btn-primary" :disabled="!!validationError">Save</button>
      </div>
    </form>
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
  z-index: 30;
  animation: fade-in 0.12s ease;
}
.dialog {
  background: var(--color-surface);
  padding: 1.5rem;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 380px;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  max-height: 90vh;
  overflow-y: auto;
  animation: pop-in 0.14s ease;
}
.dialog__title {
  border: none;
  border-radius: 0;
  border-bottom: 1px solid var(--color-border);
  padding: 0.2rem 0 0.6rem;
  font-size: 1.15rem;
  font-weight: 600;
}
.dialog__title:focus {
  box-shadow: none;
  border-bottom-color: var(--color-primary);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--color-text-muted);
  flex: 1;
  min-width: 0;
}
.field--color {
  flex: 0 0 auto;
}
.color-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.color-swatch {
  -webkit-appearance: none;
  appearance: none;
  width: 1.6rem;
  height: 1.6rem;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: 50%;
  background: none;
  cursor: pointer;
  overflow: hidden;
}
.color-swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}
.color-swatch::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}
.color-swatch::-moz-color-swatch {
  border: none;
  border-radius: 50%;
}
.color-reset {
  font-size: 0.75rem;
  padding: 0.2rem 0.3rem;
  white-space: nowrap;
}
.reminder-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.reminder-row select {
  flex: 1;
}
.reminder-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--color-text-faint);
  padding: 0.2rem 0.3rem;
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.field-group__label {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.field-row {
  display: flex;
  gap: 0.5rem;
}
.field-row input[type='date'] {
  flex: 0 0 auto;
  width: 9.5rem;
}
.field-row--tight {
  align-items: center;
}
.repeat-interval {
  flex: 0 0 auto;
  width: 4rem;
}
.repeat-unit {
  font-size: 0.85rem;
  color: var(--color-text);
}
.repeat-end-option {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--color-text);
  cursor: pointer;
  padding: 0.15rem 0;
}
.repeat-end-option input[type='radio'] {
  width: 14px;
  height: 14px;
}
.repeat-end-option input[type='number'] {
  width: 3.5rem;
  padding: 0.3rem 0.4rem;
}
.repeat-end-option input[type='date'] {
  padding: 0.3rem 0.4rem;
}
.repeat-preview {
  margin: -0.2rem 0 0;
  font-size: 0.78rem;
  color: var(--color-text-faint);
  font-style: italic;
}
.weekday-row {
  display: flex;
  gap: 0.35rem;
}
.weekday-btn {
  width: 2.1rem;
  height: 2.1rem;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease,
    color 0.12s ease;
}
.weekday-btn:hover {
  border-color: var(--color-primary);
}
.weekday-btn--active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}
.dialog__checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--color-text);
  cursor: pointer;
}
.dialog__checkbox input {
  width: 15px;
  height: 15px;
}
input,
select,
textarea {
  padding: 0.5rem 0.6rem;
  font-size: 0.9rem;
}
textarea {
  resize: vertical;
  font-family: inherit;
}
.dialog__actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.35rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--color-border);
}
.dialog__delete {
  margin-right: auto;
}
.dialog__error {
  margin: 0;
  padding: 0.5rem 0.7rem;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
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
