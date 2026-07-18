// Fractional ranks are lexicographically-ordered strings so an issue can be
// reordered by rewriting one row (no renumbering). The server only ever needs to
// APPEND to the end on create; the client computes in-between ranks when a user
// drags a card and PATCHes the resulting string. Digits are ASCII-ordered, so
// SQLite's default BINARY collation sorts ranks identically to this module.
// ponytail: append-only generator; upgrade to a full fractional-indexing
// generateKeyBetween(a, b) here if the server ever needs to compute midpoints.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
// Start mid-range so there is room for the client to insert before the first card.
const FIRST = DIGITS[Math.floor(DIGITS.length / 2)] ?? '0'

// Returns a rank string that sorts strictly after `prev`, or a mid-range start
// when the project has no issues yet.
export function rankAfter(prev: string | null): string {
  if (prev === null || prev === '') {
    return FIRST
  }
  const lastChar = prev[prev.length - 1] ?? ''
  const idx = DIGITS.indexOf(lastChar)
  const next = DIGITS[idx + 1]
  if (idx >= 0 && next !== undefined) {
    // Bump the final digit: same length, strictly greater.
    return prev.slice(0, -1) + next
  }
  // Final digit is already the maximum (or unrecognised): extend, which is
  // strictly greater because `prev` is a proper prefix of the result.
  return prev + FIRST
}
