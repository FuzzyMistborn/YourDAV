/** One vCard content line, kept alongside its original (folded) text so untouched lines round-trip byte-for-byte. */
export interface VProp {
  group: string
  /** Uppercased. */
  name: string
  /** Uppercased param names; values with surrounding quotes removed, split on commas. */
  params: Record<string, string[]>
  /** Raw value, still escaped. */
  value: string
  /** Original physical line(s), including any fold continuations, without the trailing CRLF. */
  raw: string
}

export interface ParsedCard {
  props: VProp[]
}

/** Splits `s` on unescaped, unquoted `sep`. */
function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    if (ch === sep && !quoted) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function parseLine(raw: string, unfolded: string): VProp | null {
  // The name/params/value boundary is the first colon outside a quoted param value.
  let quoted = false
  let colon = -1
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon <= 0) return null

  const [head, ...paramParts] = splitUnquoted(unfolded.slice(0, colon), ';')
  const dot = head.indexOf('.')
  const group = dot === -1 ? '' : head.slice(0, dot)
  const name = (dot === -1 ? head : head.slice(dot + 1)).toUpperCase()

  const params: Record<string, string[]> = {}
  for (const part of paramParts) {
    const eq = part.indexOf('=')
    // vCard 2.1 bare params (`TEL;CELL:`) mean TYPE=CELL.
    const key = (eq === -1 ? 'TYPE' : part.slice(0, eq)).toUpperCase()
    const rawVal = eq === -1 ? part : part.slice(eq + 1)
    let values = splitUnquoted(rawVal, ',').map((v) => v.replace(/^"|"$/g, ''))
    // vCard 4.0 allows TYPE="cell,voice" -- one quoted value holding a list.
    if (key === 'TYPE') values = values.flatMap((v) => v.split(','))
    params[key] = [...(params[key] ?? []), ...values]
  }
  return { group, name, params, value: unfolded.slice(colon + 1), raw }
}

export function parseVCard(text: string): ParsedCard {
  // Group physical lines into logical ones: a line starting with space/tab continues the previous.
  const physical = text.split(/\r\n|\n|\r/)
  const logical: { raw: string; unfolded: string }[] = []
  for (const line of physical) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && logical.length > 0) {
      const last = logical[logical.length - 1]
      last.raw += `\r\n${line}`
      last.unfolded += line.slice(1)
    } else if (line !== '') {
      logical.push({ raw: line, unfolded: line })
    }
  }

  const props: VProp[] = []
  for (const l of logical) {
    const p = parseLine(l.raw, l.unfolded)
    if (p) props.push(p)
  }
  return { props }
}

export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
}

/** Splits a structured value (N, ADR) on unescaped `;` and unescapes each part. */
export function splitStructured(s: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i] + s[i + 1]
      i++
    } else if (s[i] === ';') {
      parts.push(unescapeText(cur))
      cur = ''
    } else {
      cur += s[i]
    }
  }
  parts.push(unescapeText(cur))
  return parts
}

/** Splits a comma-list value (CATEGORIES) on unescaped `,`. */
export function splitList(s: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      cur += s[i] + s[i + 1]
      i++
    } else if (s[i] === ',') {
      parts.push(unescapeText(cur))
      cur = ''
    } else {
      cur += s[i]
    }
  }
  parts.push(unescapeText(cur))
  return parts.filter((p) => p !== '')
}

/** Folds a content line at 75 octets, never splitting a multi-byte character. */
export function foldLine(line: string): string {
  const bytes = Buffer.byteLength(line)
  if (bytes <= 75) return line
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  let limit = 75
  for (const ch of line) {
    const b = Buffer.byteLength(ch)
    if (curBytes + b > limit) {
      out.push(cur)
      cur = ''
      curBytes = 0
      limit = 74 // continuation lines lose one octet to the leading space
    }
    cur += ch
    curBytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}
