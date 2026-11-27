<script setup lang="ts">
import type { PendingShare } from '@yourdav/shared'
import { onMounted, ref } from 'vue'
import { api, ApiRequestError } from '../api.js'
import { t } from '../i18n.js'
import { useCalendarsStore } from '../stores/calendars.js'

const calendarsStore = useCalendarsStore()

const pending = ref<PendingShare[]>([])
const accepting = ref<string | null>(null)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  try {
    const all = await api.listPendingShares()
    // Drop any share the user explicitly unsubscribed from (Radicale's
    // "hide") unless the owner has done something new with it since --
    // otherwise every hidden share would resurface here looking exactly
    // like a fresh invite. See stores/calendars.ts's dismissedPending.
    pending.value = all.filter((share) => {
      const dismissedAt = calendarsStore.dismissedPending[share.pathOrToken]
      return dismissedAt === undefined || share.updatedAt > dismissedAt
    })
  } catch {
    // Best-effort, same spirit as the server side: a server with no
    // sharing support (or a transient error) just means nothing pending.
    pending.value = []
  }
}

function dismiss(share: PendingShare): void {
  // Purely client-side: a pending share is already hidden/unaccepted on
  // the server by definition, so there's nothing to change server-side --
  // this just stops it resurfacing in this list. See stores/calendars.ts.
  //
  // Uses share.updatedAt (Radicale's own clock), not the browser's
  // Date.now() -- Radicale's TimestampUpdated is computed from the
  // server's naive local time treated as if it were UTC (confirmed by
  // testing: consistently off from real UTC by the server's own UTC
  // offset), so comparing it against a client-side wall-clock timestamp
  // means the "resurface only if newer" check in load() above can never
  // fire correctly whenever the server isn't in UTC. Comparing
  // Radicale's clock only against itself sidesteps the offset entirely.
  calendarsStore.dismissPending(share.pathOrToken, share.updatedAt)
  pending.value = pending.value.filter((p) => p.pathOrToken !== share.pathOrToken)
}

async function accept(share: PendingShare): Promise<void> {
  accepting.value = share.pathOrToken
  error.value = null
  try {
    await api.acceptPendingShare(share.pathOrToken)
    pending.value = pending.value.filter((p) => p.pathOrToken !== share.pathOrToken)
    await calendarsStore.load()
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : t('pendingShares.acceptFailed')
  } finally {
    accepting.value = null
  }
}

onMounted(load)
</script>

<template>
  <div v-if="pending.length > 0" class="pending-shares">
    <h2 class="pending-shares__heading">{{ $t('pendingShares.heading') }}</h2>
    <ul>
      <li v-for="share in pending" :key="share.pathOrToken" class="pending-shares__item">
        <span class="pending-shares__label" :title="$t('pendingShares.shared', { owner: share.owner, label: share.label })">
          <i18n-t keypath="pendingShares.shared" scope="global">
            <template #owner><strong>{{ share.owner }}</strong></template>
            <template #label>{{ share.label }}</template>
          </i18n-t>
        </span>
        <div class="pending-shares__actions">
          <button
            type="button"
            class="btn btn-primary pending-shares__accept"
            :disabled="accepting === share.pathOrToken"
            @click="accept(share)"
          >
            {{ accepting === share.pathOrToken ? $t('pendingShares.accepting') : $t('pendingShares.accept') }}
          </button>
          <button
            type="button"
            class="btn btn-ghost pending-shares__dismiss"
            :title="$t('pendingShares.hideTitle')"
            @click="dismiss(share)"
          >
            {{ $t('pendingShares.dismiss') }}
          </button>
        </div>
      </li>
    </ul>
    <p v-if="error" class="pending-shares__error">{{ error }}</p>
  </div>
</template>

<style scoped>
.pending-shares {
  margin-bottom: 0.9rem;
}
.pending-shares__heading {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-faint);
  margin: 0 0 0.4rem;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.pending-shares__item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.35rem;
  padding: 0.35rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--color-surface-hover);
}
.pending-shares__label {
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pending-shares__actions {
  display: flex;
  gap: 0.4rem;
}
.pending-shares__accept,
.pending-shares__dismiss {
  flex: 1;
  padding: 0.25rem 0.55rem;
  font-size: 0.78rem;
}
.pending-shares__error {
  margin: 0.4rem 0 0;
  font-size: 0.8rem;
  color: var(--color-danger);
}
</style>
