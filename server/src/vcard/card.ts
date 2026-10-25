import type {
  Contact,
  ContactInput,
  LabeledValue,
  PostalAddress,
  StructuredName,
} from '@yourdav/shared'
import {
  escapeText,
  foldLine,
  parseVCard,
  splitList,
  splitStructured,
  unescapeText,
  type VProp,
} from './parse.js'

/** Properties this app reads and rewrites; every other line on a card is preserved verbatim. */
const MANAGED = new Set([
  'FN',
  'N',
  'NICKNAME',
  'ORG',
  'TITLE',
  'EMAIL',
  'TEL',
  'URL',
  'ADR',
  'BDAY',
  'ANNIVERSARY',
  'NOTE',
  'CATEGORIES',
  'PHOTO',
])

type Version = '3.0' | '4.0'

function versionOf(props: VProp[]): Version {
  const v = props.find((p) => p.name === 'VERSION')?.value.trim()
  return v === '4.0' ? '4.0' : '3.0'
}

function first(props: VProp[], name: string): VProp | undefined {
  return props.find((p) => p.name === name)
}

function typesOf(p: VProp): { types: string[]; pref: boolean } {
  const raw = (p.params.TYPE ?? []).map((t) => t.toLowerCase())
  // 3.0 marks preference as TYPE=PREF; 4.0 as PREF=<1..100>.
  const pref = raw.includes('pref') || p.params.PREF !== undefined
  return { types: raw.filter((t) => t !== 'pref'), pref }
}

function labeled(props: VProp[], name: string): LabeledValue[] {
  return props
    .filter((p) => p.name === name)
    .map((p) => {
      const { types, pref } = typesOf(p)
      let value = unescapeText(p.value)
      if (name === 'TEL') value = value.replace(/^tel:/i, '')
      if (name === 'EMAIL') value = value.replace(/^mailto:/i, '')
      return { value, types, pref }
    })
}

function normalizeDate(v: string): string {
  const s = v.trim()
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (/^--\d{4}$/.test(s)) return `--${s.slice(2, 4)}-${s.slice(4, 6)}`
  if (/^--\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1] : ''
}

function emptyName(): StructuredName {
  return { family: '', given: '', additional: '', prefix: '', suffix: '' }
}

export function parseName(p: VProp | undefined): StructuredName {
  if (!p) return emptyName()
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] = splitStructured(p.value)
  return { family, given, additional, prefix, suffix }
}

/** Display name: FN when present, otherwise assembled from N. */
function displayName(fn: string, n: StructuredName, org: string): string {
  if (fn.trim()) return fn
  const assembled = [n.prefix, n.given, n.additional, n.family, n.suffix].filter(Boolean).join(' ')
  return assembled || org
}

/** Largest photo, in decoded bytes, that is ever read back out of a stored card. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024

function decodePhoto(base64: string): Buffer | null {
  // Check before decoding so an oversized stored value never gets allocated.
  if (base64.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 4) return null
  const data = Buffer.from(base64, 'base64')
  return data.byteLength > MAX_PHOTO_BYTES ? null : data
}

export function photoOf(props: VProp[]): { mime: string; data: Buffer } | null {
  const p = first(props, 'PHOTO')
  if (!p) return null
  const dataUri = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is.exec(p.value)
  if (dataUri) {
    const data = decodePhoto(dataUri[2])
    return data && { mime: dataUri[1], data }
  }
  const encoding = (p.params.ENCODING ?? []).join(',').toLowerCase()
  if (encoding === 'b' || encoding === 'base64') {
    const type = (p.params.TYPE ?? ['jpeg'])[0].toLowerCase()
    const mime = type.includes('/') ? type : `image/${type === 'jpg' ? 'jpeg' : type}`
    const data = decodePhoto(p.value)
    return data && { mime, data }
  }
  return null
}

/** The single string shown for an ORG property: its non-empty components joined by ", ". */
function orgText(p: VProp): string {
  return splitStructured(p.value).filter(Boolean).join(', ')
}

