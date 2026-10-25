<script setup lang="ts">
import type { Calendar } from '@yourdav/shared'
import { computed, nextTick, ref } from 'vue'
import { useCalendarsStore } from '../stores/calendars.js'
import { useSettingsStore } from '../stores/settings.js'
import CalendarListItem from './CalendarListItem.vue'
import PendingSharesList from './PendingSharesList.vue'
import RenameCalendarDialog from './RenameCalendarDialog.vue'
import ShareCalendarDialog from './ShareCalendarDialog.vue'

const store = useCalendarsStore()
const settingsStore = useSettingsStore()

function sorted(calendars: Calendar[]): Calendar[] {
  switch (settingsStore.calendarSortOrder) {
    case 'name-asc':
      return [...calendars].sort((a, b) => a.displayName.localeCompare(b.displayName))
    case 'name-desc':
      return [...calendars].sort((a, b) => b.displayName.localeCompare(a.displayName))
    case 'server':
    default:
      return calendars
  }
}

const ownCalendars = computed(() => sorted(store.calendars.filter((c) => !c.isShared)))
const sharedCalendars = computed(() => sorted(store.calendars.filter((c) => c.isShared)))

const sharingCalendar = ref<{ id: string; name: string } | null>(null)
function onShareClick(id: string, name: string): void {
  sharingCalendar.value = { id, name }
}

const renamingCalendar = ref<{ id: string; name: string; color: string; shared: boolean } | null>(null)
function onRenameClick(id: string, name: string, color: string, shared: boolean): void {
  renamingCalendar.value = { id, name, color, shared }
}

const showNewForm = ref(false)
const newName = ref('')
const newColor = ref('#0082c9')
const creating = ref(false)
const createError = ref<string | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

function toggleNewForm(): void {
  showNewForm.value = !showNewForm.value
  if (showNewForm.value) {
    newName.value = ''
    newColor.value = '#0082c9'
    createError.value = null
    // The bare `autofocus` attribute is only honored on initial page load,
    // not when v-if re-inserts the form -- focus it explicitly.
    void nextTick(() => nameInput.value?.focus())
  }
}

function closeNewForm(): void {
  showNewForm.value = false
}

async function submitNewCalendar(): Promise<void> {
  if (!newName.value.trim()) return
  creating.value = true
  createError.value = null
  try {
    await store.create(newName.value.trim(), newColor.value)
    showNewForm.value = false
  } catch (err) {
    createError.value = err instanceof Error ? err.message : 'Failed to create calendar'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="calendar-list">
    <PendingSharesList />

    <div class="calendar-list__header">
      <h2 class="calendar-list__heading">Calendars</h2>
      <button type="button" class="icon-add-btn" title="New calendar" @click="toggleNewForm">+</button>
    </div>

    <form
      v-if="showNewForm"
      class="calendar-list__new-form"
      @submit.prevent="submitNewCalendar"
      @keydown.esc="closeNewForm"
    >
      <input
        ref="nameInput"
        v-model="newName"
        type="text"
        placeholder="Calendar name"
        class="calendar-list__new-input"
        autofocus
      />
      <div class="calendar-list__new-row">
        <input v-model="newColor" type="color" class="calendar-list__swatch" title="Color" />
        <button type="button" class="btn btn-ghost" @click="closeNewForm">Cancel</button>
        <button type="submit" class="btn btn-primary" :disabled="creating || !newName.trim()">
          {{ creating ? 'Creating…' : 'Create' }}
        </button>
      </div>
      <p v-if="createError" class="calendar-list__new-error">{{ createError }}</p>
    </form>

    <ul>
      <CalendarListItem
        v-for="cal in ownCalendars"
        :key="cal.id"
        :cal="cal"
        @share="onShareClick"
        @rename="onRenameClick"
      />
      <li v-if="!store.loading && store.calendars.length === 0" class="calendar-list__empty">
        No calendars found.
      </li>
    </ul>

    <template v-if="sharedCalendars.length > 0">
      <h2 class="calendar-list__heading calendar-list__heading--shared">Shared with me</h2>
      <ul>
        <CalendarListItem v-for="cal in sharedCalendars" :key="cal.id" :cal="cal" @share="onShareClick" @rename="onRenameClick" />
      </ul>
    </template>

    <ShareCalendarDialog
      v-if="sharingCalendar"
      :calendar-id="sharingCalendar.id"
      :calendar-name="sharingCalendar.name"
      @close="sharingCalendar = null"
    />
    <RenameCalendarDialog
      v-if="renamingCalendar"
      :calendar-id="renamingCalendar.id"
      :calendar-name="renamingCalendar.name"
      :calendar-color="renamingCalendar.color"
      :shared="renamingCalendar.shared"
      @close="renamingCalendar = null"
    />
  </div>
</template>

<style scoped>
.calendar-list__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}
.calendar-list__heading {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-faint);
  margin: 0;
}
.calendar-list__heading--shared {
  margin-top: 0.9rem;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.calendar-list__empty {
  padding: 0.4rem 0.5rem;
  color: var(--color-text-faint);
  font-size: 0.85rem;
}
.calendar-list__swatch {
  -webkit-appearance: none;
  appearance: none;
  width: 1.1rem;
  height: 1.1rem;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: 50%;
  background: none;
  cursor: pointer;
  overflow: hidden;
}
.calendar-list__swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}
.calendar-list__swatch::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}
.calendar-list__swatch::-moz-color-swatch {
  border: none;
  border-radius: 50%;
}
.calendar-list__new-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem;
  margin-bottom: 0.4rem;
  background: var(--color-surface-hover);
  border-radius: var(--radius-sm);
}
.calendar-list__new-input {
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  background: var(--color-surface);
  color: inherit;
  box-sizing: border-box;
}
.calendar-list__new-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.calendar-list__new-row .btn {
  padding: 0.3rem 0.6rem;
  font-size: 0.78rem;
}
.calendar-list__new-error {
  flex-basis: 100%;
  margin: 0.2rem 0 0;
  font-size: 0.8rem;
  color: var(--color-danger);
}
</style>
