<script setup lang="ts">
import type { OwnedShare, SharePermission, ShareCalendarResult } from '@yourdav/shared'
import { nextTick, onMounted, reactive, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'

const props = defineProps<{ calendarId: string; calendarName: string }>()
const emit = defineEmits<{ close: [] }>()

const recipient = ref('')
const recipientInput = ref<HTMLInputElement | null>(null)
const permission = ref<SharePermission>('readwrite')
const submitting = ref(false)
const error = ref<string | null>(null)
const result = ref<ShareCalendarResult | null>(null)

const shares = ref<OwnedShare[]>([])
const sharesLoading = ref(true)
const sharesError = ref<string | null>(null)
const rowBusy = reactive<Record<string, boolean>>({})
const rowError = reactive<Record<string, string>>({})

async function loadShares(): Promise<void> {
  sharesLoading.value = true
  sharesError.value = null
  try {
    shares.value = await api.listShares(props.calendarId)
  } catch (err) {
    // Non-fatal -- the invite form below still works even if the current-
    // shares list can't be loaded -- but shown explicitly rather than
    // silently rendering as "not shared with anyone", which would look
    // identical to a real empty state and hide a real failure.
    shares.value = []
    sharesError.value = err instanceof ApiRequestError ? err.message : 'Could not load current shares'
  } finally {
    sharesLoading.value = false
  }
}
onMounted(() => {
  void loadShares()
  // The bare `autofocus` attribute isn't reliably honored for a dialog
  // mounted after page load -- focus the recipient field explicitly.
  void nextTick(() => recipientInput.value?.focus())
})

async function onPermissionChange(share: OwnedShare, newPermission: SharePermission): Promise<void> {
  rowBusy[share.token] = true
  delete rowError[share.token]
  try {
    await api.updateSharePermission(props.calendarId, share.token, newPermission)
    share.permission = newPermission
  } catch (err) {
    rowError[share.token] = err instanceof ApiRequestError ? err.message : 'Failed to update permission'
  } finally {
    rowBusy[share.token] = false
  }
}

async function onRevoke(share: OwnedShare): Promise<void> {
  if (!confirm(`Stop sharing with ${share.recipient}?`)) return
  rowBusy[share.token] = true
  delete rowError[share.token]
  try {
    await api.revokeShare(props.calendarId, share.token)
    shares.value = shares.value.filter((s) => s.token !== share.token)
  } catch (err) {
    rowError[share.token] = err instanceof ApiRequestError ? err.message : 'Failed to revoke share'
  } finally {
    rowBusy[share.token] = false
  }
}

async function submit(): Promise<void> {
  if (!recipient.value.trim()) return
  submitting.value = true
  error.value = null
  try {
    result.value = await api.shareCalendar(props.calendarId, {
      recipient: recipient.value.trim(),
      permission: permission.value,
    })
    await loadShares()
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Failed to share calendar'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <h2>Share &quot;{{ calendarName }}&quot;</h2>

      <div v-if="result">
        <p class="dialog__message">
          Shared with <strong>{{ recipient }}</strong>.
          <template v-if="result.pending">
            Your side is set up, but this server (Radicale) requires the recipient to separately accept the
            invite before it appears for them -- they'll see it under "Pending shares" the next time they log in.
          </template>
          <template v-else> They should see it the next time they load the app. </template>
        </p>
        <div class="dialog__actions">
          <button type="button" class="btn btn-primary" @click="emit('close')">Done</button>
        </div>
      </div>

      <template v-else>
        <div class="shares-list">
          <span class="shares-list__label">Currently shared with</span>
          <p v-if="sharesLoading" class="shares-list__empty">Loading…</p>
          <p v-else-if="shares.length === 0" class="shares-list__empty">Not shared with anyone yet.</p>
          <template v-else>
            <div v-for="share in shares" :key="share.token" class="shares-list__row">
              <span class="shares-list__recipient" :title="share.recipient">{{ share.recipient }}</span>
              <span v-if="!share.accepted" class="shares-list__pending">pending</span>
              <select
                :value="share.permission"
                :disabled="rowBusy[share.token]"
                @change="onPermissionChange(share, ($event.target as HTMLSelectElement).value as SharePermission)"
              >
                <option value="readwrite">Can edit</option>
                <option value="read">View only</option>
              </select>
              <button
                type="button"
                class="icon-remove-btn"
                :disabled="rowBusy[share.token]"
                title="Revoke access"
                @click="onRevoke(share)"
              >
                ×
              </button>
            </div>
          </template>
          <p v-for="(msg, token) in rowError" :key="token" class="dialog__error">{{ msg }}</p>
        </div>

        <form @submit.prevent="submit">
        <p class="dialog__message">
          Enter the recipient's username (Radicale) or email address (Baikal) -- this app tries both, since it
          depends on which CalDAV server you're using.
        </p>
        <label class="dialog__field">
          <span>Recipient</span>
          <input ref="recipientInput" v-model="recipient" type="text" placeholder="username or email" />
        </label>
        <label class="dialog__field">
          <span>Access</span>
          <select v-model="permission">
            <option value="readwrite">Can edit</option>
            <option value="read">View only</option>
          </select>
        </label>
        <p v-if="error" class="dialog__error">{{ error }}</p>
        <div class="dialog__actions">
          <button type="button" class="btn btn-ghost" @click="emit('close')">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="submitting || !recipient.trim()">
            {{ submitting ? 'Sharing…' : 'Share' }}
          </button>
        </div>
        </form>
      </template>
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
  width: 340px;
  animation: pop-in 0.14s ease;
}
.dialog h2 {
  font-size: 1.05rem;
  margin: 0 0 0.5rem;
}
.dialog__message {
  margin: 0.5rem 0 1rem;
  color: var(--color-text-muted);
  font-size: 0.85rem;
}
.shares-list {
  margin-bottom: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.shares-list__label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-faint);
}
.shares-list__empty {
  margin: 0.15rem 0 0;
  font-size: 0.82rem;
  color: var(--color-text-faint);
}
.shares-list__row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.shares-list__recipient {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
}
.shares-list__pending {
  flex-shrink: 0;
  font-size: 0.7rem;
  color: var(--color-text-faint);
}
.shares-list__row select {
  flex-shrink: 0;
  padding: 0.25rem 0.4rem;
  font-size: 0.8rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: inherit;
}
.dialog__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.75rem;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.dialog__field input,
.dialog__field select {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  background: var(--color-surface);
  color: inherit;
  box-sizing: border-box;
}
.dialog__error {
  margin: 0 0 0.75rem;
  padding: 0.5rem 0.7rem;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
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
