<script setup lang="ts">
import { DateTime } from 'luxon'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settings.js'

const props = defineProps<{ modelValue: string }>() // 'HH:mm', 24h
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const settingsStore = useSettingsStore()

const STEP_MINUTES = 5
// Free-text parsing stays lenient regardless of the display format setting,
// so users can type either style.
const PARSE_FORMATS = ['h:mm a', 'h:mma', 'H:mm', 'Hmm', 'h a', 'ha', 'h']

interface Option {
  value: string
  label: string
  searchKey: string
}

const displayFormat = computed(() => (settingsStore.timeFormat === '24h' ? 'HH:mm' : 'h:mm a'))

const OPTIONS = computed<Option[]>(() => {
  const options: Option[] = []
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += STEP_MINUTES) {
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      const label = DateTime.fromFormat(value, 'HH:mm').toFormat(displayFormat.value)
      options.push({ value, label, searchKey: label.toLowerCase().replace(/[^a-z0-9]/g, '') })
    }
  }
  return options
})

function labelFor(value: string): string {
  return OPTIONS.value.find((o) => o.value === value)?.label ?? value
}

const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const optionEls = ref<Record<string, HTMLElement | null>>({})

const open = ref(false)
const query = ref(labelFor(props.modelValue))
const highlighted = ref(-1)
// Query starts each open already populated with the current value's label
// (so it's visible/selectable), but that same text must not filter the
// list down to just itself -- only text the user actually types should
// narrow the options. Cleared whenever the list opens, set once real
// keyboard input happens.
const hasEdited = ref(false)
const listStyle = ref({ top: '0px', left: '0px', width: '0px' })

// The dropdown is teleported to <body> and positioned with fixed
// coordinates -- it's rendered inside a modal dialog that has
// `overflow-y: auto`, which would otherwise clip an absolutely-positioned
// dropdown the moment it extends past the dialog's own bounds.
function updateListPosition(): void {
  const rect = inputEl.value?.getBoundingClientRect()
  if (!rect) return
  listStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
  }
}

watch(
  () => props.modelValue,
  (value) => {
    if (!open.value) query.value = labelFor(value)
  },
)

// A hovering mouse can set `highlighted` (below) with no relation to what's
// being typed -- since the dropdown sits right under the input the user
// just clicked, the cursor is very likely already resting on some option.
// Any keystroke must clear that so Enter falls through to parsing the
// typed text, rather than silently jumping to whatever's under the mouse.
watch(query, () => {
  highlighted.value = -1
})

const filteredOptions = computed<Option[]>(() => {
  if (!hasEdited.value) return OPTIONS.value
  const normalized = query.value.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!normalized) return OPTIONS.value
  const matches = OPTIONS.value.filter((o) => o.searchKey.includes(normalized))
  return matches.length > 0 ? matches : OPTIONS.value
})

function openList(): void {
  if (open.value) return
  open.value = true
  highlighted.value = -1
  hasEdited.value = false
  updateListPosition()
  nextTick(() => {
    const current = optionEls.value[props.modelValue]
    current?.scrollIntoView({ block: 'center' })
  })
}

function closeList(revert: boolean): void {
  open.value = false
  highlighted.value = -1
  if (revert) query.value = labelFor(props.modelValue)
}

function select(option: Option): void {
  emit('update:modelValue', option.value)
  query.value = option.label
  closeList(false)
}

function parseFreeText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  for (const fmt of PARSE_FORMATS) {
    const dt = DateTime.fromFormat(trimmed, fmt)
    if (dt.isValid) {
      const rounded = Math.round(dt.minute / STEP_MINUTES) * STEP_MINUTES
      return dt.set({ minute: 0, second: 0, millisecond: 0 }).plus({ minutes: rounded }).toFormat('HH:mm')
    }
  }
  return null
}

function onEnter(): void {
  if (highlighted.value >= 0 && filteredOptions.value[highlighted.value]) {
    select(filteredOptions.value[highlighted.value])
    return
  }
  const parsed = parseFreeText(query.value)
  if (parsed) {
    emit('update:modelValue', parsed)
    query.value = labelFor(parsed)
    closeList(false)
  } else {
    closeList(true)
  }
}

function onArrow(direction: 1 | -1): void {
  openList()
  const count = filteredOptions.value.length
  if (count === 0) return
  highlighted.value = (highlighted.value + direction + count) % count
  nextTick(() => {
    const opt = filteredOptions.value[highlighted.value]
    if (opt) optionEls.value[opt.value]?.scrollIntoView({ block: 'nearest' })
  })
}

function onFocus(event: FocusEvent): void {
  openList()
  if (event.target instanceof HTMLInputElement) event.target.select()
}

function onDocumentClick(event: MouseEvent): void {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) {
    const parsed = parseFreeText(query.value)
    if (parsed) {
      emit('update:modelValue', parsed)
      query.value = labelFor(parsed)
    } else {
      query.value = labelFor(props.modelValue)
    }
    open.value = false
  }
}

function onScrollOrResize(event: Event): void {
  // Scroll events don't bubble but ARE observable via capturing listeners on
  // ancestors -- that includes scrolling *inside* the dropdown list itself,
  // which must not close it.
  if (listEl.value && event.target instanceof Node && listEl.value.contains(event.target)) return
  if (open.value) closeList(true)
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentClick)
  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentClick)
  window.removeEventListener('scroll', onScrollOrResize, true)
  window.removeEventListener('resize', onScrollOrResize)
})
</script>

<template>
  <div ref="rootEl" class="combobox">
    <input
      ref="inputEl"
      v-model="query"
      type="text"
      autocomplete="off"
      class="combobox__input"
      @input="hasEdited = true"
      @focus="onFocus"
      @keydown.down.prevent="onArrow(1)"
      @keydown.up.prevent="onArrow(-1)"
      @keydown.enter.prevent="onEnter"
      @keydown.esc.prevent="closeList(true)"
    />
    <Teleport to="body">
      <ul v-if="open" ref="listEl" class="combobox__list" role="listbox" :style="listStyle">
        <li
          v-for="(option, index) in filteredOptions"
          :key="option.value"
          :ref="(el) => (optionEls[option.value] = el as HTMLElement | null)"
          class="combobox__option"
          :class="{
            'combobox__option--active': index === highlighted,
            'combobox__option--current': option.value === modelValue,
          }"
          role="option"
          @mousedown.prevent="select(option)"
          @mouseenter="highlighted = index"
        >
          {{ option.label }}
        </li>
        <li v-if="filteredOptions.length === 0" class="combobox__empty">{{ $t('search.noMatches') }}</li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.combobox {
  position: relative;
  flex: 1;
  min-width: 0;
}
.combobox__input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  font-size: 0.9rem;
}
.combobox__list {
  position: fixed;
  z-index: 1000;
  max-height: 12.5rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}
.combobox__option {
  padding: 0.4rem 0.6rem;
  border-radius: 4px;
  font-size: 0.88rem;
  cursor: pointer;
}
.combobox__option--active {
  background: var(--color-surface-hover);
}
.combobox__option--current {
  font-weight: 600;
  color: var(--color-primary);
}
.combobox__empty {
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  color: var(--color-text-faint);
}
</style>
