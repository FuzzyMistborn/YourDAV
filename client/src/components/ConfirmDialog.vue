<script setup lang="ts">
defineProps<{ title: string; message: string; confirmLabel?: string }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <div class="overlay" @click.self="emit('cancel')">
    <div class="dialog">
      <h2>{{ title }}</h2>
      <p class="dialog__message">{{ message }}</p>
      <div class="dialog__actions">
        <button type="button" class="btn btn-ghost" @click="emit('cancel')">{{ $t('common.cancel') }}</button>
        <button type="button" class="btn btn-danger" @click="emit('confirm')">
          {{ confirmLabel ?? $t('common.delete') }}
        </button>
      </div>
    </div>
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
  z-index: 40;
  animation: fade-in 0.12s ease;
}
.dialog {
  background: var(--color-surface);
  padding: 1.5rem;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 300px;
  animation: pop-in 0.14s ease;
}
.dialog h2 {
  font-size: 1.05rem;
}
.dialog__message {
  margin: 0.5rem 0 1rem;
  color: var(--color-text-muted);
  font-size: 0.85rem;
}
.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
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
