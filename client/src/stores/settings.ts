import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type WeekStart = 'sunday' | 'monday'

export type TimeFormat = '12h' | '24h'

// 'server' preserves whatever order the CalDAV server's PROPFIND response
// enumerated calendars in (CalDAV has no standard ordering property, so
// this is really just "however the server happens to return them" -- see
// AGENTS.md's calendar-sorting note).
export type CalendarSortOrder = 'server' | 'name-asc' | 'name-desc'

// 'fixed'     -> new events always default to defaultCalendarId
// 'last-used' -> new events default to whichever calendar the last event was
//                created in, falling back to defaultCalendarId
export type DefaultCalendarMode = 'fixed' | 'last-used'

// Matches the FullCalendar view names wired up in CalendarView.vue's
// headerToolbar (multiMonthYear,dayGridMonth,timeGridWeek,timeGridDay,listUpcoming) --
// keep in sync if a view is ever renamed or removed there.
export type CalendarViewType = 'multiMonthYear' | 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay' | 'listUpcoming'

// 'auto' follows the OS's prefers-color-scheme (live, via matchMedia).
export type Theme = 'auto' | 'light' | 'dark'

// 'us': street, city, state, ZIP.  'intl': postal code before the city.
export type AddressFormat = 'us' | 'intl'

// Which name part contacts sort by first.
export type ContactSortOrder = 'last-first' | 'first-last'

export const DEFAULT_EVENT_LENGTHS = [15, 30, 45, 60, 90, 120] as const

const STORAGE_KEY = 'calendar.weekStart'
const DEFAULT_CALENDAR_STORAGE_KEY = 'calendar.defaultCalendarId'
const DEFAULT_CALENDAR_MODE_STORAGE_KEY = 'calendar.defaultCalendarMode'
const LAST_USED_CALENDAR_STORAGE_KEY = 'calendar.lastUsedCalendarId'
const SORT_ORDER_STORAGE_KEY = 'calendar.sortOrder'
const TIME_FORMAT_STORAGE_KEY = 'calendar.timeFormat'
const DEFAULT_VISIBLE_CALENDARS_STORAGE_KEY = 'calendar.defaultVisibleCalendarIds'
const DEFAULT_VIEW_STORAGE_KEY = 'calendar.defaultView'
const THEME_STORAGE_KEY = 'calendar.theme'
const NOW_INDICATOR_STORAGE_KEY = 'calendar.nowIndicator'
const WEEK_NUMBERS_STORAGE_KEY = 'calendar.weekNumbers'
const SHOW_WEEKENDS_STORAGE_KEY = 'calendar.showWeekends'
const SCROLL_HOUR_STORAGE_KEY = 'calendar.scrollHour'
const DEFAULT_EVENT_LENGTH_STORAGE_KEY = 'calendar.defaultEventLength'
const DEFAULT_REMINDER_STORAGE_KEY = 'calendar.defaultReminder'
const ADDRESS_FORMAT_STORAGE_KEY = 'contacts.addressFormat'
const CONTACT_SORT_ORDER_STORAGE_KEY = 'contacts.sortOrder'

const VALID_VIEWS: CalendarViewType[] = ['multiMonthYear', 'dayGridMonth', 'timeGridWeek', 'timeGridDay', 'listUpcoming']

function loadDefaultView(): CalendarViewType {
  const stored = localStorage.getItem(DEFAULT_VIEW_STORAGE_KEY)
  return (VALID_VIEWS as string[]).includes(stored ?? '') ? (stored as CalendarViewType) : 'dayGridMonth'
}

function loadTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'auto'
}

function loadBoolean(key: string, fallback: boolean): boolean {
  const stored = localStorage.getItem(key)
  return stored === null ? fallback : stored === 'true'
}

// Parses a stored whole number and accepts it only if `valid` agrees --
// anything missing, malformed, or out of range falls back to the default.
function loadInt(key: string, fallback: number, valid: (n: number) => boolean): number {
  const n = Number(localStorage.getItem(key) ?? NaN)
  return Number.isInteger(n) && valid(n) ? n : fallback
}

