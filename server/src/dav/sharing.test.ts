import { describe, expect, it } from 'vitest'

process.env.SESSION_SECRET ??= 'a'.repeat(64)

const { parseBaikalInvite, shareNameFollowsOwner } = await import('./sharing.js')
import type { RadicaleMapEntry } from './sharing.js'

// Captured from Baikal 0.11.1 after sharing a calendar: the owner comes back
// as a cs:user with an empty <cs:access/>, then the real recipients.
const INVITE = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
<d:response><d:href>/dav.php/calendars/testuser/cal/</d:href><d:propstat><d:prop><cs:invite>
<cs:user><cs:invite-accepted/><cs:access/><d:href>/dav.php/principals/testuser</d:href></cs:user>
<cs:user><cs:invite-invalid/><cs:access><cs:read/></cs:access><d:href>mailto:nobody@example.com</d:href><cs:common-name>nobody@example.com</cs:common-name></cs:user>
<cs:user><cs:invite-accepted/><cs:access><cs:read-write/></cs:access><d:href>mailto:shareduser@example.com</d:href><cs:common-name>shareduser@example.com</cs:common-name></cs:user>
</cs:invite></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`

const hrefs = (xml: string) => parseBaikalInvite(xml).map((u) => u['d:href']?._text)

describe('parseBaikalInvite', () => {
  it('drops the owner entry (empty cs:access) but keeps recipients, including invalid ones', () => {
    expect(hrefs(INVITE)).toEqual(['mailto:nobody@example.com', 'mailto:shareduser@example.com'])
  })

  it('handles a single recipient (xml-js gives an object, not an array)', () => {
    const xml = `<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><cs:invite>
<cs:user><cs:access><cs:read/></cs:access><d:href>mailto:a@example.com</d:href></cs:user></cs:invite></d:multistatus>`
    expect(hrefs(xml)).toEqual(['mailto:a@example.com'])
  })

  it('returns [] when the server reports no invite property', () => {
    expect(parseBaikalInvite('<d:multistatus xmlns:d="DAV:"/>')).toEqual([])
  })
})

describe('shareNameFollowsOwner', () => {
  const entry = (name?: string | null): RadicaleMapEntry => ({
    Properties: name === undefined ? null : { 'D:displayname': name as string },
  })

  it('follows the owner when no name was stashed', () => {
    expect(shareNameFollowsOwner(entry(), 'Work')).toBe(true)
  })

  it('follows the owner while the stashed name is still the owner\'s previous name', () => {
    expect(shareNameFollowsOwner(entry('Work'), 'Work')).toBe(true)
  })

  it('leaves a name the recipient chose for themselves alone', () => {
    expect(shareNameFollowsOwner(entry('My Work'), 'Work')).toBe(false)
  })

  it('leaves a stashed name alone when the previous name is unknown', () => {
    expect(shareNameFollowsOwner(entry('Work'), null)).toBe(false)
  })
})
