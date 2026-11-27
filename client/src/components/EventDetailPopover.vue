<script setup lang="ts">
import type { CalendarObject } from '@yourdav/shared'
import { DateTime } from 'luxon'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { triggerDownload } from '../lib/download.js'
import { useSettingsStore } from '../stores/settings.js'

const settingsStore = useSettingsStore()

const props = defineProps<{
  event: CalendarObject
  color: string
  calendarName: string
  x: number
  y: number
  readOnly?: boolean
}>()

const emit = defineEmits<{ edit: []; delete: []; duplicate: []; close: [] }>()

const popoverEl = ref<HTMLElement | null>(null)
const style = ref({ top: '0px', left: '0px' })

function computePosition(): void {
  const margin = 12
  const width = popoverEl.value?.offsetWidth ?? 300
  const height = popoverEl.value?.offsetHeight ?? 200
  let left = props.x + margin
  let top = props.y + margin
  if (left + width > window.innerWidth - margin) left = props.x - width - margin
  if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin
  style.value = { top: `${Math.max(margin, top)}px`, left: `${Math.max(margin, left)}px` }
}

function onDocumentMouseDown(event: MouseEvent): void {
  if (popoverEl.value && !popoverEl.value.contains(event.target as Node)) emit('close')
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}
function onScrollOrResize(): void {
  emit('close')
}

onMounted(() => {
  computePosition()
  document.addEventListener('mousedown', onDocumentMouseDown)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
})

const timeRangeText = computed(() => {
  // All-day instants are UTC-midnight-anchored calendar dates with no
  // timezone of their own (see mapper.ts) -- parsing them in the browser's
  // local zone (Luxon's default with no `zone` option) can land on the
  // *previous* calendar day in any negative-offset zone (e.g. an Aug 5
  // event showing as Aug 4 in Los Angeles/New York). Read them back in UTC
  // instead, same fix as EventEditDialog's initialZone.
  const zone = props.event.allDay ? 'utc' : undefined
  const start = DateTime.fromISO(props.event.start, { zone })
  const end = DateTime.fromISO(props.event.end, { zone })

  if (props.event.allDay) {
    // end is CalDAV's exclusive end -- the last inclusive day is end - 1.
    const lastDay = end.minus({ days: 1 })
    return lastDay.hasSame(start, 'day')
      ? start.toFormat(t('datetime.fullDate'))
      : `${start.toFormat(t('datetime.shortDate'))} – ${lastDay.toFormat(t('datetime.shortDate'))}`
  }

  const timeFmt = settingsStore.timeFormat === '24h' ? 'HH:mm' : 'h:mm a'
  const shortDay = t('datetime.shortDay')
  return start.hasSame(end, 'day')
    ? `${start.toFormat(t('datetime.weekdayDay'))} · ${start.toFormat(timeFmt)} – ${end.toFormat(timeFmt)}`
    : `${start.toFormat(`${shortDay}, ${timeFmt}`)} – ${end.toFormat(`${shortDay}, ${timeFmt}`)}`
})

// Only worth calling out when it differs from the viewer's own zone -- the
// times above are always rendered in the browser's local zone regardless,
// so a matching timezone would be redundant noise.
const timezoneNote = computed(() => {
  if (props.event.allDay || !props.event.timezone) return null
  return props.event.timezone !== DateTime.local().zoneName ? props.event.timezone : null
})

function onExport(): void {
  triggerDownload(api.eventExportUrl(props.event.calendarId, props.event.uid, props.event.href))
}

function formatReminder(minutesBefore: number): string {
  if (minutesBefore === 0) return t('reminder.atTime')
  if (minutesBefore % 1440 === 0) return t('reminder.days', minutesBefore / 1440)
  if (minutesBefore % 60 === 0) return t('reminder.hours', minutesBefore / 60)
  return t('reminder.minutes', { n: minutesBefore })
}
</script>

<template>
  <Teleport to="body">
    <div ref="popoverEl" class="popover" :style="style">
      <div class="popover__header">
        <span class="popover__dot" :style="{ backgroundColor: color }" />
        <h3 class="popover__title">{{ event.summary || $t('common.noTitle') }}</h3>
        <button type="button" class="popover__close" :aria-label="$t('common.close')" @click="emit('close')">×</button>
      </div>

      <p class="popover__time">{{ timeRangeText }}</p>
      <p v-if="timezoneNote" class="popover__badge">🌐 {{ timezoneNote }}</p>
      <p v-if="event.isRecurring" class="popover__badge">🔁 {{ $t('popover.recurring') }}</p>
      <p v-for="(alarm, i) in event.alarms" :key="i" class="popover__badge">⏰ {{ formatReminder(alarm.minutesBefore) }}</p>
      <p v-if="event.location" class="popover__row">📍 {{ event.location }}</p>
      <p v-if="event.description" class="popover__description">{{ event.description }}</p>
      <p class="popover__calendar">{{ calendarName }}</p>

      <div class="popover__actions">
        <template v-if="!readOnly">
          <button type="button" class="btn btn-danger popover__delete" @click="emit('delete')">{{ $t('common.delete') }}</button>
        </template>
        <p v-else class="popover__badge popover__readonly">{{ $t('popover.readOnly') }}</p>
        <!-- Subscription hrefs carry a "#uid" fragment (synthetic, not a
        real CalDAV object locator) -- exporting those isn't supported. -->
        <button
          v-if="!event.href.includes('#')"
          type="button"
          class="btn btn-ghost"
          :title="$t('popover.exportTitle')"
          @click="onExport"
        >
          {{ $t('common.export') }}
        </button>
        <button v-if="!readOnly" type="button" class="btn btn-ghost" :title="$t('popover.duplicateTitle')" @click="emit('duplicate')">
          {{ $t('popover.duplicate') }}
        </button>
        <button v-if="!readOnly" type="button" class="btn btn-primary" @click="emit('edit')">{{ $t('common.edit') }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.popover {
  position: fixed;
  z-index: 1000;
  width: 300px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  animation: pop-in 0.12s ease;
}
.popover__header {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.popover__dot {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  margin-top: 0.4rem;
  flex-shrink: 0;
}
.popover__title {
  flex: 1;
  font-size: 1rem;
  margin: 0;
  word-break: break-word;
}
.popover__close {
  border: none;
  background: none;
  color: var(--color-text-faint);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.15rem;
}
.popover__close:hover {
  color: var(--color-text);
}
.popover__time {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-text);
}
.popover__badge {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-text-muted);
}
.popover__row {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-text);
}
.popover__description {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  max-height: 6rem;
  overflow-y: auto;
}
.popover__calendar {
  margin: 0.2rem 0 0;
  font-size: 0.75rem;
  color: var(--color-text-faint);
}
.popover__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.3rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--color-border);
}
.popover__delete,
.popover__readonly {
  margin-right: auto;
}
@keyframes pop-in {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(4px);
  }
}
</style>
