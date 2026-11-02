import { describe, expect, it } from 'vitest'
import { sortCalendars } from './calendarSort.js'

const cals = [{ displayName: 'Work' }, { displayName: 'Personal' }, { displayName: 'family' }]
const names = (l: { displayName: string }[]) => l.map((c) => c.displayName)

describe('sortCalendars', () => {
  it('keeps server order', () => {
    expect(names(sortCalendars(cals, 'server'))).toEqual(['Work', 'Personal', 'family'])
  })
  it('sorts A to Z', () => {
    expect(names(sortCalendars(cals, 'name-asc'))).toEqual(['family', 'Personal', 'Work'])
  })
  it('sorts Z to A', () => {
    expect(names(sortCalendars(cals, 'name-desc'))).toEqual(['Work', 'Personal', 'family'])
  })
  it('does not mutate the input', () => {
    const input = [...cals]
    sortCalendars(input, 'name-asc')
    expect(input).toEqual(cals)
  })
})
