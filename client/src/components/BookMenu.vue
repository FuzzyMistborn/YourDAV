<script setup lang="ts">
import type { AddressBook } from '@yourdav/shared'
import { usePopover } from '../lib/popover.js'

// A "Move / copy to ..." menu. Each list is the address books that action may
// target; an empty list hides that section, and with both empty the button is disabled.
const props = defineProps<{ label: string; moveTargets: AddressBook[]; copyTargets: AddressBook[] }>()
const emit = defineEmits<{ pick: [bookId: string, mode: 'move' | 'copy'] }>()

const { open, trigger, menu, pos, toggle, close } = usePopover()

function pick(bookId: string, mode: 'move' | 'copy'): void {
  close()
  emit('pick', bookId, mode)
}
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="btn btn-secondary btn-sm"
    aria-haspopup="menu"
    :aria-expanded="open"
    :disabled="props.moveTargets.length === 0 && props.copyTargets.length === 0"
    @click="toggle"
  >
    {{ label }} ▾
  </button>
  <Teleport to="body">
    <div v-if="open" ref="menu" class="popmenu" role="menu" :style="{ top: `${pos.top}px`, left: `${pos.left}px` }">
      <template v-if="moveTargets.length">
        <div class="popmenu__heading">{{ $t('bookMenu.moveTo') }}</div>
        <button
          v-for="b in moveTargets"
          :key="`m${b.id}`"
          type="button"
          role="menuitem"
          class="popmenu__item"
          @click="pick(b.id, 'move')"
        >
          {{ b.displayName }}
        </button>
      </template>
      <template v-if="copyTargets.length">
        <div class="popmenu__heading">{{ $t('bookMenu.copyTo') }}</div>
        <button
          v-for="b in copyTargets"
          :key="`c${b.id}`"
          type="button"
          role="menuitem"
          class="popmenu__item"
          @click="pick(b.id, 'copy')"
        >
          {{ b.displayName }}
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
  max-height: 320px;
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
</style>
