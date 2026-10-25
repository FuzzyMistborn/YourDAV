<script setup lang="ts">
import type { Calendar } from '@yourdav/shared'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'
import { triggerDownload } from '../lib/download.js'
import { useCalendarsStore } from '../stores/calendars.js'

defineProps<{ cal: Calendar }>()
const emit = defineEmits<{ share: [id: string, name: string]; rename: [id: string, name: string, color: string, shared: boolean] }>()

const store = useCalendarsStore()
const menuOpen = ref(false)

function onColorInput(id: string, event: Event): void {
  const input = event.target as HTMLInputElement
  store.setColorOverride(id, input.value)
}

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
}
function closeMenu(): void {
  menuOpen.value = false
}
function onDocumentMouseDown(event: MouseEvent): void {
  if (!(event.target as HTMLElement)?.closest?.('.calendar-list__menu-wrap')) closeMenu()
}
onMounted(() => document.addEventListener('mousedown', onDocumentMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentMouseDown))

function onExportClick(cal: Calendar): void {
  closeMenu()
  triggerDownload(api.calendarExportUrl(cal.id))
}

function onRenameClick(cal: Calendar): void {
  closeMenu()
  emit('rename', cal.id, cal.displayName, cal.color, cal.isShared)
}

function onShareClick(cal: Calendar): void {
  closeMenu()
  emit('share', cal.id, cal.displayName)
}

// Both actions can genuinely fail server-side (e.g. the DAV server
// rejects the delete, or Radicale's hide fails for the unsubscribe path)
// -- surfacing that is more important than it looks here, since a silent
// failure leaves the calendar exactly where it was with no indication
// anything went wrong. No dedicated error-banner UI exists at this list-
// item scope (unlike ShareCalendarDialog's inline error text), so this
// uses a plain alert(), matching the confirm()-based style already used
// for these same two actions below.
async function onDeleteClick(cal: Calendar): Promise<void> {
  closeMenu()
  if (!confirm(`Delete "${cal.displayName}"? This removes it for everyone it's shared with.`)) return
  try {
    await store.deleteCalendar(cal.id)
  } catch (err) {
    alert(err instanceof ApiRequestError ? err.message : `Failed to delete "${cal.displayName}".`)
  }
}

async function onUnsubscribeClick(cal: Calendar): Promise<void> {
  closeMenu()
  if (!confirm(`Stop showing "${cal.displayName}"? The owner keeps their calendar; you can be re-invited later.`)) return
  try {
    await store.unsubscribeCalendar(cal.id)
  } catch (err) {
    alert(err instanceof ApiRequestError ? err.message : `Failed to unsubscribe from "${cal.displayName}".`)
  }
}

function onResetColorClick(id: string): void {
  closeMenu()
  store.resetColorOverride(id)
}
</script>

<template>
  <li class="calendar-list__item">
    <label class="calendar-list__toggle">
      <input type="checkbox" :checked="store.enabled[cal.id]" @change="store.toggle(cal.id)" />
      <span class="calendar-list__name" :title="cal.displayName">{{ cal.displayName }}</span>
    </label>
    <input
      type="color"
      class="calendar-list__swatch"
      :value="store.colorFor(cal.id)"
      :title="`Color for ${cal.displayName}`"
      @input="onColorInput(cal.id, $event)"
    />

    <!-- Overflow menu rather than inline buttons (unlike SubscriptionList/
         PendingSharesList/ShareCalendarDialog's share rows, which show
         their 1-2 actions inline) -- this item alone has up to 5 actions
         (rename/share/export/reset color/delete-or-unsubscribe), too many
         to fit inline without crowding the row. -->
    <div class="calendar-list__menu-wrap">
      <button type="button" class="calendar-list__menu-btn" title="More options" @click="toggleMenu">⋯</button>
      <ul v-if="menuOpen" class="calendar-list__menu">
        <li>
          <button type="button" @click="onRenameClick(cal)">✎ Rename</button>
        </li>
        <li v-if="!cal.isShared">
          <button type="button" @click="onShareClick(cal)">↗ Share</button>
        </li>
        <li>
          <button type="button" @click="onExportClick(cal)">⬇ Export .ics</button>
        </li>
        <li v-if="cal.id in store.colorOverrides">
          <button type="button" @click="onResetColorClick(cal.id)">↺ Reset color</button>
        </li>
        <li v-if="!cal.isShared">
          <button type="button" class="calendar-list__menu-danger" @click="onDeleteClick(cal)">✕ Delete</button>
        </li>
        <li v-if="cal.isShared">
          <button type="button" class="calendar-list__menu-danger" @click="onUnsubscribeClick(cal)">✕ Unsubscribe</button>
        </li>
      </ul>
    </div>
  </li>
</template>

<style scoped>
.calendar-list__item {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.5rem;
  border-radius: var(--radius-sm);
  transition: background-color 0.12s ease;
}
.calendar-list__item:hover {
  background: var(--color-surface-hover);
}
.calendar-list__toggle {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex: 1;
  min-width: 0;
  padding: 0.2rem 0;
  cursor: pointer;
}
input[type='checkbox'] {
  width: 15px;
  height: 15px;
  margin: 0;
  cursor: pointer;
}
.calendar-list__name {
  font-size: 0.88rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.calendar-list__menu-wrap {
  position: relative;
  flex-shrink: 0;
}
.calendar-list__menu-btn {
  padding: 0.1rem 0.35rem;
  border: none;
  background: none;
  color: var(--color-text-faint);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.calendar-list__menu-btn:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}
.calendar-list__menu {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 25;
  margin: 0;
  padding: 0.3rem;
  list-style: none;
  min-width: 9.5rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  animation: pop-in 0.1s ease;
}
.calendar-list__menu button {
  display: block;
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: none;
  background: none;
  color: var(--color-text);
  font-size: 0.82rem;
  text-align: left;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.calendar-list__menu button:hover {
  background: var(--color-surface-hover);
}
.calendar-list__menu-danger {
  color: var(--color-danger);
}
@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
}
</style>