// null = no reminder on new events. Capped at the same 4 weeks the edit
// dialog's own validation allows.
function loadDefaultReminder(): number | null {
  const n = loadInt(DEFAULT_REMINDER_STORAGE_KEY, -1, (m) => m >= 0 && m <= 40320)
  return n === -1 ? null : n
}

function loadInitial(): WeekStart {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'monday' ? 'monday' : 'sunday'
}

function loadTimeFormat(): TimeFormat {
  return localStorage.getItem(TIME_FORMAT_STORAGE_KEY) === '24h' ? '24h' : '12h'
}

function loadAddressFormat(): AddressFormat {
  return localStorage.getItem(ADDRESS_FORMAT_STORAGE_KEY) === 'intl' ? 'intl' : 'us'
}

function loadContactSortOrder(): ContactSortOrder {
  return localStorage.getItem(CONTACT_SORT_ORDER_STORAGE_KEY) === 'first-last' ? 'first-last' : 'last-first'
}

function loadDefaultCalendarMode(): DefaultCalendarMode {
  return localStorage.getItem(DEFAULT_CALENDAR_MODE_STORAGE_KEY) === 'last-used' ? 'last-used' : 'fixed'
}

function loadSortOrder(): CalendarSortOrder {
  const stored = localStorage.getItem(SORT_ORDER_STORAGE_KEY)
  return stored === 'name-asc' || stored === 'name-desc' ? stored : 'server'
}

