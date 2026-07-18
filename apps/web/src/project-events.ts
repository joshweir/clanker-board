import { z } from 'zod'
import type { Board, Comment, Issue, Label } from './api'
import { readEventStream } from './sse'

// Per-project SSE payloads, validated at the client boundary (no casts). Each
// `satisfies z.ZodType<T>` ties the snapshot shape to the API type, so a contract
// change fails to typecheck here rather than drifting silently (#27/#33).
const labelSnapshot = z.object({
  id: z.number(),
  projectId: z.number(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
}) satisfies z.ZodType<Label>

const issueSnapshot = z.object({
  id: z.number(),
  projectId: z.number(),
  number: z.number(),
  title: z.string(),
  type: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  rank: z.string(),
  assigneeId: z.number().nullable(),
  parentId: z.number().nullable(),
  key: z.string(),
  labels: z.array(labelSnapshot),
  blocked: z.boolean(),
  ready: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
}) satisfies z.ZodType<Issue>

const boardSnapshot = z.object({
  id: z.number(),
  projectId: z.number(),
  columnAxis: z.array(z.number()),
  createdAt: z.string(),
  updatedAt: z.string()
}) satisfies z.ZodType<Board>

// A comment snapshot is a flat log entry (#31): no derived fields, no updatedAt.
const commentSnapshot = z.object({
  id: z.number(),
  issueId: z.number(),
  actorId: z.number(),
  body: z.string(),
  createdAt: z.string()
}) satisfies z.ZodType<Comment>

// issue.deleted / label.deleted both carry the entity id (issue.deleted also a
// number, unused here - the board drops the card by id).
const deletedPayload = z.object({ id: z.number() })

// Every handler is optional so each consumer reacts to only the events it needs: the
// board wants issue/label/board changes (#33/#35); the issue modal wants this issue's
// issue.changed and comment.created (#36). Each call opens its own stream, so an open
// modal and the board behind it hold one connection each - fine at this scale.
export interface ProjectEventHandlers {
  onIssueChanged?: (issue: Issue) => void
  onIssueDeleted?: (id: number) => void
  onLabelChanged?: (label: Label) => void
  onLabelDeleted?: (id: number) => void
  onCommentCreated?: (comment: Comment) => void
  onBoardChanged?: (board: Board) => void
}

// Consume a project's stream through the shared fetch-based SSE reader (sse.ts).
// The board seeds from the loader, then converges live: upsert-by-id on
// issue/label changes and re-layout on board.changed keep redelivery idempotent,
// exactly as the instance stream does for the project list (#27). comment.created
// lands here too; the board ignores it, the issue modal appends it live (#36).
// Returns an unsubscribe that aborts the stream.
export function subscribeToProjectEvents(
  fetchImpl: typeof fetch,
  slug: string,
  handlers: ProjectEventHandlers
): () => void {
  const controller = new AbortController()
  void readEventStream(
    fetchImpl,
    `/api/projects/${encodeURIComponent(slug)}/events`,
    controller.signal,
    (event, data) => {
      switch (event) {
        case 'issue.changed':
          handlers.onIssueChanged?.(issueSnapshot.parse(data))
          break
        case 'issue.deleted':
          handlers.onIssueDeleted?.(deletedPayload.parse(data).id)
          break
        case 'label.changed':
          handlers.onLabelChanged?.(labelSnapshot.parse(data))
          break
        case 'label.deleted':
          handlers.onLabelDeleted?.(deletedPayload.parse(data).id)
          break
        case 'comment.created':
          handlers.onCommentCreated?.(commentSnapshot.parse(data))
          break
        case 'board.changed':
          handlers.onBoardChanged?.(boardSnapshot.parse(data))
          break
      }
    }
  )
  return () => {
    controller.abort()
  }
}