export function vcardToContact(text: string, addressBookId: string, id: string, href: string, etag: string): Contact {
  const { props } = parseVCard(text)
  const name = parseName(first(props, 'N'))
  const orgProp = first(props, 'ORG')
  const org = orgProp ? orgText(orgProp) : ''
  const fn = unescapeText(first(props, 'FN')?.value ?? '')

  const addresses: PostalAddress[] = props
    .filter((p) => p.name === 'ADR')
    .map((p) => {
      const [poBox = '', extended = '', street = '', locality = '', region = '', postalCode = '', country = ''] =
        splitStructured(p.value)
      return { types: typesOf(p).types, poBox, extended, street, locality, region, postalCode, country }
    })

  const categories = props.filter((p) => p.name === 'CATEGORIES').flatMap((p) => splitList(p.value))

  return {
    id,
    addressBookId,
    href,
    etag,
    uid: first(props, 'UID')?.value.trim() ?? '',
    version: versionOf(props),
    fullName: displayName(fn, name, org),
    name,
    nickname: unescapeText(first(props, 'NICKNAME')?.value ?? ''),
    org,
    title: unescapeText(first(props, 'TITLE')?.value ?? ''),
    emails: labeled(props, 'EMAIL'),
    phones: labeled(props, 'TEL'),
    urls: labeled(props, 'URL'),
    addresses,
    birthday: normalizeDate(first(props, 'BDAY')?.value ?? ''),
    anniversary: normalizeDate(first(props, 'ANNIVERSARY')?.value ?? ''),
    notes: unescapeText(first(props, 'NOTE')?.value ?? ''),
    categories: [...new Set(categories)],
    hasPhoto: photoOf(props) !== null,
  }
}

// --- writing -----------------------------------------------------------------

function typeParams(version: Version, types: string[], pref: boolean): string {
  const t = types.map((x) => x.toUpperCase().replace(/[^A-Z0-9-]/g, '')).filter(Boolean)
  let out = ''
  if (version === '3.0') {
    const all = pref ? [...t, 'PREF'] : t
    if (all.length) out += `;TYPE=${all.join(',')}`
  } else {
    if (t.length) out += `;TYPE=${t.map((x) => x.toLowerCase()).join(',')}`
    if (pref) out += ';PREF=1'
  }
  return out
}

function dateValue(version: Version, v: string): string {
  const s = v.trim()
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (full) return version === '4.0' ? `${full[1]}${full[2]}${full[3]}` : s
  const noYear = /^--(\d{2})-?(\d{2})$/.exec(s)
  if (noYear) return version === '4.0' ? `--${noYear[1]}${noYear[2]}` : `--${noYear[1]}-${noYear[2]}`
  return ''
}

function photoLine(version: Version, dataUri: string): string | null {
  const m = /^data:([^;,]+);base64,(.+)$/is.exec(dataUri)
  if (!m) return null
  const b64 = m[2].replace(/\s+/g, '')
  if (version === '4.0') return `PHOTO:data:${m[1]};base64,${b64}`
  const type = m[1].split('/')[1]?.toUpperCase().replace('JPG', 'JPEG') ?? 'JPEG'
  return `PHOTO;ENCODING=b;TYPE=${type}:${b64}`
}

