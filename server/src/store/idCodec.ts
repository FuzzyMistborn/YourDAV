import { InvalidIdError } from './errors.js'

export function encodeId(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url')
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

export function decodeId(id: string): string {
  try {
    return strictUtf8.decode(Buffer.from(id, 'base64url'))
  } catch {
    throw new InvalidIdError('Malformed id')
  }
}

/** Like decodeId, for ids that encode a collection URL: the result must parse as an absolute URL. */
export function decodeUrlId(id: string): string {
  const decoded = decodeId(id)
  try {
    new URL(decoded)
  } catch {
    throw new InvalidIdError('Malformed id')
  }
  return decoded
}
