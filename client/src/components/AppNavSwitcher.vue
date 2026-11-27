<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useSessionStore } from '../stores/session.js'

const route = useRoute()
const session = useSessionStore()
</script>

<template>
  <nav class="nav-switcher" :aria-label="$t('nav.main')">
    <RouterLink
      to="/"
      class="nav-switcher__tab"
      :class="{ 'nav-switcher__tab--active': route.name === 'calendar' || route.path === '/' }"
    >
      <svg class="nav-switcher__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="3" y="4.5" width="18" height="16" rx="3" />
        <path d="M3 9.5h18" />
        <path d="M8 2.5v4M16 2.5v4" stroke-linecap="round" />
      </svg>
      <span>{{ $t('nav.calendar') }}</span>
    </RouterLink>

    <RouterLink
      v-if="session.info?.hasContacts"
      to="/contacts"
      class="nav-switcher__tab"
      :class="{ 'nav-switcher__tab--active': route.name === 'contacts' || route.path.startsWith('/contacts') }"
    >
      <svg class="nav-switcher__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span>{{ $t('nav.contacts') }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.nav-switcher {
  display: flex;
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 3px;
  gap: 3px;
}

.nav-switcher__tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-muted);
  text-decoration: none;
  border-radius: var(--radius-sm);
  transition: all 0.15s ease;
  user-select: none;
}

.nav-switcher__tab:hover {
  color: var(--color-text);
  background: rgba(0, 0, 0, 0.03);
}

:root[data-theme='dark'] .nav-switcher__tab:hover {
  background: rgba(255, 255, 255, 0.04);
}

.nav-switcher__tab--active {
  background: var(--color-surface) !important;
  color: var(--color-primary) !important;
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.nav-switcher__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
</style>
