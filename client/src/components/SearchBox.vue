<script setup lang="ts">
import type { CalendarObject } from '@yourdav/shared'
import { DateTime } from 'luxon'
import { ref } from 'vue'
import { api } from '../api.js'
import { t } from '../i18n.js'

const emit = defineEmits<{ select: [event: CalendarObject] }>()

const query = ref('')
const results = ref<CalendarObject[]>([])
const open = ref(false)
const loading = ref(false)
let debounceHandle: ReturnType<typeof setTimeout> | null = null
// Guards against an older, slower request's response landing after a
// newer one's and clobbering fresher results.
let requestSeq = 0

function formatWhen(event: CalendarObject): string {
  // Same all-day/UTC-vs-local-zone fix as EventDetailPopover's timeRangeText.
  const dt = DateTime.fromISO(event.start, { zone: event.allDay ? 'utc' : undefined })
  return dt.toFormat(t(event.allDay ? 'datetime.shortDate' : 'datetime.shortDateTime'))
}

async function runSearch(): Promise<void> {
  const q = query.value.trim()
  if (q.length < 2) {
    results.value = []
    open.value = false
    return
  }
  loading.value = true
  const seq = ++requestSeq
  try {
    const response = await api.search(q)
    if (seq !== requestSeq) return // a newer search superseded this one
    results.value = response
    open.value = true
  } catch {
    if (seq !== requestSeq) return
    results.value = []
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function onInput(): void {
  if (debounceHandle) clearTimeout(debounceHandle)
  debounceHandle = setTimeout(runSearch, 300)
}

function onSelect(event: CalendarObject): void {
  emit('select', event)
  open.value = false
  query.value = ''
  results.value = []
}

function onBlur(): void {
  // Delay so a click on a result registers before the list closes.
  setTimeout(() => (open.value = false), 150)
}
</script>

<template>
  <div class="search-box">
    <input
      v-model="query"
      type="search"
      :placeholder="$t('search.placeholder')"
      class="search-box__input"
      @input="onInput"
      @focus="results.length > 0 && (open = true)"
      @blur="onBlur"
    />
    <ul v-if="open" class="search-box__results">
      <li v-if="loading" class="search-box__empty">{{ $t('search.searching') }}</li>
      <li v-else-if="results.length === 0" class="search-box__empty">{{ $t('search.noMatches') }}</li>
      <li v-for="event in results" :key="`${event.calendarId}:${event.uid}:${event.recurrenceId ?? ''}`">
        <button type="button" class="search-box__result" @mousedown.prevent="onSelect(event)">
          <span class="search-box__result-title">{{ event.summary || $t('common.noTitle') }}</span>
          <span class="search-box__result-when">{{ formatWhen(event) }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search-box {
  position: relative;
}
.search-box__input {
  width: 100%;
  padding: 0.45rem 0.6rem;
  font-size: 0.85rem;
}
.search-box__results {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 16rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}
.search-box__empty {
  padding: 0.5rem 0.6rem;
  font-size: 0.82rem;
  color: var(--color-text-faint);
}
.search-box__result {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 0.1rem;
  padding: 0.4rem 0.6rem;
  border: none;
  background: none;
  border-radius: 4px;
  text-align: left;
  cursor: pointer;
}
.search-box__result:hover {
  background: var(--color-surface-hover);
}
.search-box__result-title {
  font-size: 0.85rem;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-box__result-when {
  font-size: 0.75rem;
  color: var(--color-text-faint);
}
</style>
