<script setup lang="ts">
import type { Calendar } from '@yourdav/shared'
import { computed, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'
import { useCalendarsStore } from '../stores/calendars.js'

const calendarsStore = useCalendarsStore()

// Sentinel <select> value: create a calendar from the file's X-WR-CALNAME
// (or its filename) instead of importing into an existing one.
const NEW_CALENDAR = ''

function calendarNameFromIcs(ics: string, fallback: string): string {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '')
  const match = /^X-WR-CALNAME(?:;[^:\r\n]*)?:(.*)$/im.exec(unfolded)
  const name = match?.[1]
    ?.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c))
    .trim()
  return name || fallback
}

const props = defineProps<{
  calendars: Calendar[]
  defaultCalendarId: string
}>()

const emit = defineEmits<{ imported: []; close: [] }>()

// A read-only calendar would 403 on every event in the file with no useful
// error surfaced (see importIcs's partial-failure handling) -- don't offer
// it as an import target at all.
const writableCalendars = computed(() => props.calendars.filter((c) => !c.readOnly))

const calendarId = ref(props.defaultCalendarId)
const file = ref<File | null>(null)
const submitting = ref(false)
const error = ref<string | null>(null)
const resultText = ref<string | null>(null)

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
}

async function onSubmit(): Promise<void> {
  if (!file.value) return
  error.value = null
  resultText.value = null
  submitting.value = true
  try {
    const ics = await file.value.text()
    let targetId = calendarId.value
    if (targetId === NEW_CALENDAR) {
      const fallback = file.value.name.replace(/\.[^.]+$/, '') || 'Imported calendar'
      const created = await calendarsStore.create(calendarNameFromIcs(ics, fallback))
      targetId = created.id
      // Retarget so a second click imports into this calendar rather than
      // creating a duplicate.
      calendarId.value = targetId
    }
    const result = await api.importIcs(targetId, ics)
    resultText.value = `Imported ${result.imported} of ${result.total} event${result.total === 1 ? '' : 's'}.`
    emit('imported')
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Failed to import file.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <form class="dialog" @submit.prevent="onSubmit">
      <h2>Import events</h2>
      <p class="dialog__hint">Import events from an .ics file into a calendar.</p>

      <label class="field">
        <span>Calendar</span>
        <select v-model="calendarId">
          <option :value="NEW_CALENDAR">New calendar (named from file)</option>
          <option v-for="cal in writableCalendars" :key="cal.id" :value="cal.id">{{ cal.displayName }}</option>
        </select>
      </label>

      <label class="field">
        <span>File</span>
        <input type="file" accept=".ics,text/calendar" required @change="onFileChange" />
      </label>

      <p v-if="error" class="dialog__error">{{ error }}</p>
      <p v-if="resultText" class="dialog__success">{{ resultText }}</p>

      <div class="dialog__actions">
        <button type="button" class="btn btn-ghost" @click="emit('close')">Close</button>
        <button type="submit" class="btn btn-primary" :disabled="!file || submitting">
          {{ submitting ? 'Importing…' : 'Import' }}
        </button>
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
  width: 340px;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  animation: pop-in 0.14s ease;
}
.dialog h2 {
  font-size: 1.05rem;
}
.dialog__hint {
  margin: -0.4rem 0 0;
  color: var(--color-text-muted);
  font-size: 0.82rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
input,
select {
  padding: 0.5rem 0.6rem;
  font-size: 0.9rem;
}
.dialog__error {
  margin: 0;
  padding: 0.5rem 0.7rem;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
}
.dialog__success {
  margin: 0;
  padding: 0.5rem 0.7rem;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
}
.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.35rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--color-border);
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
