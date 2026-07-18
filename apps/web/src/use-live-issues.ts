import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import { subscribeToProjectEvents } from './project-events'
import { upsertById } from './upsert'
import type { Board, Issue, Label } from './api'

// The board and the issues list both seed issues + labels from their loader, then
// converge live off the same per-project SSE stream: upsert-by-id on issue/label
// changes, drop on delete (#33). This hook owns that shared state + subscription so
// the two views share one editing surface without duplicating the wiring (#37).
//
// `ignoreIssueChange` lets the board suppress a dragged card's own echoes mid-move
// (#34); `onBoardChanged` forwards board.changed so the board keeps ONE stream
// instead of opening a second just for its axis. The issues list needs neither.
export interface LiveIssuesHooks {
  ignoreIssueChange?: (issue: Issue) => boolean
  onBoardChanged?: (board: Board) => void
}

export interface LiveIssues {
  issues: Issue[]
  setIssues: Dispatch<SetStateAction<Issue[]>>
  labels: Label[]
}

export function useLiveIssues(
  fetchImpl: typeof fetch,
  slug: string,
  initial: { issues: Issue[]; labels: Label[] },
  hooks?: LiveIssuesHooks,
): LiveIssues {
  const [issues, setIssues] = useState(initial.issues)
  const [labels, setLabels] = useState(initial.labels)

  // A ref keeps the once-subscribed stream reading the latest hooks without
  // re-subscribing (and reopening the connection) on every render.
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks

  useEffect(
    () =>
      subscribeToProjectEvents(fetchImpl, slug, {
        onIssueChanged: (issue) =>
          setIssues((prev) => (hooksRef.current?.ignoreIssueChange?.(issue) ? prev : upsertById(prev, issue))),
        onIssueDeleted: (id) => setIssues((prev) => prev.filter((i) => i.id !== id)),
        onLabelChanged: (label) => setLabels((prev) => upsertById(prev, label)),
        onLabelDeleted: (id) => setLabels((prev) => prev.filter((l) => l.id !== id)),
        onBoardChanged: (next) => hooksRef.current?.onBoardChanged?.(next),
      }),
    [fetchImpl, slug],
  )

  return { issues, setIssues, labels }
}
