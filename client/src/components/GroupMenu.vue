<script setup lang="ts">
import { ref } from 'vue'
import { usePopover } from '../lib/popover.js'

// "Group ▾" menu for a batch of contacts: add them to an existing or new group,
// or remove them from a group any of them is in.
defineProps<{ groups: string[]; removable: string[] }>()
const emit = defineEmits<{ add: [name: string]; remove: [name: string] }>()

const { open, trigger, menu, pos, toggle, close } = usePopover()
const newName = ref('')

function add(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  newName.value = ''
  close()
  emit('add', trimmed)
}

function remove(name: string): void {
  close()
  emit('remove', name)
}
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="btn btn-secondary btn-sm"
    aria-haspopup="menu"
    :aria-expanded="open"
    @click="toggle"
  >
    {{ $t('groupMenu.button') }} ▾
  </button>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="popmenu" role="menu" :style="{ top: `${pos.top}px`, left: `${pos.left}px` }">
      <div class="popmenu__heading">{{ $t('groupMenu.addTo') }}</div>
      <button v-for="g in groups" :key="`a${g}`" type="button" role="menuitem" class="popmenu__item" @click="add(g)">
        {{ g }}
      </button>
      <form class="popmenu__new" @submit.prevent="add(newName)">
        <input v-model="newName" type="text" class="popmenu__input" :placeholder="$t('groupMenu.newPlaceholder')" :aria-label="$t('groupMenu.newLabel')" />
        <button type="submit" class="btn btn-primary btn-sm" :disabled="!newName.trim()">{{ $t('common.add') }}</button>
      </form>
      <template v-if="removable.length">
        <div class="popmenu__heading">{{ $t('groupMenu.removeFrom') }}</div>
        <button
          v-for="g in removable"
          :key="`r${g}`"
          type="button"
          role="menuitem"
          class="popmenu__item"
          @click="remove(g)"
        >
          {{ g }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.popmenu {
  position: fixed;
  z-index: 50;
  width: 240px;
  max-height: 340px;
  overflow-y: auto;
  padding: 0.35rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}
.popmenu__heading {
  padding: 0.35rem 0.5rem 0.2rem;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.popmenu__item {
  display: block;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text);
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.popmenu__item:hover,
.popmenu__item:focus-visible {
  background: var(--color-surface-hover);
}
.popmenu__new {
  display: flex;
  gap: 0.35rem;
  padding: 0.3rem 0.35rem;
}
.popmenu__input {
  flex: 1;
  min-width: 0;
  padding: 0.3rem 0.45rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: inherit;
  font-size: 0.82rem;
}
</style>
