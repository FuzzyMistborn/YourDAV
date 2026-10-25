import { describe, expect, it } from 'vitest'
import {
  applyContactInput,
  editCategories,
  emptyContactInput,
  ensureUid,
  MAX_PHOTO_BYTES,
  photoFromCard,
  renameCategory,
  replaceUid,
  splitVcf,
  vcardToContact,
} from './card.js'

const V3 = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:abc-123',
  'PRODID:-//Apple Inc.//iOS//EN',
  'FN:Jane Q. Doe',
  'N:Doe;Jane;Q.;Dr.;PhD',
  'ORG:Acme\\, Inc.;R&D',
  'TEL;TYPE=CELL,VOICE,PREF:+1 555 0100',
  'item1.EMAIL;TYPE=INTERNET:jane@example.com',
  'item1.X-ABLabel:Personal',
  'ADR;TYPE=HOME:;;1 Main St;Town;ST;12345;US',
  'BDAY:1990-01-02',
  'CATEGORIES:friends,work',
  'NOTE:line1\\nline2',
  'X-CUSTOM;FOO=bar:keep me',
  'PHOTO;ENCODING=b;TYPE=JPEG:QUJD',
  'END:VCARD',
  '',
].join('\r\n')

const V4 = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:urn:uuid:4fbe8971',
  'FN:Max Mustermann',
  'N:Mustermann;Max;;;',
  'TEL;TYPE="cell,voice";PREF=1:tel:+49-123',
  'BDAY:19850412',
  'PHOTO:data:image/png;base64,QUJD',
  'END:VCARD',
  '',
].join('\r\n')

describe('vcardToContact', () => {
  it('reads a 3.0 card', () => {
    const c = vcardToContact(V3, 'ab', 'id1', '/x.vcf', 'e1')
    expect(c.version).toBe('3.0')
    expect(c.uid).toBe('abc-123')
    expect(c.fullName).toBe('Jane Q. Doe')
    expect(c.name).toEqual({ family: 'Doe', given: 'Jane', additional: 'Q.', prefix: 'Dr.', suffix: 'PhD' })
    expect(c.org).toBe('Acme, Inc., R&D')
    expect(c.phones).toEqual([{ value: '+1 555 0100', types: ['cell', 'voice'], pref: true }])
    expect(c.emails[0]).toMatchObject({ value: 'jane@example.com', types: ['internet'] })
    expect(c.addresses[0]).toMatchObject({ street: '1 Main St', locality: 'Town', country: 'US', types: ['home'] })
    expect(c.birthday).toBe('1990-01-02')
    expect(c.categories).toEqual(['friends', 'work'])
    expect(c.notes).toBe('line1\nline2')
    expect(c.hasPhoto).toBe(true)
  })

  it('reads a 4.0 card with quoted TYPE, tel: URI and compact date', () => {
    const c = vcardToContact(V4, 'ab', 'id2', '/y.vcf', 'e2')
    expect(c.version).toBe('4.0')
    expect(c.phones).toEqual([{ value: '+49-123', types: ['cell', 'voice'], pref: true }])
    expect(c.birthday).toBe('1985-04-12')
    expect(photoFromCard(V4)?.mime).toBe('image/png')
  })

  it('falls back to N then ORG when FN is missing', () => {
    const c = vcardToContact('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nEND:VCARD\r\n', 'a', 'i', 'h', 'e')
    expect(c.fullName).toBe('Jane Doe')
  })

  it('unfolds continuation lines', () => {
    const c = vcardToContact('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Very Long\r\n  Name\r\nEND:VCARD\r\n', 'a', 'i', 'h', 'e')
    expect(c.fullName).toBe('Very Long Name')
  })
})

