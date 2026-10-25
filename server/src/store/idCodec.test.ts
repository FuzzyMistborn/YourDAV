import { describe, expect, it } from 'vitest'
import { InvalidIdError } from './errors.js'
import { decodeId, decodeUrlId, encodeId } from './idCodec.js'

describe('idCodec', () => {
  it('round-trips a URL', () => {
    expect(decodeUrlId(encodeId('https://dav.example/cal/'))).toBe('https://dav.example/cal/')
  })

  it('rejects invalid UTF-8', () => {
    expect(() => decodeId(Buffer.from([0xff, 0xfe]).toString('base64url'))).toThrow(InvalidIdError)
  })

  it('rejects an id that is not an absolute URL', () => {
    expect(() => decodeUrlId(encodeId('not a url'))).toThrow(InvalidIdError)
  })
})
