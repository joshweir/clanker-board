import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-zod'

import type { Db } from '../db/client'
import { ColumnAxisSchema, findBoard, findProjectBySlug, toBoard } from '../db/queries'
import { boards, labels } from '../db/schema'
import type { EventBus } from '../events/bus'
import { jsonBody, SlugParamSchema } from './openapi'
import { ErrorSchema } from './projects'

// drizzle-zod derives the base schema from the Drizzle table (#14); the stored
// column_axis is JSON text, so the snapshot overrides it with the parsed number[]
// (mirrors ProjectSchema overriding with the derived slug).
const boardRow = createSelectSchema(boards)

export const BoardSchema = boardRow
  .extend({ columnAxis: ColumnAxisSchema })
  .openapi('Board')

// A PATCH replaces the WHOLE axis (#24). Duplicate label ids are rejected here; the
// per-project membership check happens in the handler (it needs the DB).
const UpdateBoardSchema = z
  .object({
    columnAxis: ColumnAxisSchema.refine(
      (ids) => new Set(ids).size === ids.length,
      'column_axis must not contain duplicate label ids',
    ),
  })
  .openapi('UpdateBoard')

const getBoardRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/board',
  summary: "Fetch a project's board (its ordered column_axis of label ids)",
  request: { params: SlugParamSchema },
  responses: {
    200: jsonBody(BoardSchema, 'The board'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
})

const updateBoardRoute = createRoute({
  method: 'patch',
  path: '/projects/{slug}/board',
  summary: "Replace the board's whole column_axis of label ids",
  request: {
    params: SlugParamSchema,
    body: { content: { 'application/json': { schema: UpdateBoardSchema } }, required: true },
  },
  responses: {
    200: jsonBody(BoardSchema, 'The updated board'),
    400: jsonBody(ErrorSchema, 'Validation failure (duplicate or non-project label id)'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
})

// The board is a stored view configuration (#24): one per project, auto-created with
// it. GET reads it; PATCH replaces the whole axis and broadcasts board.changed.
export function boardRouter(db: Db, bus: EventBus) {
  return new OpenAPIHono({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400)
      }
    },
  })
    .openapi(getBoardRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const board = findBoard(db, project.id)
      if (!board) {
        return c.json({ error: 'Board not found' }, 404)
      }
      return c.json(toBoard(board), 200)
    })
    .openapi(updateBoardRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const { columnAxis } = c.req.valid('json')
      // Every axis id must be a label of THIS project (trust boundary) - the axis
      // must never reference another project's vocabulary or a stale/unknown id.
      const projectLabelIds = new Set(
        db
          .select({ id: labels.id })
          .from(labels)
          .where(eq(labels.projectId, project.id))
          .all()
          .map((r) => r.id),
      )
      const unknown = columnAxis.find((id) => !projectLabelIds.has(id))
      if (unknown !== undefined) {
        return c.json({ error: `Label ${unknown} does not belong to this project` }, 400)
      }
      const row = db
        .update(boards)
        .set({ columnAxis: JSON.stringify(columnAxis), updatedAt: new Date().toISOString() })
        .where(eq(boards.projectId, project.id))
        .returning()
        .get()
      if (!row) {
        return c.json({ error: 'Board not found' }, 404)
      }
      const board = toBoard(row)
      bus.publishBoardChanged(project.id, board)
      return c.json(board, 200)
    })
}
