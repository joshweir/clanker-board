import { generateKeyBetween } from 'fractional-indexing';

// Fractional ranks are lexicographically-ordered strings so an issue can be
// reordered by rewriting one row (no renumbering). The server only ever needs to
// APPEND to the end on create; the web client computes in-between ranks when a
// user drags a card (#34) and PATCHes the resulting string. Both sides share one
// scheme: fractional-indexing's default base-62 alphabet (0-9A-Za-z) is compared
// byte-for-byte, so SQLite's default BINARY collation sorts ranks identically and
// the client's generateKeyBetween(prev, next) always sees valid order keys.
// ponytail: no rebalancer; keys lengthen as cards are inserted between neighbors.
// Add a periodic rebalance (rewrite a column's ranks to short keys) if key growth
// ever becomes a concern - the byte ordering is unaffected by it.

// Returns a rank string that sorts strictly after `prev`, or a mid-range start
// when the project has no issues yet.
export function rankAfter(prev: string | null): string {
  return generateKeyBetween(prev === '' ? null : prev, null);
}
