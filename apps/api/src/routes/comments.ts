import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

import type { Db } from '../db/client'
import { commentsForIssue, findIssue, findProjectBySlug } from '../db/queries'
import { actors, comments } from '../db/schema'
import type { EventBus } from '../events/bus'
import { idParam, jsonBody, SlugParamSchema } from './openapi'
import { ErrorSchema } from './projects'

// drizzle-zod derives the base schema from the Drizzle table (#14). A comment is a
// flat, append-only log entry attributed to an actor (#24) - no derived fields.
export const CommentSchema = createSelectSchema(comments).openapi('Comment')

const CreateCommentSchema = createInsertSchema(comments, {
  body: (schema) => schema.min(1, 'body is required'),
})
  .pick({ actorId: true, body: true })
  .openapi('CreateComment')

const IssueParamSchema = SlugParamSchema.extend({ number: idParam('number') })

const listCommentsRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/issues/{number}/comments',
  summary: "List an issue's comments in chronological (append) order",
  request: { params: IssueParamSchema },
  responses: {
    200: jsonBody(z.array(CommentSchema), "The issue's comments, oldest first"),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
})

const createCommentRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/issues/{number}/comments',
  summary: 'Append a comment to an issue, attributed to an actor (append-only)',
  request: {
    params: IssueParamSchema,
    body: { content: { 'application/json': { schema: CreateCommentSchema } }, required: true },
  },
  responses: {
    201: jsonBody(CommentSchema, 'The created comment'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No such project, issue, or actor'),
  },
})

// Append-only, actor-attributed discussion log (#24): only list (GET) and append
// (POST) - deliberately no edit/delete routes, so the log stays auditable.
export function commentsRouter(db: Db, bus: EventBus) {
  return new OpenAPIHono({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400)
      }
    },
  })
    .openapi(listCommentsRoute, (c) => {
      const { slug, number } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const issue = findIssue(db, project.id, number)
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      return c.json(commentsForIssue(db, issue.id), 200)
    })
    .openapi(createCommentRoute, (c) => {
      const { slug, number } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const issue = findIssue(db, project.id, number)
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      const { actorId, body } = c.req.valid('json')
      // Reject an unknown actor (trust boundary): a comment must be attributed to a
      // real identity.
      const actor = db.select().from(actors).where(eq(actors.id, actorId)).get()
      if (!actor) {
        return c.json({ error: `No actor with id ${actorId}` }, 404)
      }
      const row = db.insert(comments).values({ issueId: issue.id, actorId, body }).returning().get()
      bus.publishCommentCreated(project.id, row)
      return c.json(row, 201)
    })
}