/** Builds the managed content lines for `input`. Empty fields are omitted. */
function managedLines(
  version: Version,
  input: ContactInput,
  existingPhoto: VProp | undefined,
  existingOrg: VProp | undefined,
): string[] {
  const n = input.name
  const nameParts = [n.family, n.given, n.additional, n.prefix, n.suffix]
  const hasName = nameParts.some((x) => x.trim())
  const fn =
    input.fullName?.trim() ||
    [n.prefix, n.given, n.additional, n.family, n.suffix].filter((x) => x.trim()).join(' ') ||
    input.org.trim()

  const lines: string[] = []
  // FN is mandatory in 3.0 and 4.0; N is mandatory in 3.0.
  lines.push(`FN:${escapeText(fn)}`)
  if (hasName || version === '3.0') lines.push(`N:${nameParts.map(escapeText).join(';')}`)
  if (input.nickname.trim()) lines.push(`NICKNAME:${escapeText(input.nickname.trim())}`)
  if (input.org.trim()) {
    // ORG is structured (company;department). The UI edits one flat string, so
    // keep the stored line untouched unless the text actually changed.
    if (existingOrg && orgText(existingOrg) === input.org.trim()) lines.push(existingOrg.raw)
    else lines.push(`ORG:${escapeText(input.org.trim())}`)
  }
  if (input.title.trim()) lines.push(`TITLE:${escapeText(input.title.trim())}`)
  for (const e of input.emails) {
    if (e.value.trim()) lines.push(`EMAIL${typeParams(version, e.types, e.pref)}:${escapeText(e.value.trim())}`)
  }
  for (const t of input.phones) {
    if (t.value.trim()) lines.push(`TEL${typeParams(version, t.types, t.pref)}:${escapeText(t.value.trim())}`)
  }
  for (const u of input.urls) {
    if (u.value.trim()) lines.push(`URL${typeParams(version, u.types, u.pref)}:${escapeText(u.value.trim())}`)
  }
  for (const a of input.addresses) {
    const parts = [a.poBox, a.extended, a.street, a.locality, a.region, a.postalCode, a.country]
    if (parts.some((x) => x.trim())) {
      lines.push(`ADR${typeParams(version, a.types, false)}:${parts.map(escapeText).join(';')}`)
    }
  }
  const bday = dateValue(version, input.birthday)
  if (bday) lines.push(`BDAY:${bday}`)
  const ann = dateValue(version, input.anniversary)
  if (ann) lines.push(`ANNIVERSARY:${ann}`)
  if (input.notes.trim()) lines.push(`NOTE:${escapeText(input.notes)}`)
  const cats = [...new Set(input.categories.map((c) => c.trim()).filter(Boolean))]
  if (cats.length) lines.push(`CATEGORIES:${cats.map(escapeText).join(',')}`)

  if (input.photo === null) {
    // removed
  } else if (typeof input.photo === 'string') {
    const line = photoLine(version, input.photo)
    if (line) lines.push(line)
    else if (existingPhoto) lines.push(existingPhoto.raw)
  } else if (existingPhoto) {
    lines.push(existingPhoto.raw)
  }
  return lines
}

/**
 * Applies `input` to an existing card (or builds a new one from `null`).
 * Managed properties are regenerated; everything else -- X- properties, REV,
 * PRODID, KIND, IMPP, grouped extensions -- keeps its original text. The card's
 * VERSION is retained.
 */
