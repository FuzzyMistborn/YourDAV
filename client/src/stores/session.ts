import type { SessionInfo } from '@yourdav/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, ApiRequestError } from '../api.js'
import { clearAccountStorage } from '../lib/accountStorage.js'
import { useContactsStore } from './contacts.js'
import { useNotificationsStore } from './notifications.js'
import { useSubscriptionsStore } from './subscriptions.js'

export const useSessionStore = defineStore('session', () => {
  const info = ref<SessionInfo | null>(null)
  const checked = ref(false)

  async function refresh(): Promise<boolean> {
    try {
      info.value = await api.whoami()
      return true
    } catch {
      info.value = null
      return false
    } finally {
      checked.value = true
    }
  }

  async function login(serverUrl: string, username: string, password: string): Promise<void> {
    info.value = await api.login({ serverUrl, username, password })
  }

  async function logout(): Promise<void> {
    await api.logout()
    info.value = null
    // Account-scoped state (subscription URLs, color overrides, dismissed
    // shares) is stored in plain localStorage with no per-account
    // partitioning -- clear it so the next login on this browser doesn't
    // inherit the previous user's data.
    clearAccountStorage()
    // Pending reminder timers are scheduled from the previous account's own
    // event data -- without cancelling them, a reminder for an event the
    // next-logged-in user (on a shared browser/session) never opened could
    // still fire after the switch.
    useNotificationsStore().clear()
    useContactsStore().clear()
    useSubscriptionsStore().clear()
  }

  return { info, checked, refresh, login, logout, ApiRequestError }
})
