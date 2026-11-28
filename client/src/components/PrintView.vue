<script setup lang="ts">
import { computed } from 'vue'
import { DateTime } from 'luxon'
import { currentLocale } from '../i18n.js'
import { useSettingsStore } from '../stores/settings.js'

const settingsStore = useSettingsStore()

export interface PrintEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  color: string
}

const props = defineProps<{
  mode: 'month' | 'week' | 'day' | 'agenda' | 'year'
  anchor: string
  rangeStart: string
  rangeEnd: string
  title: string
  weekStart: number
  events: PrintEvent[]
}>()

const anchorDt = computed(() => DateTime.fromISO(props.anchor))

// Sun=0 .. Sat=6 for a Luxon DateTime (Luxon's own `weekday` is Mon=1..Sun=7).
function dowSun0(dt: DateTime): number {
  return dt.weekday % 7
}

function startOfWeek(dt: DateTime): DateTime {
  const offset = (dowSun0(dt) - props.weekStart + 7) % 7
  return dt.startOf('day').minus({ days: offset })
}

const weekdayNames = computed(() => {
  void currentLocale() // re-derive the names when the language changes
  const ref = startOfWeek(DateTime.fromObject({ year: 2024, month: 1, day: 7 })) // a Sunday
  return Array.from({ length: 7 }, (_, i) => ref.plus({ days: i }).toFormat('ccc'))
})

interface Day {
  date: DateTime
  inMonth: boolean
  isToday: boolean
  events: PrintEvent[]
}

const today = DateTime.now().startOf('day')

function eventsOnDay(day: DateTime): PrintEvent[] {
  const d = day.startOf('day')
  return props.events
    .filter((e) => {
      const s = DateTime.fromISO(e.start).startOf('day')
      // All-day DTEND is exclusive; step back a day for an inclusive comparison.
      const end = (e.allDay ? DateTime.fromISO(e.end).minus({ days: 1 }) : DateTime.fromISO(e.end)).startOf('day')
      return d >= s && d <= (end < s ? s : end)
    })
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
      return a.start.localeCompare(b.start)
    })
}

function monthMatrix(monthAnchor: DateTime): Day[][] {
  const first = monthAnchor.startOf('month')
  const gridStart = startOfWeek(first)
  const weeks: Day[][] = []
  for (let w = 0; w < 6; w++) {
    const row: Day[] = []
    for (let d = 0; d < 7; d++) {
      const date = gridStart.plus({ days: w * 7 + d })
      row.push({
        date,
        inMonth: date.month === first.month,
        isToday: date.hasSame(today, 'day'),
        events: eventsOnDay(date),
      })
    }
    weeks.push(row)
    // Stop after we've covered the month (avoid a trailing all-out-of-month row).
    if (row[6].date >= first.endOf('month') && w >= 3) break
  }
  return weeks
}

const monthsToRender = computed<DateTime[]>(() => {
  if (props.mode === 'year') {
    const jan = anchorDt.value.startOf('year')
    return Array.from({ length: 12 }, (_, i) => jan.plus({ months: i }))
  }
  return [anchorDt.value]
})

const weekDays = computed<Day[]>(() => {
  const start = startOfWeek(anchorDt.value)
  return Array.from({ length: 7 }, (_, i) => {
    const date = start.plus({ days: i })
    return { date, inMonth: true, isToday: date.hasSame(today, 'day'), events: eventsOnDay(date) }
  })
})

const singleDay = computed<Day>(() => ({
  date: anchorDt.value.startOf('day'),
  inMonth: true,
  isToday: anchorDt.value.hasSame(today, 'day'),
  events: eventsOnDay(anchorDt.value),
}))

