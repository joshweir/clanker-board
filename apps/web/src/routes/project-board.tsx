import {
  DragDropContext,
  Draggable,
  Droppable,
  type DraggableProvidedDragHandleProps,
  type DragStart,
  type DragUpdate,
  type DropResult,
  type ResponderProvided,
} from '@hello-pangea/dnd'
import { getRouteApi, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'

import { layoutBoard, type BoardColumn } from '../board-layout'
import { FilterBar } from '../components/filter-bar'
import { IssueModal } from '../components/issue-modal'
import { ProjectTabs } from '../components/project-tabs'
import { matchesFilters, toFilters, toSearchValues, type Filters } from '../filters'
import { applyPlan, planMove, rankForDrop, reorderColumnAxis } from '../move'
import { upsertById } from '../upsert'
import { useLiveIssues } from '../use-live-issues'
import type { ApiClient, Issue, Label } from '../api'

// Which issue the detail modal is showing: an existing card by id (kept fresh from
// the live issues list) or create mode from the header's "New issue" button (#36).
type ActiveModal = { kind: 'edit'; id: number } | { kind: 'new' } | null

const route = getRouteApi('/projects/$slug')

// A quick-add creates an issue with this type (#28's create requires a non-empty,
// freeform type). "task" is the sensible board default; the card can be re-typed
// via the issue editor later.
const DEFAULT_ISSUE_TYPE = 'task'

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

// The optimistic new card carries the column's bound axis label immediately, so a
// quick-add lands in the right column before the label attach round-trips (#35).
// A "No status" quick-add passes labelId === null and keeps the card label-less.
function withAxisLabel(issue: Issue, labelId: number, labels: Label[]): Issue {
  const label = labels.find((l) => l.id === labelId)
  if (!label || issue.labels.some((l) => l.id === labelId)) {
    return issue
  }
  return { ...issue, labels: [...issue.labels, label] }
}

const positionMessage = (title: string, column: BoardColumn, index: number): string =>
  `${title}, position ${index + 1} of ${column.cards.length} in ${column.title}`

// Title-only inline quick-add (#35): Enter (the form submit) creates a card. A single
// text input submits on Enter natively, so no button is needed. Rendered at the top
// and bottom of every real/No-status column; each instance owns its own draft.
function QuickAdd({
  columnTitle,
  position,
  onAdd,
}: {
  columnTitle: string
  position: 'top' | 'bottom'
  onAdd: (title: string) => void
}) {
  const [title, setTitle] = useState('')
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      return
    }
    onAdd(trimmed)
    setTitle('')
  }
  return (
    <form className="quick-add" onSubmit={onSubmit}>
      <input
        className="quick-add-input"
        type="text"
        value={title}
        placeholder="Add a card"
        aria-label={`Add a card to the ${position} of ${columnTitle}`}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value)}
      />
    </form>
  )
}

