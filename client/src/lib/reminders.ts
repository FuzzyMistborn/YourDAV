import { t } from '../i18n.js'

// Shared by EventEditDialog's per-event reminder picker and the settings
// dialog's "Default reminder" select, so both offer the same choices. A
// function (not a constant) so the labels follow the active language.
export function reminderPresets(): { label: string; minutes: number }[] {
  return [
    { label: t('reminder.preset.atTime'), minutes: 0 },
    { label: t('reminder.preset.m5'), minutes: 5 },
    { label: t('reminder.preset.m10'), minutes: 10 },
    { label: t('reminder.preset.m15'), minutes: 15 },
    { label: t('reminder.preset.m30'), minutes: 30 },
    { label: t('reminder.preset.h1'), minutes: 60 },
    { label: t('reminder.preset.d1'), minutes: 1440 },
  ]
}