describe('applyContactInput', () => {
  function inputFrom(card: string) {
    const c = vcardToContact(card, 'a', 'i', 'h', 'e')
    return { ...emptyContactInput(), ...c }
  }

  it('preserves the version, UID, unknown properties and photo on edit', () => {
    const input = inputFrom(V3)
    input.nickname = 'JD'
    const out = applyContactInput(V3, input)
    expect(out).toContain('VERSION:3.0')
    expect(out).toContain('UID:abc-123')
    expect(out).toContain('PRODID:-//Apple Inc.//iOS//EN')
    expect(out).toContain('X-CUSTOM;FOO=bar:keep me')
    expect(out).toContain('PHOTO;ENCODING=b;TYPE=JPEG:QUJD')
    expect(out).toContain('NICKNAME:JD')
    expect(out.endsWith('END:VCARD\r\n')).toBe(true)
  })

  it('round-trips managed fields', () => {
    const out = applyContactInput(V3, inputFrom(V3))
    expect(vcardToContact(out, 'a', 'i', 'h', 'e')).toEqual(vcardToContact(V3, 'a', 'i', 'h', 'e'))
  })

  it('keeps a structured ORG line verbatim when the org text is unchanged', () => {
    const out = applyContactInput(V3, inputFrom(V3))
    expect(out).toContain('ORG:Acme\\, Inc.;R&D\r\n')
  })

  it('rewrites ORG when the org text is edited', () => {
    const input = inputFrom(V3)
    input.org = 'Globex'
    const out = applyContactInput(V3, input)
    expect(out).toContain('ORG:Globex\r\n')
    expect(out).not.toContain('R&D')
  })

  it('drops an orphaned group label when its managed property is removed', () => {
    const input = inputFrom(V3)
    input.emails = []
    const out = applyContactInput(V3, input)
    expect(out).not.toContain('X-ABLabel')
    expect(out).not.toContain('jane@example.com')
  })

  it('writes 4.0 syntax for a 4.0 card', () => {
    const input = inputFrom(V4)
    input.birthday = '1985-04-13'
    const out = applyContactInput(V4, input)
    expect(out).toContain('VERSION:4.0')
    expect(out).toContain('BDAY:19850413')
    expect(out).toContain('TEL;TYPE=cell,voice;PREF=1:+49-123')
  })

  it('replaces and removes the photo on request', () => {
    const input = inputFrom(V3)
    const replaced = applyContactInput(V3, { ...input, photo: 'data:image/png;base64,UVJT' })
    expect(replaced).toContain('PHOTO;ENCODING=b;TYPE=PNG:UVJT')
    expect(replaced).not.toContain('QUJD')
    const removed = applyContactInput(V3, { ...input, photo: null })
    expect(removed).not.toContain('PHOTO')
  })

  it('creates a new 3.0 card with a UID and escapes text', () => {
    const out = applyContactInput(null, {
      ...emptyContactInput(),
      name: { family: 'Doe', given: 'A;B', additional: '', prefix: '', suffix: '' },
      notes: 'a,b\nc',
    })
    expect(out).toMatch(/UID:[0-9a-f-]{36}/)
    expect(out).toContain('N:Doe;A\\;B;;;')
    expect(out).toContain('NOTE:a\\,b\\nc')
    expect(out).toContain('FN:A\\;B Doe')
  })

  it('folds long lines at 75 octets', () => {
    const out = applyContactInput(null, { ...emptyContactInput(), notes: 'x'.repeat(200) })
    for (const l of out.split('\r\n')) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75)
    expect(vcardToContact(out, 'a', 'i', 'h', 'e').notes).toBe('x'.repeat(200))
  })
})

describe('splitVcf / ensureUid', () => {
  it('splits multi-card files', () => {
    expect(splitVcf(V3 + V4)).toHaveLength(2)
  })
  it('adds a UID only when missing', () => {
    const noUid = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nEND:VCARD\r\n'
    const r = ensureUid(noUid, 'u1')
    expect(r.card).toContain('UID:u1')
    expect(ensureUid(V3).card).toBe(V3)
  })
})

describe('text escaping', () => {
  it('round-trips backslashes, semicolons, commas and newlines', () => {
    const notes = 'a\\b;c,d\ne'
    const out = applyContactInput(null, { ...emptyContactInput(), org: 'X', notes })
    expect(out).toContain(String.raw`NOTE:a\\b\;c\,d\ne`)
    expect(vcardToContact(out, 'a', 'i', 'h', 'e').notes).toBe(notes)
  })
})