// Empty means "no preference set" -- every calendar starts visible, same as
// before this setting existed. A non-empty list is an explicit whitelist of
// which calendars should be checked on load.
function loadDefaultVisibleCalendarIds(): string[] {
  try {
    const raw = localStorage.getItem(DEFAULT_VISIBLE_CALENDARS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const weekStart = ref<WeekStart>(loadInitial())
  const defaultCalendarId = ref<string>(localStorage.getItem(DEFAULT_CALENDAR_STORAGE_KEY) ?? '')
  const defaultCalendarMode = ref<DefaultCalendarMode>(loadDefaultCalendarMode())
  const lastUsedCalendarId = ref<string>(localStorage.getItem(LAST_USED_CALENDAR_STORAGE_KEY) ?? '')
  const calendarSortOrder = ref<CalendarSortOrder>(loadSortOrder())
  const timeFormat = ref<TimeFormat>(loadTimeFormat())
  const defaultVisibleCalendarIds = ref<string[]>(loadDefaultVisibleCalendarIds())
  const defaultView = ref<CalendarViewType>(loadDefaultView())
  const theme = ref<Theme>(loadTheme())
  const nowIndicator = ref<boolean>(loadBoolean(NOW_INDICATOR_STORAGE_KEY, true))
  const weekNumbers = ref<boolean>(loadBoolean(WEEK_NUMBERS_STORAGE_KEY, false))
  const showWeekends = ref<boolean>(loadBoolean(SHOW_WEEKENDS_STORAGE_KEY, true))
  const scrollHour = ref<number>(loadInt(SCROLL_HOUR_STORAGE_KEY, 8, (h) => h >= 0 && h <= 23))
  const defaultEventLength = ref<number>(
    loadInt(DEFAULT_EVENT_LENGTH_STORAGE_KEY, 60, (m) => (DEFAULT_EVENT_LENGTHS as readonly number[]).includes(m)),
  )
  const defaultReminder = ref<number | null>(loadDefaultReminder())
  const addressFormat = ref<AddressFormat>(loadAddressFormat())
  const contactSortOrder = ref<ContactSortOrder>(loadContactSortOrder())

  // The resolved theme lands on <html data-theme="light|dark">, which
  // base.css keys its dark token overrides off. Applied here (not in a
  // component) so it takes effect as soon as anything -- App.vue, on every
  // route including login -- first touches the store.
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  function applyTheme(): void {
    const resolved = theme.value === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : theme.value
    document.documentElement.dataset.theme = resolved
  }
  darkQuery.addEventListener('change', applyTheme)
  applyTheme()

  // FullCalendar's firstDay option: 0 = Sunday, 1 = Monday.
  const firstDay = computed(() => (weekStart.value === 'monday' ? 1 : 0))

  function setWeekStart(value: WeekStart): void {
    weekStart.value = value
    localStorage.setItem(STORAGE_KEY, value)
  }

  function setDefaultCalendarId(value: string): void {
    defaultCalendarId.value = value
    localStorage.setItem(DEFAULT_CALENDAR_STORAGE_KEY, value)
  }

  function setDefaultCalendarMode(value: DefaultCalendarMode): void {
    defaultCalendarMode.value = value
    localStorage.setItem(DEFAULT_CALENDAR_MODE_STORAGE_KEY, value)
  }

  function setLastUsedCalendarId(value: string): void {
    lastUsedCalendarId.value = value
    localStorage.setItem(LAST_USED_CALENDAR_STORAGE_KEY, value)
  }

  function setCalendarSortOrder(value: CalendarSortOrder): void {
    calendarSortOrder.value = value
    localStorage.setItem(SORT_ORDER_STORAGE_KEY, value)
  }

  function setTimeFormat(value: TimeFormat): void {
    timeFormat.value = value
    localStorage.setItem(TIME_FORMAT_STORAGE_KEY, value)
  }

  function setDefaultVisibleCalendarIds(ids: string[]): void {
    defaultVisibleCalendarIds.value = ids
    localStorage.setItem(DEFAULT_VISIBLE_CALENDARS_STORAGE_KEY, JSON.stringify(ids))
  }

  function setDefaultView(value: CalendarViewType): void {
    defaultView.value = value
    localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, value)
  }

  function setTheme(value: Theme): void {
    theme.value = value
    localStorage.setItem(THEME_STORAGE_KEY, value)
    applyTheme()
  }

  function setNowIndicator(value: boolean): void {
    nowIndicator.value = value
    localStorage.setItem(NOW_INDICATOR_STORAGE_KEY, String(value))
  }

  function setWeekNumbers(value: boolean): void {
    weekNumbers.value = value
    localStorage.setItem(WEEK_NUMBERS_STORAGE_KEY, String(value))
  }

  function setShowWeekends(value: boolean): void {
    showWeekends.value = value
    localStorage.setItem(SHOW_WEEKENDS_STORAGE_KEY, String(value))
  }

  function setScrollHour(value: number): void {
    scrollHour.value = value
    localStorage.setItem(SCROLL_HOUR_STORAGE_KEY, String(value))
  }

  function setDefaultEventLength(value: number): void {
    defaultEventLength.value = value
    localStorage.setItem(DEFAULT_EVENT_LENGTH_STORAGE_KEY, String(value))
  }

  function setDefaultReminder(value: number | null): void {
    defaultReminder.value = value
    if (value === null) localStorage.removeItem(DEFAULT_REMINDER_STORAGE_KEY)
    else localStorage.setItem(DEFAULT_REMINDER_STORAGE_KEY, String(value))
  }

  function setAddressFormat(value: AddressFormat): void {
    addressFormat.value = value
    localStorage.setItem(ADDRESS_FORMAT_STORAGE_KEY, value)
  }

  function setContactSortOrder(value: ContactSortOrder): void {
    contactSortOrder.value = value
    localStorage.setItem(CONTACT_SORT_ORDER_STORAGE_KEY, value)
  }

  return {
    weekStart,
    firstDay,
    setWeekStart,
    defaultCalendarId,
    setDefaultCalendarId,
    defaultCalendarMode,
    setDefaultCalendarMode,
    lastUsedCalendarId,
    setLastUsedCalendarId,
    calendarSortOrder,
    setCalendarSortOrder,
    timeFormat,
    setTimeFormat,
    defaultVisibleCalendarIds,
    setDefaultVisibleCalendarIds,
    defaultView,
    setDefaultView,
    theme,
    setTheme,
    nowIndicator,
    setNowIndicator,
    weekNumbers,
    setWeekNumbers,
    showWeekends,
    setShowWeekends,
    scrollHour,
    setScrollHour,
    defaultEventLength,
    setDefaultEventLength,
    defaultReminder,
    setDefaultReminder,
    addressFormat,
    setAddressFormat,
    contactSortOrder,
    setContactSortOrder,
  }
})