export function applyContactInput(existing: string | null, input: ContactInput, newUid?: string): string {
  const props = existing ? parseVCard(existing).props : []
  const version = existing ? versionOf(props) : '3.0'

  // Groups used by managed properties (Apple's `item1.EMAIL` + `item1.X-ABLabel`):
  // drop the whole group, since the label would otherwise be orphaned.
  const removedGroups = new Set(props.filter((p) => MANAGED.has(p.name) && p.group).map((p) => p.group))

  const existingPhoto = props.find((p) => p.name === 'PHOTO')
  const existingOrg = props.find((p) => p.name === 'ORG')
  // Hrefs/photos kept verbatim only when the photo isn't being replaced; handled in managedLines.
  const kept = props.filter((p) => {
    if (p.name === 'BEGIN' || p.name === 'END' || p.name === 'VERSION') return false
    if (MANAGED.has(p.name)) return false
    if (p.group && removedGroups.has(p.group)) return false
    return true
  })

  const out: string[] = ['BEGIN:VCARD', `VERSION:${version}`]
  const uid = props.find((p) => p.name === 'UID')
  if (uid) {
    out.push(uid.raw)
  } else {
    out.push(`UID:${newUid ?? crypto.randomUUID()}`)
  }
  out.push(
    ...managedLines(version, input, existingPhoto, existingOrg).map((l) =>
      l === existingPhoto?.raw || l === existingOrg?.raw ? l : foldLine(l),
    ),
  )
  for (const p of kept) {
    if (p.name === 'UID') continue
    // REV is a last-modified stamp; refresh it.
    if (p.name === 'REV') continue
    out.push(p.raw)
  }
  out.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`)
  out.push('END:VCARD')
  return out.join('\r\n') + '\r\n'
}

/**
 * Renames (or, with `to` already present, merges) a category on a card, rewriting
 * only the CATEGORIES lines that mention it. Returns null when the card doesn't
 * have `from` or its line can't be located verbatim.
 */
export function renameCategory(text: string, from: string, to: string): string | null {
  let out = text
  let changed = false
  for (const p of parseVCard(text).props) {
    if (p.name !== 'CATEGORIES') continue
    const list = splitList(p.value)
    if (!list.includes(from)) continue
    const renamed = [...new Set(list.map((c) => (c === from ? to : c)))]
    const colon = p.raw.indexOf(':')
    const line = foldLine(`${p.raw.slice(0, colon).replace(/\r\n[ \t]/g, '')}:${renamed.map(escapeText).join(',')}`)
    if (!out.includes(p.raw)) return null
    out = out.replace(p.raw, () => line)
    changed = true
  }
  return changed ? out : null
}

/** Removes `p.raw` from `text` together with the line break that follows it. */
function dropLine(text: string, raw: string): string | null {
  const at = text.indexOf(raw)
  if (at === -1) return null
  const after = text.slice(at + raw.length)
  const brk = /^(\r\n|\n|\r)/.exec(after)
  return text.slice(0, at) + after.slice(brk ? brk[0].length : 0)
}

/**
 * Adds or removes one group on a card by touching only its CATEGORIES line(s);
 * every other byte of the card is left alone. Returns null when there is
 * nothing to change (already a member / not a member) or a line can't be
 * located verbatim.
 */
export function editCategories(text: string, change: { add?: string; remove?: string }): string | null {
  const props = parseVCard(text).props.filter((p) => p.name === 'CATEGORIES')
  const rewrite = (p: VProp, list: string[]): string =>
    foldLine(`${p.raw.slice(0, p.raw.indexOf(':')).replace(/\r\n[ \t]/g, '')}:${list.map(escapeText).join(',')}`)

  if (change.add) {
    const name = change.add
    if (props.some((p) => splitList(p.value).includes(name))) return null
    const first = props[0]
    if (first) {
      if (!text.includes(first.raw)) return null
      return text.replace(first.raw, () => rewrite(first, [...splitList(first.value), name]))
    }
    const end = /^END:VCARD/im.exec(text)
    if (!end) return null
    const nl = text.includes('\r\n') ? '\r\n' : '\n'
    return `${text.slice(0, end.index)}CATEGORIES:${escapeText(name)}${nl}${text.slice(end.index)}`
  }

  if (change.remove) {
    const name = change.remove
    let out = text
    let changed = false
    for (const p of props) {
      const list = splitList(p.value)
      if (!list.includes(name)) continue
      const rest = list.filter((c) => c !== name)
      if (rest.length === 0) {
        const dropped = dropLine(out, p.raw)
        if (dropped === null) return null
        out = dropped
      } else {
        if (!out.includes(p.raw)) return null
        out = out.replace(p.raw, () => rewrite(p, rest))
      }
      changed = true
    }
    return changed ? out : null
  }
  return null
}

/** Gives the card a different UID (inserting one if missing); used for copies so the two cards stay distinct. */
export function replaceUid(text: string, uid: string): string {
  const existing = parseVCard(text).props.find((p) => p.name === 'UID')
  if (existing && text.includes(existing.raw)) return text.replace(existing.raw, () => `UID:${uid}`)
  return ensureUid(text, uid).card
}

export function emptyContactInput(): ContactInput {
  return {
    name: emptyName(),
    nickname: '',
    org: '',
    title: '',
    emails: [],
    phones: [],
    urls: [],
    addresses: [],
    birthday: '',
    anniversary: '',
    notes: '',
    categories: [],
  }
}

/** Returns the raw UID of a card, or null. */
export function uidOf(text: string): string | null {
  return parseVCard(text).props.find((p) => p.name === 'UID')?.value.trim() || null
}

export function photoFromCard(text: string): { mime: string; data: Buffer } | null {
  return photoOf(parseVCard(text).props)
}

/**
 * Splits a multi-card .vcf into individual card strings. Cards are matched
 * BEGIN:VCARD ... END:VCARD, case-insensitively; stray text between is dropped.
 */
export function splitVcf(text: string): string[] {
  const cards: string[] = []
  const re = /BEGIN:VCARD[\s\S]*?END:VCARD/gi
  for (const m of text.matchAll(re)) {
    cards.push(m[0].replace(/\r\n|\n|\r/g, '\r\n') + '\r\n')
  }
  return cards
}

/** Guarantees the card has a UID (inserting one before END if missing); other lines are untouched. */
export function ensureUid(card: string, uid: string = crypto.randomUUID()): { card: string; uid: string } {
  const existing = uidOf(card)
  if (existing) return { card, uid: existing }
  return { card: card.replace(/END:VCARD/i, `UID:${uid}\r\nEND:VCARD`), uid }
}
