<script setup lang="ts">
import { t } from '../i18n.js'
import { useUndoStore } from '../stores/undo.js'

const undo = useUndoStore()
const emit = defineEmits<{ error: [message: string] }>()

async function onUndo(): Promise<void> {
  try {
    await undo.invoke()
  } catch (err) {
    undo.dismiss()
    emit('error', err instanceof Error ? err.message : t('undo.failed'))
  }
}
</script>

<template>
  <Transition name="toast">
    <div v-if="undo.pending" class="undo-toast" role="status">
      <span class="undo-toast__msg">{{ undo.pending.message }}</span>
      <button type="button" class="undo-toast__action" :disabled="undo.running" @click="onUndo">
        {{ undo.running ? $t('undo.running') : $t('undo.action') }}
      </button>
      <button type="button" class="undo-toast__close" :aria-label="$t('common.dismiss')" @click="undo.dismiss()">✕</button>
    </div>
  </Transition>
</template>

<style scoped>
.undo-toast {
  position: fixed;
  left: 50%;
  bottom: 1.5rem;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 0.85rem;
  background: var(--color-text);
  color: var(--color-surface);
  padding: 0.6rem 0.7rem 0.6rem 1rem;
  border-radius: var(--radius-md, 8px);
  box-shadow: var(--shadow-lg);
  font-size: 0.85rem;
  max-width: min(90vw, 420px);
}
.undo-toast__msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.undo-toast__action {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--color-primary-soft, #9db8ff);
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
}
.undo-toast__action:disabled {
  opacity: 0.6;
  cursor: default;
}
.undo-toast__close {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0.2rem;
}
.undo-toast__close:hover {
  opacity: 1;
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
