import { describe, expect, test } from 'vitest'
import { rankBetween } from './rank'

// rankBetween shares fractional-indexing's default base-62 alphabet with the server
// seed (apps/api/src/domain/rank.ts), so every rank is byte-ordered the same way the
// board and SQLite sort them. `rankBetween(x, null)` mirrors the server's append.
describe('rankBetween', () => {
  test('inserts strictly between two appended neighbors', () => {
    const first = rankBetween(null, null)
    const second = rankBetween(first, null)
    const between = rankBetween(first, second)
    expect(first < between).toBe(true)
    expect(between < second).toBe(true)
  })

  test('open bounds place before the first / after the last card', () => {
    const only = rankBetween(null, null)
    expect(rankBetween(null, only) < only).toBe(true)
    expect(rankBetween(only, null) > only).toBe(true)
  })

  test('repeated inserts between the same pair stay strictly ordered', () => {
    let lo = rankBetween(null, null)
    const hi = rankBetween(lo, null)
    for (let i = 0; i < 50; i++) {
      const mid = rankBetween(lo, hi)
      expect(lo < mid && mid < hi).toBe(true)
      lo = mid
    }
  })
})
