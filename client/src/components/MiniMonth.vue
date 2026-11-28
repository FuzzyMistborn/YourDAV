<script setup lang="ts">
import { DateTime } from 'luxon'
import { computed, ref, watch } from 'vue'
import { weekdayName } from '../i18n.js'

const props = defineProps<{
  // 0 = Sunday .. 6 = Saturday, matching FullCalendar's firstDay.
  firstDay: number
  // The month the main calendar is currently showing; the navigator
  // follows it unless the user has paged the navigator elsewhere.
  focusDate: string | null
}>()

const emit = defineEmits<{ navigate: [date: Date] }>()

const today = DateTime.now().startOf('day')

// The month the grid is displaying. Seeded from focusDate and re-synced
// whenever focusDate lands in a different month than what's shown.
const viewMonth = ref<DateTime>((props.focusDate ? DateTime.fromISO(props.focusDate) : today).startOf('month'))

watch(
  () => props.focusDate,
  (iso) => {
    if (!iso) return
    const m = DateTime.fromISO(iso).startOf('month')
    if (m.isValid && !m.equals(viewMonth.value)) viewMonth.value = m
  },
)

const weekdayLabels = computed(() => {
  // Luxon weekdays are 1=Mon..7=Sun; FullCalendar firstDay is 0=Sun..6=Sat.
  // 2023-01-01 was a Sunday; the first two letters of the short weekday name
  // in the active language ("Su"/"Mo", "Di"/"Lu").
  const names = Array.from({ length: 7 }, (_, i) => {
    const name = weekdayName(i)
    return name.charAt(0).toLocaleUpperCase() + name.charAt(1)
  })
  return Array.from({ length: 7 }, (_, i) => names[(props.firstDay + i) % 7])
})

const weeks = computed(() => {
  const first = viewMonth.value
  // luxon weekday: 1=Mon..7=Sun. Offset back to the configured first day.
  const firstWeekday = first.weekday % 7 // 0=Sun..6=Sat
  const lead = (firstWeekday - props.firstDay + 7) % 7
  const gridStart = first.minus({ days: lead })
  const cells: DateTime[] = Array.from({ length: 42 }, (_, i) => gridStart.plus({ days: i }))
  const rows: DateTime[][] = []
  for (let i = 0; i < 42; i += 7) rows.push(cells.slice(i, i + 7))
  // Keep only rows that actually contain a day of this month. A month
  // always spans at least 4 rows, so those are safe to keep unconditionally;
  // rows 5 and 6 render only when the month really reaches into them.
  return rows.filter((row, i) => i < 4 || row.some((d) => d.month === first.month))
})

function shift(delta: number): void {
  viewMonth.value = viewMonth.value.plus({ months: delta })
}

function pick(day: DateTime): void {
  emit('navigate', day.toJSDate())
}
</script>

<template>
  <div class="mini">
    <div class="mini__header">
      <button type="button" class="mini__nav" :aria-label="$t('miniMonth.previous')" @click="shift(-1)">‹</button>
      <span class="mini__title">{{ viewMonth.toFormat('LLLL yyyy') }}</span>
      <button type="button" class="mini__nav" :aria-label="$t('miniMonth.next')" @click="shift(1)">›</button>
    </div>
    <div class="mini__grid">
      <span v-for="label in weekdayLabels" :key="label" class="mini__weekday">{{ label }}</span>
      <template v-for="(week, wi) in weeks" :key="wi">
        <button
          v-for="day in week"
          :key="day.toISODate() ?? ''"
          type="button"
          class="mini__day"
          :class="{
            'mini__day--muted': day.month !== viewMonth.month,
            'mini__day--today': day.hasSame(today, 'day'),
          }"
          @click="pick(day)"
        >
          {{ day.day }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mini {
  font-size: 0.75rem;
}
.mini__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
  padding: 0 0.15rem;
}
.mini__title {
  font-weight: 600;
  color: var(--color-text);
}
.mini__nav {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0.1rem 0.35rem;
  border-radius: var(--radius-sm);
}
.mini__nav:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}
.mini__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}
.mini__weekday {
  text-align: center;
  color: var(--color-text-faint);
  font-weight: 500;
  padding: 0.2rem 0;
}
.mini__day {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 0.72rem;
  cursor: pointer;
}
.mini__day:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.mini__day--muted {
  color: var(--color-text-faint);
  opacity: 0.6;
}
.mini__day--today {
  background: var(--color-primary);
  color: #fff;
  font-weight: 600;
}
</style>