describe('renameCategory', () => {
  it('renames only the CATEGORIES line and keeps everything else byte-for-byte', () => {
    const out = renameCategory(V3, 'friends', 'Close friends')!
    expect(out).toBe(V3.replace('CATEGORIES:friends,work', 'CATEGORIES:Close friends,work'))
  })

  it('merges into an existing group without duplicating', () => {
    expect(renameCategory(V3, 'friends', 'work')).toContain('CATEGORIES:work\r\n')
  })

  it('escapes commas in the new name and returns null when the card lacks the group', () => {
    expect(renameCategory(V3, 'work', 'a,b')).toContain('CATEGORIES:friends,a\\,b')
    expect(renameCategory(V3, 'nope', 'x')).toBeNull()
  })
})

describe('editCategories', () => {
  const card = (...lines: string[]) => ['BEGIN:VCARD', 'VERSION:3.0', 'UID:u', 'FN:X', ...lines, 'END:VCARD', ''].join('\r\n')

  it('adds a group to an existing CATEGORIES line and touches nothing else', () => {
    const before = card('CATEGORIES:friends', 'X-CUSTOM;FOO=bar:keep', 'NOTE:hi')
    const after = editCategories(before, { add: 'work' })
    expect(after).toBe(card('CATEGORIES:friends,work', 'X-CUSTOM;FOO=bar:keep', 'NOTE:hi'))
  })

  it('inserts a CATEGORIES line before END when the card has none', () => {
    expect(editCategories(card('NOTE:hi'), { add: 'work' })).toBe(card('NOTE:hi', 'CATEGORIES:work'))
  })

  it('keeps LF-only cards LF-only', () => {
    const lf = 'BEGIN:VCARD\nVERSION:3.0\nFN:X\nEND:VCARD\n'
    expect(editCategories(lf, { add: 'a' })).toBe('BEGIN:VCARD\nVERSION:3.0\nFN:X\nCATEGORIES:a\nEND:VCARD\n')
  })

  it('escapes commas in a new group name', () => {
    expect(editCategories(card(), { add: 'a,b' })).toContain('CATEGORIES:a\\,b')
  })

  it('returns null when the card is already in the group', () => {
    expect(editCategories(card('CATEGORIES:friends,work'), { add: 'work' })).toBeNull()
  })

  it('removes one group from several', () => {
    expect(editCategories(card('CATEGORIES:friends,work'), { remove: 'friends' })).toBe(card('CATEGORIES:work'))
  })

  it('drops the whole line when the last group is removed', () => {
    expect(editCategories(card('CATEGORIES:friends', 'NOTE:hi'), { remove: 'friends' })).toBe(card('NOTE:hi'))
  })

  it('returns null when removing a group the card is not in', () => {
    expect(editCategories(card('CATEGORIES:friends'), { remove: 'work' })).toBeNull()
    expect(editCategories(card(), { remove: 'work' })).toBeNull()
  })

  it('returns null when asked to do nothing', () => {
    expect(editCategories(card('CATEGORIES:a'), {})).toBeNull()
  })
})

describe('replaceUid', () => {
  it('swaps the UID and leaves the rest alone', () => {
    const out = replaceUid(V3, 'new-uid')
    expect(out).toContain('UID:new-uid\r\n')
    expect(out).not.toContain('abc-123')
    expect(out.replace('UID:new-uid', 'UID:abc-123')).toBe(V3)
  })

  it('adds a UID when the card has none', () => {
    const out = replaceUid('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nEND:VCARD\r\n', 'n1')
    expect(out).toContain('UID:n1')
  })
})

describe('photoOf size limit', () => {
  const card = (b64: string): string => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A\r\nPHOTO;ENCODING=b;TYPE=JPEG:${b64}\r\nEND:VCARD\r\n`

  it('returns a small photo', () => {
    expect(photoFromCard(card(Buffer.from('hello').toString('base64')))?.data.toString()).toBe('hello')
  })

  it('ignores a stored photo over the size limit', () => {
    const big = Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64')
    expect(photoFromCard(card(big))).toBeNull()
  })
})
