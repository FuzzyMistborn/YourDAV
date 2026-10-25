<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { api } from '../api.js'
import { useSubscriptionsStore } from '../stores/subscriptions.js'
import ConfirmDialog from './ConfirmDialog.vue'

const store = useSubscriptionsStore()

const adding = ref(false)
const newName = ref('')
const newUrl = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

function toggleAdd(): void {
  adding.value = !adding.value
  // The bare `autofocus`/HTML default isn't honored on v-if re-insertion.
  if (adding.value) void nextTick(() => nameInput.value?.focus())
}

function onColorInput(id: string, event: Event): void {
  store.setColor(id, (event.target as HTMLInputElement).value)
}

function submitAdd(): void {
  if (!newName.value.trim() || !newUrl.value.trim()) return
  store.add(newName.value.trim(), newUrl.value.trim())
  newName.value = ''
  newUrl.value = ''
  adding.value = false
}

// Built-in holiday calendars are ordinary subscriptions whose URL is
// `holidays:<country code>`; the server generates their events locally.
const addingHolidays = ref(false)
const countries = ref<{ code: string; name: string }[]>([])
const countriesError = ref(false)
const selectedCountry = ref('')
const includeObservances = ref(false)

const addedCountryCodes = computed(
  () => new Set(
    store.subscriptions.filter((s) => s.url.startsWith('holidays:')).map((s) => s.url.slice('holidays:'.length).split('?')[0]),
  ),
)

async function toggleHolidays(): Promise<void> {
  addingHolidays.value = !addingHolidays.value
  if (addingHolidays.value && countries.value.length === 0) {
    countriesError.value = false
    try {
      countries.value = await api.getHolidayCountries()
    } catch {
      countriesError.value = true
    }
  }
}

function submitHolidays(): void {
  const country = countries.value.find((c) => c.code === selectedCountry.value)
  if (!country) return
  const withObservances = includeObservances.value
  store.add(
    `${country.name} holidays${withObservances ? ' & observances' : ''}`,
    `holidays:${country.code}${withObservances ? '?observances' : ''}`,
  )
  selectedCountry.value = ''
  includeObservances.value = false
  addingHolidays.value = false
}

const confirmingRemove = ref<{ id: string; name: string } | null>(null)

function onRemoveClick(id: string, name: string): void {
  confirmingRemove.value = { id, name }
}

function confirmRemove(): void {
  if (confirmingRemove.value) store.remove(confirmingRemove.value.id)
  confirmingRemove.value = null
}
</script>

<template>
  <div class="subscription-list">
    <div class="subscription-list__header">
      <h2 class="subscription-list__heading">Subscriptions</h2>
      <span class="subscription-list__header-actions">
        <button type="button" class="btn btn-ghost subscription-list__holidays-btn" @click="toggleHolidays">
          Holidays
        </button>
        <button type="button" class="icon-add-btn" title="Add subscription" @click="toggleAdd">+</button>
      </span>
    </div>

    <form v-if="addingHolidays" class="subscription-list__form" @submit.prevent="submitHolidays">
      <select v-model="selectedCountry" required aria-label="Country">
        <option value="" disabled>{{ countriesError ? 'Could not load countries' : 'Choose a country…' }}</option>
        <option v-for="c in countries" :key="c.code" :value="c.code" :disabled="addedCountryCodes.has(c.code)">
          {{ c.name }}
        </option>
      </select>
      <label class="subscription-list__check">
        <input v-model="includeObservances" type="checkbox" />
        <span>Include observances (Mother's Day, Valentine's Day, Easter Sunday…)</span>
      </label>
      <div class="subscription-list__form-actions">
        <button type="button" class="btn btn-ghost" @click="addingHolidays = false">Cancel</button>
        <button type="submit" class="btn btn-primary" :disabled="!selectedCountry">Add</button>
      </div>
    </form>

    <form v-if="adding" class="subscription-list__form" @submit.prevent="submitAdd">
      <input ref="nameInput" v-model="newName" type="text" placeholder="Name" required />
      <input v-model="newUrl" type="url" placeholder="https:// or webcal:// URL" required />
      <div class="subscription-list__form-actions">
        <button type="button" class="btn btn-ghost" @click="adding = false">Cancel</button>
        <button type="submit" class="btn btn-primary">Add</button>
      </div>
    </form>

    <ul>
      <li v-for="sub in store.subscriptions" :key="sub.id" class="subscription-list__item">
        <label class="subscription-list__toggle">
          <input type="checkbox" :checked="store.enabled[sub.id]" @change="store.toggle(sub.id)" />
          <span class="subscription-list__name">{{ sub.name }}</span>
        </label>
        <span v-if="store.errors[sub.id]" class="subscription-list__error" :title="store.errors[sub.id]">!</span>
        <input
          type="color"
          class="subscription-list__swatch"
          :value="sub.color"
          :title="`Color for ${sub.name}`"
          @input="onColorInput(sub.id, $event)"
        />
        <button type="button" class="icon-remove-btn" title="Remove" @click="onRemoveClick(sub.id, sub.name)">
          ×
        </button>
      </li>
      <li v-if="store.subscriptions.length === 0" class="subscription-list__empty">No subscriptions yet.</li>
    </ul>

    <ConfirmDialog
      v-if="confirmingRemove"
      title="Remove subscription"
      :message="`Remove '${confirmingRemove.name}'? This only removes it from your subscription list; it doesn't affect the original calendar.`"
      confirm-label="Remove"
      @confirm="confirmRemove"
      @cancel="confirmingRemove = null"
    />
  </div>
</template>

<style scoped>
.subscription-list__header-actions {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.subscription-list__holidays-btn {
  padding: 0.1rem 0.45rem;
  font-size: 0.72rem;
}
.subscription-list__check {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  font-size: 0.78rem;
}
.subscription-list__check input {
  margin-top: 0.15rem;
}
.subscription-list__form select {
  padding: 0.35rem 0.5rem;
  font-size: 0.82rem;
}
.subscription-list__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}
.subscription-list__heading {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-faint);
  margin: 0;
}
.subscription-list__form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem;
  margin-bottom: 0.4rem;
  background: var(--color-surface-hover);
  border-radius: var(--radius-sm);
}
.subscription-list__form input {
  padding: 0.35rem 0.5rem;
  font-size: 0.82rem;
}
.subscription-list__form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
}
.subscription-list__form-actions .btn {
  padding: 0.3rem 0.6rem;
  font-size: 0.78rem;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.subscription-list__item {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.5rem;
  border-radius: var(--radius-sm);
}
.subscription-list__item:hover {
  background: var(--color-surface-hover);
}
.subscription-list__toggle {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex: 1;
  min-width: 0;
  padding: 0.2rem 0;
  cursor: pointer;
}
.subscription-list__toggle input[type='checkbox'] {
  width: 15px;
  height: 15px;
  margin: 0;
  cursor: pointer;
}
.subscription-list__name {
  font-size: 0.88rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.subscription-list__error {
  flex-shrink: 0;
  color: var(--color-danger);
  font-weight: 700;
  font-size: 0.78rem;
  cursor: help;
}
.subscription-list__empty {
  padding: 0.4rem 0.5rem;
  color: var(--color-text-faint);
  font-size: 0.85rem;
}
.subscription-list__swatch {
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
.subscription-list__swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}
.subscription-list__swatch::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}
.subscription-list__swatch::-moz-color-swatch {
  border: none;
  border-radius: 50%;
}
</style>
