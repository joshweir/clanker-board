import {
  DragDropContext,
  Draggable,
  Droppable,
  type DragStart,
  type DragUpdate,
  type DropResult,
  type ResponderProvided,
} from '@hello-pangea/dnd'
import { getRouteApi, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

import { layoutBoard, type BoardColumn } from '../board-layout'
import { applyPlan, planMove, rankForDrop } from '../move'
import { subscribeToProjectEvents } from '../project-events'
import type { ApiClient } from '../api'

const route = getRouteApi('/projects/$slug')

// Coarse-snapshot convergence: upsert by id (idempotent), same contract as the
// project list (#27). Card order comes from layoutBoard, and labels are looked up
// by id, so list order here is irrelevant - keep it simple.
function upsertById<T extends { id: number }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]
}

// A drop persists as plain issue mutations - no move endpoint (#34): detach/attach
// the swapped axis labels, then PATCH rank (and state across the Done boundary).
// Any non-2xx rejects so the caller reverts the optimistic move. Ordering the label
// writes before the rank PATCH keeps each request independently idempotent.
async function persistMove(
  client: ApiClient,
  slug: string,
  number: number,
  plan: ReturnType<typeof planMove>,
): Promise<void> {
  const labelParam = (labelId: number) => ({ slug, number: String(number), labelId: String(labelId) })
  for (const labelId of plan.detach) {
    const res = await client.api.projects[':slug'].issues[':number'].labels[':labelId'].$delete({
      param: labelParam(labelId),
    })
    if (!res.ok) {
      throw new Error(`detach ${labelId} failed`)
    }
  }
  for (const labelId of plan.attach) {
    const res = await client.api.projects[':slug'].issues[':number'].labels[':labelId'].$put({
      param: labelParam(labelId),
    })
    if (!res.ok) {
      throw new Error(`attach ${labelId} failed`)
    }
  }
  const json = plan.state === undefined ? { rank: plan.rank } : { rank: plan.rank, state: plan.state }
  const res = await client.api.projects[':slug'].issues[':number'].$patch({
    param: { slug, number: String(number) },
    json,
  })
  if (!res.ok) {
    throw new Error('rank patch failed')
  }
}

const positionMessage = (title: string, column: BoardColumn, index: number): string =>
  `${title}, position ${index + 1} of ${column.cards.length} in ${column.title}`

