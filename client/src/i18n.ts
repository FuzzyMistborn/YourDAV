import { Settings } from 'luxon'
import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import fr from './locales/fr.json'

// To add a language: create locales/<code>.json with the same keys as
// en.json, register it in MESSAGES and LANGUAGES below, and (for the
// calendar grid's month/day names and buttons) import its FullCalendar locale
// in CalendarView.vue and add it to `locales`.
export type Locale = 'en' | 'fr'

// 'auto' follows the browser's language (navigator.languages) and falls back
// to English when none of them is supported.
export type LanguageSetting = 'auto' | Locale

export const LANGUAGE_STORAGE_KEY = 'app.language'

const MESSAGES = { en, fr }

/** Languages offered in Settings. Each is shown in its own name. */
export const LANGUAGES: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
]

function isLocale(code: string): code is Locale {
  return code in MESSAGES
}

/** First supported language in the browser's preference list, else English. */
export function detectLocale(): Locale {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLocale(base)) return base
  }
  return 'en'
}

export function resolveLocale(setting: LanguageSetting): Locale {
  return setting === 'auto' ? detectLocale() : setting
}

export function loadLanguageSetting(): LanguageSetting {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY)
  return stored !== null && isLocale(stored) ? stored : 'auto'
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(loadLanguageSetting()),
  fallbackLocale: 'en',
  messages: MESSAGES,
  // Plural forms are written "one | other". French uses the singular for 0 as well as 1.
  pluralRules: { fr: (choice) => (choice === 0 || choice === 1 ? 0 : 1) },
})

document.documentElement.lang = i18n.global.locale.value
// Luxon's toFormat month/weekday names follow this.
Settings.defaultLocale = i18n.global.locale.value

/** Translate outside a component (stores, lib/). Reactive: reads the live locale. */
export const t = i18n.global.t

/** The active locale, for Intl / toLocaleDateString (instead of `undefined`, which means "browser default"). */
export function currentLocale(): Locale {
  return i18n.global.locale.value
}

/** Weekday name for 0 = Sunday .. 6 = Saturday, in the active language (`style` as in Intl.DateTimeFormat). */
export function weekdayName(index: number, style: 'long' | 'short' | 'narrow' = 'short'): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(currentLocale(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + index)))
}

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  document.documentElement.lang = locale
  Settings.defaultLocale = locale
}
