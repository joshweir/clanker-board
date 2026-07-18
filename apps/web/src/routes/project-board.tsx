import { getRouteApi, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { layoutBoard } from '../board-layout'
import { subscribeToProjectEvents } from '../project-events'

const route = getRouteApi('/projects/$slug')

// Coarse-snapshot convergence: upsert by id (idempotent), same contract as the
// project list (#27). Card order comes from layoutBoard, and labels are looked up
// by id, so list order here is irrelevant - keep it simple.
function upsertById<T extends { id: number }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]
}

export function ProjectBoard() {
  const { slug } = route.useParams()
  const initial = route.useLoaderData()
  const { fetchImpl } = route.useRouteContext()
  const [board, setBoard] = useState(initial.board)
  const [labels, setLabels] = useState(initial.labels)
  const [issues, setIssues] = useState(initial.issues)

  // The loader seeds board + labels + issues; the per-project SSE stream keeps the
  // board live so an issue created/updated by an agent (or another tab) re-lays-out
  // with no reload. Read-only for this ticket: no drag, no editing (#34/#36).
  useEffect(
    () =>
      subscribeToProjectEvents(fetchImpl, slug, {
        onIssueChanged: (issue) => setIssues((prev) => upsertById(prev, issue)),
        onIssueDeleted: (id) => setIssues((prev) => prev.filter((i) => i.id !== id)),
        onLabelChanged: (label) => setLabels((prev) => upsertById(prev, label)),
        onLabelDeleted: (id) => setLabels((prev) => prev.filter((l) => l.id !== id)),
        onBoardChanged: (next) => setBoard(next),
      }),
    [fetchImpl, slug],
  )

  const columns = layoutBoard(board.columnAxis, labels, issues)

  return (
    <main className="board">
      <header className="board-header">
        <Link to="/">← Projects</Link>
        <h1>{slug}</h1>
      </header>
      <div className="board-columns">
        {columns.map((column) => (
          <section key={column.key} className="board-column" aria-label={column.title}>
            <div className="board-column-header">
              <h2>{column.title}</h2>
              <span className="board-column-count" aria-hidden="true">
                {column.cards.length}
              </span>
            </div>
            <ul className="board-cards">
              {column.cards.map((card) => (
                <li key={card.id} className="board-card">
                  <span className="board-card-key">{card.key}</span>
                  <span className="board-card-title">{card.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
