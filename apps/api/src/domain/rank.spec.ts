import { describe, expect, test } from 'vitest'

import { rankAfter } from './rank'

describe('rankAfter', () => {
  test('produces a non-empty start rank for an empty project', () => {
    expect(rankAfter(null).length).toBeGreaterThan(0)
    expect(rankAfter('')).toBe(rankAfter(null))
  })

  test('each successive rank sorts strictly after the previous one', () => {
    let prev = rankAfter(null)
    const ranks = [prev]
    for (let i = 0; i < 500; i++) {
      const next = rankAfter(prev)
      expect(next > prev).toBe(true)
      ranks.push(next)
      prev = next
    }
    // Appending in generation order must equal sorting lexicographically.
    expect([...ranks].sort()).toEqual(ranks)
  })

  test('extends length once the final digit is exhausted', () => {
    // 'z' is the maximum digit; the next rank must still sort after it.
    expect(rankAfter('z') > 'z').toBe(true)
  })
})
