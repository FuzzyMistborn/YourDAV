import { describe, expect, it } from 'vitest'
import { mapConcurrent } from './concurrency.js'

describe('mapConcurrent', () => {
  it('returns empty array when items are empty', async () => {
    const res = await mapConcurrent([], 5, async (x) => x)
    expect(res).toEqual([])
  })

  it('respects concurrency limit and preserves result order', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = [10, 20, 30, 40, 50]
    const res = await mapConcurrent(items, 2, async (val, idx) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return `${idx}:${val}`
    })
    expect(maxInFlight).toBe(2)
    expect(res).toEqual(['0:10', '1:20', '2:30', '3:40', '4:50'])
  })
})