export function ProjectBoard() {
  const { slug } = route.useParams()
  const initial = route.useLoaderData()
  const { client, fetchImpl } = route.useRouteContext()
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const [board, setBoard] = useState(initial.board)
  const [toast, setToast] = useState<string | null>(null)
  const [modal, setModal] = useState<ActiveModal>(null)

  // Ids whose incoming SSE we ignore: the card being dragged (and until its move
  // persists), so a server echo cannot yank it mid-drag or flicker it before the
  // optimistic write reconciles (#34).
  const suppressed = useRef<Set<number>>(new Set())

  // The loader seeds board + labels + issues; the shared live-issues hook keeps
  // labels/issues converging off the per-project SSE stream (the issues list uses
  // the same hook, #37). A suppressed card's echoes are dropped until its drag
  // settles, and board.changed re-lays-out the columns - both on the one stream.
  const { issues, setIssues, labels } = useLiveIssues(fetchImpl, slug, initial, {
    ignoreIssueChange: (issue) => suppressed.current.has(issue.id),
    onBoardChanged: setBoard,
  })

  // Auto-dismiss the revert toast so a transient failure does not linger.
  useEffect(() => {
    if (toast === null) {
      return
    }
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  // Filtering is a client-side view over the live issue set (#38): reduce which
  // cards show, then lay out the SAME axis columns - the board shape never
  // restructures. Hide Done is view structure, not a filter axis, so it drops the
  // Done COLUMN (default: hidden) rather than reducing cards. SSE upserts keep
  // flowing into `issues` underneath; this recomputes on every change.
  const filters = toFilters(search)
  const hideDone = search.hideDone ?? true
  const visibleIssues = issues.filter((issue) => matchesFilters(issue, filters))
  const allColumns = layoutBoard(board.columnAxis, labels, visibleIssues)
  const columns = hideDone ? allColumns.filter((column) => column.kind !== 'done') : allColumns

  // The type axis is freeform (#28), so its filter options are the distinct types in
  // the live set (sorted for a stable order), not a fixed enum.
  const types = [...new Set(issues.map((issue) => issue.type))].sort((a, b) => a.localeCompare(b))

  // A filter change rewrites only the axis query params (inactive axes collapse away,
  // keeping shared URLs clean); Hide Done is preserved (absent = its default, hidden).
  const hideDoneParam = (next: boolean) => (next ? undefined : false)
  const setFilters = (next: Filters) =>
    void navigate({ search: () => ({ ...toSearchValues(next), hideDone: hideDoneParam(hideDone) }) })
  const setHideDone = (next: boolean) =>
    void navigate({ search: () => ({ ...toSearchValues(filters), hideDone: hideDoneParam(next) }) })

  // A quick-add posts the issue, optimistically shows it in the target column, then
  // attaches the column's bound axis label (#35). The card's own echoes are suppressed
  // until the attach settles so the label-less create echo cannot flicker it out of
  // the target column, exactly as a drag suppresses its own intermediate echoes (#34).
  const handleQuickAdd = useCallback(
    (column: BoardColumn, title: string) => {
      void (async () => {
        let created: Issue | null = null
        try {
          const res = await client.api.projects[':slug'].issues.$post({
            param: { slug },
            json: { title, type: DEFAULT_ISSUE_TYPE },
          })
          if (!res.ok) {
            throw new Error('create failed')
          }
          const body = await res.json()
          if (!('number' in body)) {
            throw new Error('create failed')
          }
          created = body
          suppressed.current.add(created.id)
          const optimistic = column.labelId === null ? created : withAxisLabel(created, column.labelId, labels)
          setIssues((prev) => upsertById(prev, optimistic))
          if (column.labelId !== null) {
            const attach = await client.api.projects[':slug'].issues[':number'].labels[':labelId'].$put({
              param: { slug, number: String(created.number), labelId: String(column.labelId) },
            })
            if (!attach.ok) {
              throw new Error('attach failed')
            }
          }
        } catch {
          setToast(`Could not add a card to ${column.title}.`)
          // Create may have succeeded while the label attach failed: reconcile the
          // card to the server's actual (label-less) state so it does not linger in
          // the wrong column. If the create itself failed, there is nothing to undo.
          const c = created
          if (c) {
            setIssues((prev) => upsertById(prev, c))
          }
        } finally {
          if (created) {
            suppressed.current.delete(created.id)
          }
        }
      })()
    },
    [client, slug, labels, setIssues],
  )

  const onDragStart = useCallback(
    (start: DragStart, provided: ResponderProvided) => {
      if (start.type === 'column') {
        const column = columns.find((c) => c.key === start.draggableId)
        if (column) {
          provided.announce(
            `Picked up column ${column.title}, position ${start.source.index + 1} of ${board.columnAxis.length}. Use the left and right arrow keys to move, space to drop.`,
          )
        }
        return
      }
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
    [columns, issues, board.columnAxis.length],
  )

  const onDragUpdate = useCallback(
    (update: DragUpdate, provided: ResponderProvided) => {
      if (update.type === 'column') {
        if (!update.destination) {
          provided.announce('Not over a valid position.')
          return
        }
        const column = columns.find((c) => c.key === update.draggableId)
        if (column) {
          provided.announce(`Column ${column.title} is now in position ${update.destination.index + 1}.`)
        }
        return
      }
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

  const onColumnDragEnd = useCallback(
    (result: DropResult, provided: ResponderProvided) => {
      const { source, destination } = result
      if (!destination || destination.index === source.index) {
        provided.announce('Column move cancelled.')
        return
      }
      const column = columns.find((c) => c.key === result.draggableId)
      const nextAxis = reorderColumnAxis(board.columnAxis, source.index, destination.index)
      const previous = board
      // Optimistic re-layout, then PATCH the WHOLE axis; other open boards converge
      // off board.changed (#33). Our own board.changed just re-sets the same axis
      // (idempotent). On failure, restore the pre-move board and toast.
      setBoard({ ...board, columnAxis: nextAxis })
      provided.announce(`Column ${column?.title ?? ''} moved to position ${destination.index + 1}.`)
      void client.api.projects[':slug'].board
        .$patch({ param: { slug }, json: { columnAxis: nextAxis } })
        .then((res) => {
          if (!res.ok) {
            throw new Error('axis patch failed')
          }
        })
        .catch(() => {
          setBoard(previous)
          setToast('Could not reorder columns - reverted.')
        })
    },
    [columns, board, client, slug],
  )

  const onDragEnd = useCallback(
    (result: DropResult, provided: ResponderProvided) => {
      if (result.type === 'column') {
        onColumnDragEnd(result, provided)
        return
      }
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
      // ponytail: while filters are active, target.cards is the VISIBLE (filtered)
      // set, so a drop's rank is computed between its visible neighbours - a hidden
      // card between them keeps its old rank and may render out of the intended order
      // once filters clear (an accepted cosmetic limitation, #38). Rank against the
      // full column set (fetch/hold unfiltered neighbours) if exact ordering matters.
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
    [columns, board.columnAxis, labels, issues, client, slug, onColumnDragEnd, setIssues],
  )

  // One column section (header + top/bottom quick-add + its card Droppable). Real
  // axis columns receive the column drag handle; the virtual columns pass null so
  // only the reorderable axis columns are draggable (#35). Done omits quick-add.
  const renderColumnSection = (column: BoardColumn, dragHandleProps: DraggableProvidedDragHandleProps | null) => (
    <Droppable droppableId={column.key} key={column.key}>
      {(dropProvided) => (
        <section
          ref={dropProvided.innerRef}
          {...dropProvided.droppableProps}
          className="board-column"
          aria-label={column.title}
        >
          <div className="board-column-header">
            {dragHandleProps ? (
              <span className="column-drag-handle" {...dragHandleProps} aria-label={`Reorder ${column.title} column`}>
                <span aria-hidden="true">⣿</span>
              </span>
            ) : null}
            <h2>{column.title}</h2>
            <span className="board-column-count" aria-hidden="true">
              {column.cards.length}
            </span>
          </div>
          {column.kind === 'done' ? null : (
            <QuickAdd columnTitle={column.title} position="top" onAdd={(title) => handleQuickAdd(column, title)} />
          )}
          <ul className="board-cards">
            {column.cards.length === 0 ? <li className="board-empty">No cards</li> : null}
            {column.cards.map((card, index) => (
              <Draggable draggableId={String(card.id)} index={index} key={card.id}>
                {(dragProvided, snapshot) => (
                  // @hello-pangea/dnd spreads a runtime role="button" + tabIndex onto
                  // this element (the drag handle: Space lifts, arrows move), so it is a
                  // genuine interactive control - a plain click/Enter (which the drag
                  // sensor leaves alone) opens the detail modal (#36). The a11y lint
                  // rule can't see the spread role, hence the scoped disable below.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                  <li
                    ref={dragProvided.innerRef}
                    {...dragProvided.draggableProps}
                    {...dragProvided.dragHandleProps}
                    className={snapshot.isDragging ? 'board-card dragging' : 'board-card'}
                    onClick={() => setModal({ kind: 'edit', id: card.id })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        setModal({ kind: 'edit', id: card.id })
                      }
                    }}
                  >
                    <span className="board-card-key">{card.key}</span>
                    <span className="board-card-title">{card.title}</span>
                  </li>
                )}
              </Draggable>
            ))}
            {dropProvided.placeholder}
          </ul>
          {column.kind === 'done' ? null : (
            <QuickAdd columnTitle={column.title} position="bottom" onAdd={(title) => handleQuickAdd(column, title)} />
          )}
        </section>
      )}
    </Droppable>
  )

  return (
    <main className="board">
      <header className="board-header">
        <Link to="/">← Projects</Link>
        <h1>{slug}</h1>
        <ProjectTabs slug={slug} />
        <button type="button" className="new-issue" onClick={() => setModal({ kind: 'new' })}>
          New issue
        </button>
      </header>
      <FilterBar filters={filters} types={types} labels={labels} actors={initial.actors} onChange={setFilters}>
        <label className="filter-option">
          <input type="checkbox" checked={hideDone} onChange={() => setHideDone(!hideDone)} />
          Hide Done
        </label>
      </FilterBar>
      <DragDropContext onDragStart={onDragStart} onDragUpdate={onDragUpdate} onDragEnd={onDragEnd}>
        <Droppable droppableId="board" direction="horizontal" type="column">
          {(boardProvided) => (
            <div ref={boardProvided.innerRef} {...boardProvided.droppableProps} className="board-columns">
              {columns.map((column, columnIndex) =>
                // Only the real axis columns are reorderable; they are the first
                // columns laid out, so their column index equals their columnAxis
                // index. The virtual "No status" and "Done" columns render fixed (#35).
                column.kind === 'axis' ? (
                  <Draggable draggableId={column.key} index={columnIndex} key={column.key}>
                    {(colProvided) => (
                      <div
                        ref={colProvided.innerRef}
                        {...colProvided.draggableProps}
                        className="board-column-draggable"
                      >
                        {renderColumnSection(column, colProvided.dragHandleProps)}
                      </div>
                    )}
                  </Draggable>
                ) : (
                  renderColumnSection(column, null)
                ),
              )}
              {boardProvided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
      {toast === null ? null : (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
      {modal !== null ? (
        // Edit mode resolves the card from the live issues list so the modal opens
        // on a current snapshot (and closes itself if the card was deleted); create
        // mode passes null. labels/issues feed the sidebar pickers (#36).
        (() => {
          const editing = modal.kind === 'edit' ? issues.find((i) => i.id === modal.id) : null
          if (modal.kind === 'edit' && !editing) {
            return null
          }
          return (
            <IssueModal
              client={client}
              fetchImpl={fetchImpl}
              slug={slug}
              issue={editing ?? null}
              labels={labels}
              issues={issues}
              onClose={() => setModal(null)}
            />
          )
        })()
      ) : null}
    </main>
  )
}
