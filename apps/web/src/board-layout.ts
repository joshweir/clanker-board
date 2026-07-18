import type { Issue, Label } from './api'

export type ColumnKind = 'axis' | 'no-status' | 'done'

export interface BoardColumn {
  // Stable React key: label-<id> for axis columns, plus the two virtual columns.
  key: string
  title: string
  // The axis label bound to this column (axis columns only); null for the two
  // virtual columns. A drop reads this to swap the card's axis label (#34).
  labelId: number | null
  kind: ColumnKind
  cards: Issue[]
}

// Lay issues out into columns for the board (#33), a pure view over the loaded
// board axis, labels, and issues so it is trivially testable and re-runs on every
// SSE-driven state change. Columns are the axis labels in order, then a virtual
// "No status" catch-all (open issues carrying none of the axis labels), then
// "Done" (closed issues, regardless of labels). Cards sort by fractional rank
// (ascending), id as tiebreak.
export function layoutBoard(columnAxis: number[], labels: Label[], issues: Issue[]): BoardColumn[] {
  const labelName = new Map(labels.map((l) => [l.id, l.name]))
  const axisColumns: BoardColumn[] = columnAxis.map((id) => ({
    key: `label-${id}`,
    title: labelName.get(id) ?? `Label ${id}`,
    labelId: id,
    kind: 'axis',
    cards: [],
  }))
  const noStatus: BoardColumn = { key: 'no-status', title: 'No status', labelId: null, kind: 'no-status', cards: [] }
  const done: BoardColumn = { key: 'done', title: 'Done', labelId: null, kind: 'done', cards: [] }

  for (const issue of issues) {
    if (issue.state === 'closed') {
      done.cards.push(issue)
      continue
    }
    // First axis label (in axis order) the issue carries decides its column.
    const index = columnAxis.findIndex((id) => issue.labels.some((label) => label.id === id))
    const column = index === -1 ? noStatus : axisColumns[index]
    ;(column ?? noStatus).cards.push(issue)
  }

  const columns = [...axisColumns, noStatus, done]
  for (const column of columns) {
    // Byte-wise rank compare, not localeCompare: fractional-indexing keys sort by
    // raw code point (matching the server's SQLite BINARY collation), and
    // localeCompare would reorder mixed-case keys like 'Zz' vs 'a0'. id tiebreak
    // keeps order deterministic when two concurrent moves land the same rank (#34).
    column.cards.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id - b.id))
  }
  return columns
}
