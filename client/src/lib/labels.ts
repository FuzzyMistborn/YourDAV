import type { PostalAddress, StructuredName } from '@yourdav/shared'
import { currentLocale, i18n, t } from '../i18n.js'

export const PHONE_TYPES = ['cell', 'home', 'work', 'fax', 'voice', 'pager'] as const
export const EMAIL_TYPES = ['home', 'work', 'internet'] as const
export const URL_TYPES = ['home', 'work'] as const
export const ADDRESS_TYPES = ['home', 'work'] as const

/** First recognised type for the select; unknown/empty maps to ''. */
export function primaryType(types: string[], known: readonly string[]): string {
  return types.find((x) => known.includes(x)) ?? ''
}

export function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase() + s.slice(1)
}

/** Display name for a type value ("cell" -> "Mobile", "home" -> "Home"); unknown types are just capitalised. */
export function typeName(type: string): string {
  const key = `contactType.${type}`
  return i18n.global.te(key) ? t(key) : capitalize(type)
}

export function typeLabel(types: string[]): string {
  const t = types.filter((x) => x !== 'internet' && x !== 'voice')
  const shown = t.length ? t : types
  return shown.map(typeName).join(', ')
}

/** "1990-01-02" -> "January 2, 1990" (in the active language); "--01-02" -> "January 2". Unparseable input is returned as-is. */
export function formatDate(v: string): string {
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  const noYear = /^--(\d{2})-(\d{2})$/.exec(v)
  if (full) {
    return new Date(Date.UTC(+full[1], +full[2] - 1, +full[3])).toLocaleDateString(currentLocale(), {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }
  if (noYear) {
    return new Date(Date.UTC(2000, +noYear[1] - 1, +noYear[2])).toLocaleDateString(currentLocale(), {
      timeZone: 'UTC',
      month: 'long',
      day: 'numeric',
    })
  }
  return v
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const a = parts[0].charAt(0)
  const b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : ''
  return (a + b).toLocaleUpperCase()
}

/** Stable hue from a string, so a contact keeps its avatar colour. */
export function hueFor(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

/** Downscales an image file to a square-ish JPEG data URI so cards stay small on the server. */
export async function imageToDataUri(file: File, maxSide = 256): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(t('labels.chooseImage'))
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(t('labels.imageFailed'))
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

/** Mirrors the server's rule for the FN it generates when no display name is given. */
export function autoName(n: StructuredName, org: string): string {
  const assembled = [n.prefix, n.given, n.additional, n.family, n.suffix].filter((x) => x.trim()).join(' ')
  return assembled || org.trim()
}

/** The lines of an address, ordered for a US ("city, state ZIP") or international ("postal code city") reader. */
export function addressLines(a: PostalAddress, format: 'us' | 'intl'): string[] {
  const cityLine =
    format === 'us'
      ? [[a.locality, a.region].filter(Boolean).join(', '), a.postalCode].filter(Boolean).join(' ')
      : [[a.postalCode, a.locality].filter(Boolean).join(' '), a.region].filter(Boolean).join(', ')
  return [a.poBox, a.street, a.extended, cityLine, a.country].filter(Boolean)
}