const agendaGroups = computed<{ date: DateTime; events: PrintEvent[] }[]>(() => {
  const start = DateTime.fromISO(props.rangeStart).startOf('day')
  const end = DateTime.fromISO(props.rangeEnd).startOf('day')
  const byDay = new Map<string, PrintEvent[]>()
  for (const e of props.events) {
    let cursor = DateTime.fromISO(e.start).startOf('day')
    const last = (e.allDay ? DateTime.fromISO(e.end).minus({ days: 1 }) : DateTime.fromISO(e.end)).startOf('day')
    for (let i = 0; i < 60 && cursor <= (last < cursor ? cursor : last); i++, cursor = cursor.plus({ days: 1 })) {
      if (cursor < start || cursor >= end) continue
      const key = cursor.toISODate() ?? ''
      const list = byDay.get(key) ?? []
      list.push(e)
      byDay.set(key, list)
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, events]) => ({
      date: DateTime.fromISO(key),
      events: events.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
        return a.start.localeCompare(b.start)
      }),
    }))
})

function timeLabel(e: PrintEvent): string {
  if (e.allDay) return ''
  const timeFmt = settingsStore.timeFormat === '24h' ? 'HH:mm' : 'h:mm a'
  return DateTime.fromISO(e.start).toFormat(timeFmt)
}
</script>

<template>
  <div class="print-view" :class="`print-view--${mode}`">
    <h1 class="print-view__title">{{ title }}</h1>

    <!-- Month / Year: one CSS-grid calendar per month -->
    <template v-if="mode === 'month' || mode === 'year'">
      <section v-for="m in monthsToRender" :key="m.toMillis()" class="pv-month">
        <h2 v-if="mode === 'year'" class="pv-month__name">{{ m.toFormat('LLLL') }}</h2>
        <div class="pv-grid">
          <div v-for="name in weekdayNames" :key="name" class="pv-grid__head">{{ name }}</div>
          <template v-for="(week, wi) in monthMatrix(m)" :key="wi">
            <div
              v-for="day in week"
              :key="day.date.toMillis()"
              class="pv-cell"
              :class="{ 'pv-cell--out': !day.inMonth, 'pv-cell--today': day.isToday }"
            >
              <div class="pv-cell__num">{{ day.date.day }}</div>
              <ul class="pv-cell__events">
                <li v-for="e in day.events" :key="e.id" class="pv-ev">
                  <span class="pv-ev__dot" :style="{ background: e.color }" aria-hidden="true" />
                  <span v-if="timeLabel(e)" class="pv-ev__time">{{ timeLabel(e) }}</span>
                  <span class="pv-ev__title">{{ e.title || $t('common.noTitle') }}</span>
                </li>
              </ul>
            </div>
          </template>
        </div>
      </section>
    </template>

    <!-- Week / Day: day columns as stacked lists -->
    <div v-else-if="mode === 'week' || mode === 'day'" class="pv-cols" :class="{ 'pv-cols--one': mode === 'day' }">
      <section v-for="day in mode === 'week' ? weekDays : [singleDay]" :key="day.date.toMillis()" class="pv-col">
        <h2 class="pv-col__head" :class="{ 'pv-col__head--today': day.isToday }">
          {{ day.date.toFormat('ccc d LLL') }}
        </h2>
        <ul class="pv-col__events">
          <li v-if="day.events.length === 0" class="pv-col__empty">—</li>
          <li v-for="e in day.events" :key="e.id" class="pv-ev pv-ev--row">
            <span class="pv-ev__dot" :style="{ background: e.color }" aria-hidden="true" />
            <span class="pv-ev__time">{{ e.allDay ? $t('common.allDay') : timeLabel(e) }}</span>
            <span class="pv-ev__title">{{ e.title || $t('common.noTitle') }}</span>
          </li>
        </ul>
      </section>
    </div>

    <!-- Agenda: flat date-grouped list -->
    <div v-else class="pv-agenda">
      <p v-if="agendaGroups.length === 0" class="pv-agenda__empty">{{ $t('common.noEventsInRange') }}</p>
      <section v-for="group in agendaGroups" :key="group.date.toMillis()" class="pv-agenda__group">
        <h2 class="pv-agenda__date">{{ group.date.toFormat($t('datetime.weekdayDay')) }}</h2>
        <ul class="pv-agenda__events">
          <li v-for="e in group.events" :key="e.id" class="pv-ev pv-ev--row">
            <span class="pv-ev__dot" :style="{ background: e.color }" aria-hidden="true" />
            <span class="pv-ev__time">{{ e.allDay ? $t('common.allDay') : timeLabel(e) }}</span>
            <span class="pv-ev__title">{{ e.title || $t('common.noTitle') }}</span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.print-view {
  color: #000;
  background: #fff;
  font-size: 10pt;
  line-height: 1.3;
}
.print-view__title {
  font-size: 15pt;
  margin: 0 0 0.4cm;
}

