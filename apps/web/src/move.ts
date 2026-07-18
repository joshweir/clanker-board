import type { Issue, Label } from './api'
import type { BoardColumn } from './board-layout'
import { rankBetween } from './rank'

// A board drop persists as plain issue mutations - there is no move endpoint (#34).
// planMove turns "card dropped into column at rank R" into the exact set of label
// attach/detach calls plus the issue PATCH (rank, and state when a Done boundary is
// crossed). The board places a card by the FIRST axis label it carries (#33), so a
// column change swaps that axis label: detach the old axis label(s), attach the new.
export interface MovePlan {
  rank: string
  attach: number[]
  detach: number[]
  // Present only when the move crosses the Done boundary; absent = leave state be.
  state?: Issue['state']
}

// Compute the rank of a drop: strictly between the cards that will bracket it once
// the dragged card is removed (hello-pangea/dnd destination.index is post-removal).
export function rankForDrop(
  targetCards: Issue[],
  draggedId: number,
  destIndex: number
): string {
  const without = targetCards.filter(card => card.id !== draggedId)
  const prev = without[destIndex - 1]?.rank ?? null
  const next = without[destIndex]?.rank ?? null
  return rankBetween(prev, next)
}

// Reorder the board's column axis (#35): move the axis label at `from` to `to`,
// returning a new array. Only the real axis columns are reorderable, and they are
// the first columns the board lays out (#33), so a column Draggable's index maps
// straight onto its columnAxis index. The result PATCHes the WHOLE axis; other
// clients converge off board.changed. An out-of-range `from` is a no-op guard.
export function reorderColumnAxis(
  axis: number[],
  from: number,
  to: number
): number[] {
  const next = [...axis]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) {
    return axis
  }
  next.splice(to, 0, moved)
  return next
}

// Special-column semantics:
// - into Done: close, keep every label (so reopening restores the column).
// - out of Done into a real/No-status column: reopen (state=open).
// - into an axis column: carry exactly that column's label (swap any other axis
//   label, including a stale one kept while closed).
// - into No status: clear all axis labels so the card carries none.
// Non-axis labels are never touched.
export function planMove(
  issue: Issue,
  target: BoardColumn,
  columnAxis: number[],
  newRank: string
): MovePlan {
  const axisSet = new Set(columnAxis)
  const currentAxisLabelIds = issue.labels
    .filter(label => axisSet.has(label.id))
    .map(label => label.id)
  const plan: MovePlan = { rank: newRank, attach: [], detach: [] }

  if (target.kind === 'done') {
    if (issue.state !== 'closed') {
      plan.state = 'closed'
    }
    return plan
  }

  // Any move out of a real/No-status column implies the card is open.
  if (issue.state === 'closed') {
    plan.state = 'open'
  }

  if (target.kind === 'no-status' || target.labelId === null) {
    plan.detach = currentAxisLabelIds
    return plan
  }

  const targetId = target.labelId
  plan.detach = currentAxisLabelIds.filter(id => id !== targetId)
  if (!issue.labels.some(label => label.id === targetId)) {
    plan.attach = [targetId]
  }
  return plan
}

// The optimistic issue after a plan is applied, so the board reflects the move
// instantly before the PATCH/attach/detach round-trips resolve (#34).
export function applyPlan(
  issue: Issue,
  plan: MovePlan,
  labelById: Map<number, Label>
): Issue {
  const detached = new Set(plan.detach)
  let labels = issue.labels.filter(label => !detached.has(label.id))
  for (const id of plan.attach) {
    const label = labelById.get(id)
    if (label && !labels.some(existing => existing.id === id)) {
      labels = [...labels, label]
    }
  }
  return { ...issue, rank: plan.rank, state: plan.state ?? issue.state, labels }
}
