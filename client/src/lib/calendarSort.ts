import type { Calendar } from '@yourdav/shared'
import type { CalendarSortOrder } from '../stores/settings.js'

// Orders calendars per the user's sort setting. 'server' keeps the incoming
// order (CalDAV has no ordering property). Never mutates the input.
export function sortCalendars<T extends Pick<Calendar, 'displayName'>>(
  calendars: T[],
  order: CalendarSortOrder,
): T[] {
  switch (order) {
    case 'name-asc':
      return [...calendars].sort((a, b) => a.displayName.localeCompare(b.displayName))
    case 'name-desc':
      return [...calendars].sort((a, b) => b.displayName.localeCompare(a.displayName))
    case 'server':
    default:
      return calendars
  }
}