export function ProjectBoard() {
  const { slug } = route.useParams()
  const initial = route.useLoaderData()
  const { client, fetchImpl } = route.useRouteContext()
  const [board, setBoard] = useState(initial.board)
  const [labels, setLabels] = useState(initial.labels)
  const [issues, setIssues] = useState(initial.issues)
  const [toast, setToast] = useState<string | null>(null)

  // Ids whose incoming SSE we ignore: the card being dragged (and until its move
  // persists), so a server echo cannot yank it mid-drag or flicker it before the
  // optimistic write reconciles (#34).
  const suppressed = useRef<Set<number>>(new Set())

  // The loader seeds board + labels + issues; the per-project SSE stream keeps the
  // board live so an issue created/updated by an agent (or another tab) re-lays-out
  // with no reload. A suppressed card's echoes are dropped until its drag settles.
  useEffect(
    () =>
      subscribeToProjectEvents(fetchImpl, slug, {
        onIssueChanged: (issue) =>
          setIssues((prev) => (suppressed.current.has(issue.id) ? prev : upsertById(prev, issue))),
        onIssueDeleted: (id) => setIssues((prev) => prev.filter((i) => i.id !== id)),
        onLabelChanged: (label) => setLabels((prev) => upsertById(prev, label)),
        onLabelDeleted: (id) => setLabels((prev) => prev.filter((l) => l.id !== id)),
        onBoardChanged: (next) => setBoard(next),
      }),
    [fetchImpl, slug],
  )

  // Auto-dismiss the revert toast so a transient failure does not linger.
  useEffect(() => {
    if (toast === null) {
      return
    }
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  const columns = layoutBoard(board.columnAxis, labels, issues)

  const onDragStart = useCallback(
    (start: DragStart, provided: ResponderProvided) => {
      const id = Number(start.draggableId)
      suppressed.current.add(id)
      const column = columns.find((c) => c.key === start.source.droppableId)
      const card = issues.find((i) => i.id === id)
      if (column && card) {
        provided.announce(
          `Picked up ${positionMessage(card.title, column, start.source.index)}. Use the arrow keys to move, space to drop.`,
        )
      }
    },
    [columns, issues],
  )

  const onDragUpdate = useCallback(
    (update: DragUpdate, provided: ResponderProvided) => {
      if (!update.destination) {
        provided.announce('Not over a column.')
        return
      }
      const column = columns.find((c) => c.key === update.destination?.droppableId)
      if (column) {
        provided.announce(`Now in ${column.title}, position ${update.destination.index + 1}.`)
      }
    },
    [columns],
  )

  const onDragEnd = useCallback(
    (result: DropResult, provided: ResponderProvided) => {
      const id = Number(result.draggableId)
      const release = () => suppressed.current.delete(id)
      const { destination, source } = result
      if (!destination) {
        provided.announce('Move cancelled.')
        release()
        return
      }
      if (destination.droppableId === source.droppableId && destination.index === source.index) {
        provided.announce('Move cancelled.')
        release()
        return
      }
      const target = columns.find((c) => c.key === destination.droppableId)
      const dragged = issues.find((i) => i.id === id)
      if (!target || !dragged) {
        release()
        return
      }
      const newRank = rankForDrop(target.cards, id, destination.index)
      const plan = planMove(dragged, target, board.columnAxis, newRank)
      const labelById = new Map(labels.map((l) => [l.id, l]))
      const optimistic = applyPlan(dragged, plan, labelById)
      setIssues((prev) => upsertById(prev, optimistic))
      provided.announce(`Dropped ${dragged.title} in ${target.title}, position ${destination.index + 1}.`)
      // Suppress this card's own echoes until the whole move persists, not just
      // until the drop: detach/attach/patch each republish issue.changed with an
      // INTERMEDIATE label set, which would flicker the card through a wrong column
      // mid-flight. The optimistic applyPlan already mirrors the server's final
      // state, and once released the next issue.changed reconciles (last-write-wins).
      void persistMove(client, slug, dragged.number, plan)
        .catch(() => {
          // Revert just this card (last-write-wins) - other cards may have moved
          // via SSE while the request was in flight, so do not clobber them.
          // ponytail: no move endpoint (#34), so a partial failure (e.g. detach
          // succeeded, patch rejected) can leave the server half-applied; the board
          // reconciles to server truth on that card's next issue.changed. Add a
          // transactional move endpoint if partial writes ever need atomic rollback.
          setIssues((prev) => upsertById(prev, dragged))
          setToast(`Could not move ${dragged.title} - reverted.`)
        })
        .finally(release)
    },
    [columns, board.columnAxis, labels, issues, client, slug],
  )

  return (
    <main className="board">
      <header className="board-header">
        <Link to="/">← Projects</Link>
        <h1>{slug}</h1>
      </header>
      <DragDropContext onDragStart={onDragStart} onDragUpdate={onDragUpdate} onDragEnd={onDragEnd}>
        <div className="board-columns">
          {columns.map((column) => (
            <Droppable droppableId={column.key} key={column.key}>
              {(dropProvided) => (
                <section
                  ref={dropProvided.innerRef}
                  {...dropProvided.droppableProps}
                  className="board-column"
                  aria-label={column.title}
                >
                  <div className="board-column-header">
                    <h2>{column.title}</h2>
                    <span className="board-column-count" aria-hidden="true">
                      {column.cards.length}
                    </span>
                  </div>
                  <ul className="board-cards">
                    {column.cards.map((card, index) => (
                      <Draggable draggableId={String(card.id)} index={index} key={card.id}>
                        {(dragProvided, snapshot) => (
                          <li
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            {...dragProvided.dragHandleProps}
                            className={snapshot.isDragging ? 'board-card dragging' : 'board-card'}
                          >
                            <span className="board-card-key">{card.key}</span>
                            <span className="board-card-title">{card.title}</span>
                          </li>
                        )}
                      </Draggable>
                    ))}
                    {dropProvided.placeholder}
                  </ul>
                </section>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>
      {toast === null ? null : (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
    </main>
  )
}
