import type { Issue, Label } from './api'

export interface BoardColumn {
  // Stable React key: label-<id> for axis columns, plus the two virtual columns.
  key: string
  title: string
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
    cards: [],
  }))
  const noStatus: BoardColumn = { key: 'no-status', title: 'No status', cards: [] }
  const done: BoardColumn = { key: 'done', title: 'Done', cards: [] }

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
    column.cards.sort((a, b) => a.rank.localeCompare(b.rank) || a.id - b.id)
  }
  return columns
}
