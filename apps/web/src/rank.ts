import { generateKeyBetween } from 'fractional-indexing'

// Client-owned in-between rank computation for board drags (#34). The server
// seeds ranks with the same fractional-indexing scheme (apps/api/src/domain/rank.ts),
// so every stored rank is a valid order key and generateKeyBetween can always
// insert strictly between two neighbors. `prev`/`next` are the ranks of the cards
// bracketing the drop position (null at the top/bottom of a column).
// ponytail: no rebalancer - keys lengthen as cards are repeatedly inserted between
// the same pair. Add a periodic column rebalance if key length ever matters.
export function rankBetween(prev: string | null, next: string | null): string {
  return generateKeyBetween(prev, next)
}
