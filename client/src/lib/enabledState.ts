// Remembers which calendars / subscriptions the user has toggled on or off
// so the choice survives a reload. Stored as id -> boolean; ids with no
// entry fall back to their store's default.
export function loadEnabledState(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, boolean> = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') result[id] = value
    }
    return result
  } catch {
    return {}
  }
}

export function saveEnabledState(key: string, state: Record<string, boolean>): void {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Storage full or unavailable: the toggle just won't persist.
  }
}