/* --- Month / Year grid --- */
.pv-month {
  margin-bottom: 0.5cm;
}
/* A single month grid can legitimately be taller than one page when a day
   is very busy -- let it break rather than overflow. The 12 small grids in
   Year mode should each stay whole. */
.print-view--year .pv-month {
  break-inside: avoid;
}
.pv-month__name {
  font-size: 12pt;
  margin: 0.3cm 0 0.15cm;
}
.pv-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}
/* Every cell carries its right + bottom edge; the first column and the
   header row add the remaining two edges, so the outer frame is drawn by
   the cells themselves (a border on the grid container gets dropped at the
   page-margin edge by some print engines). */
.pv-grid > :nth-child(7n + 1) {
  border-left: 1px solid #000;
}
.pv-grid__head {
  border-top: 1px solid #000;
  border-right: 1px solid #000;
  border-bottom: 1px solid #000;
  padding: 2px 4px;
  font-weight: 700;
  font-size: 8pt;
  text-transform: uppercase;
  background: #eee;
}
.pv-cell {
  border-right: 1px solid #000;
  border-bottom: 1px solid #000;
  min-height: 1.8cm;
  padding: 2px 3px;
}
.print-view--year .pv-cell {
  min-height: 1.2cm;
}
.pv-cell--out {
  background: #f4f4f4;
  color: #999;
}
.pv-cell--today .pv-cell__num {
  background: #000;
  color: #fff;
  border-radius: 50%;
  display: inline-block;
  min-width: 1.3em;
  text-align: center;
}
.pv-cell__num {
  font-size: 8pt;
  font-weight: 700;
}
.pv-cell__events {
  list-style: none;
  margin: 1px 0 0;
  padding: 0;
}
.print-view--year .pv-cell__events {
  display: none;
}
.pv-ev {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-size: 8pt;
  page-break-inside: avoid;
}
.pv-ev--row {
  font-size: 10pt;
  padding: 1px 0;
}
.pv-ev__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
  align-self: center;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.pv-ev__time {
  color: #444;
  white-space: nowrap;
}
.pv-ev__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-ev--row .pv-ev__title {
  white-space: normal;
}

/* --- Week / Day columns --- */
.pv-cols {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0;
}
.pv-cols--one {
  grid-template-columns: 1fr;
}
.pv-cols > :first-child {
  border-left: 1px solid #000;
}
.pv-col {
  border-top: 1px solid #000;
  border-right: 1px solid #000;
  border-bottom: 1px solid #000;
  padding: 3px 5px;
  break-inside: avoid;
}
.pv-col__head {
  font-size: 9pt;
  margin: 0 0 3px;
  border-bottom: 1px solid #999;
  padding-bottom: 2px;
}
.pv-col__head--today {
  background: #000;
  color: #fff;
  padding: 2px 4px;
}
.pv-col__events,
.pv-agenda__events {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pv-col__empty {
  color: #999;
}

/* --- Agenda --- */
.pv-agenda__group {
  break-inside: avoid;
  margin-bottom: 0.35cm;
}
.pv-agenda__date {
  font-size: 11pt;
  margin: 0 0 0.1cm;
  border-bottom: 1px solid #000;
}
.pv-agenda__empty {
  color: #666;
}
</style>
