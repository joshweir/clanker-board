// Coarse-snapshot convergence, shared across the board, the issues list, and the
// issue modal (#33/#36): upsert by id so a redelivered issue/label/comment.changed
// is idempotent. Callers that need a stable order sort after upserting.
export function upsertById<T extends { id: number }>(list: T[], item: T): T[] {
  return list.some(x => x.id === item.id)
    ? list.map(x => (x.id === item.id ? item : x))
    : [...list, item]
}
