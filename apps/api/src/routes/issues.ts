import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, asc, eq, max } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

import type { Db } from '../db/client'
import { findIssue, findProjectBySlug, labelsForIssue, toIssue } from '../db/queries'
import { actors, issues } from '../db/schema'
import { rankAfter } from '../domain/rank'
import type { EventBus } from '../events/bus'
import { LabelSchema } from './labels'
import { jsonBody } from './openapi'
import { ErrorSchema } from './projects'

// drizzle-zod derives the base schema from the Drizzle table (#14); the route adds
// the derived KEY-N handle (project key + per-project number, never stored - #18)
// and the issue's attached labels (#24).
export const IssueSchema = createSelectSchema(issues)
  .extend({ key: z.string().openapi({ example: 'DEMO-1' }), labels: z.array(LabelSchema) })
  .openapi('Issue')

const CreateIssueSchema = createInsertSchema(issues, {
  title: (schema) => schema.min(1),
  type: (schema) => schema.min(1, 'type is required'),
  body: (schema) => schema.optional(),
})
  .pick({ title: true, type: true, body: true })
  .openapi('CreateIssue')

// Every field optional (PATCH semantics): absent = unchanged. Derived from the
// table (#14) so state's enum stays single-sourced; assigneeId is nullable so
// null explicitly unassigns while absent leaves it be.
const PatchIssueSchema = createInsertSchema(issues, {
  title: (schema) => schema.min(1),
  type: (schema) => schema.min(1),
  rank: (schema) => schema.min(1),
})
  .pick({ title: true, body: true, type: true, state: true, rank: true, assigneeId: true })
  .partial()
  .openapi('PatchIssue')

const SlugParamSchema = z.object({
  slug: z.string().openapi({ param: { name: 'slug', in: 'path' }, example: 'demo' }),
})

const IssueParamSchema = SlugParamSchema.extend({
  number: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'number', in: 'path' }, example: 1 }),
})

const listIssuesRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/issues',
  summary: "List a project's issues in rank order",
  request: { params: SlugParamSchema },
  responses: {
    200: jsonBody(z.array(IssueSchema), 'The project issues, ordered by rank'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
})

const createIssueRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/issues',
  summary: 'Create an issue (assigns the next per-project number)',
  request: {
    params: SlugParamSchema,
    body: { content: { 'application/json': { schema: CreateIssueSchema } }, required: true },
  },
  responses: {
    201: jsonBody(IssueSchema, 'The created issue'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
})

const getIssueRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/issues/{number}',
  summary: 'Fetch an issue by its per-project number',
  request: { params: IssueParamSchema },
  responses: {
    200: jsonBody(IssueSchema, 'The issue'),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
})

const patchIssueRoute = createRoute({
  method: 'patch',
  path: '/projects/{slug}/issues/{number}',
  summary: 'Update an issue (title, body, type, state, rank, assignee)',
  request: {
    params: IssueParamSchema,
    body: { content: { 'application/json': { schema: PatchIssueSchema } }, required: true },
  },
  responses: {
    200: jsonBody(IssueSchema, 'The updated issue'),
    400: jsonBody(ErrorSchema, 'Validation failure or unknown assignee'),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
})

const deleteIssueRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/issues/{number}',
  summary: 'Delete an issue',
  request: { params: IssueParamSchema },
  responses: {
    204: { description: 'Deleted' },
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
})

export function issuesRouter(db: Db, bus: EventBus) {
  return new OpenAPIHono({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400)
      }
    },
  })
    .openapi(listIssuesRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const rows = db
        .select()
        .from(issues)
        .where(eq(issues.projectId, project.id))
        .orderBy(asc(issues.rank), asc(issues.number))
        .all()
      return c.json(
        rows.map((row) => toIssue(row, project.key, labelsForIssue(db, row.id))),
        200,
      )
    })
    .openapi(createIssueRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const { title, type, body } = c.req.valid('json')
      // Sync driver, single process: this max()-then-insert cannot interleave, so
      // numbering stays sequential; the (project_id, number) unique index is the
      // storage-layer backstop. rankAfter appends to the end of the rank order.
      const agg = db
        .select({ maxNumber: max(issues.number), maxRank: max(issues.rank) })
        .from(issues)
        .where(eq(issues.projectId, project.id))
        .get()
      const number = (agg?.maxNumber ?? 0) + 1
      const rank = rankAfter(agg?.maxRank ?? null)
      const row = db
        .insert(issues)
        .values({ projectId: project.id, number, title, type, body: body ?? '', rank })
        .returning()
        .get()
      // A brand-new issue has no labels yet.
      const issue = toIssue(row, project.key, [])
      bus.publishIssueChanged(project.id, issue)
      return c.json(issue, 201)
    })
    .openapi(getIssueRoute, (c) => {
      const { slug, number } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const row = findIssue(db, project.id, number)
      if (!row) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      return c.json(toIssue(row, project.key, labelsForIssue(db, row.id)), 200)
    })
    .openapi(patchIssueRoute, (c) => {
      const { slug, number } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      if (!findIssue(db, project.id, number)) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      const patch = c.req.valid('json')
      // Reject an assignee that is not a real actor (trust boundary); null is a
      // valid value meaning "unassigned".
      if (patch.assigneeId !== undefined && patch.assigneeId !== null) {
        const actor = db.select().from(actors).where(eq(actors.id, patch.assigneeId)).get()
        if (!actor) {
          return c.json({ error: `No actor with id ${patch.assigneeId}` }, 400)
        }
      }
      const row = db
        .update(issues)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(and(eq(issues.projectId, project.id), eq(issues.number, number)))
        .returning()
        .get()
      if (!row) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      const issue = toIssue(row, project.key, labelsForIssue(db, row.id))
      bus.publishIssueChanged(project.id, issue)
      return c.json(issue, 200)
    })
    .openapi(deleteIssueRoute, (c) => {
      const { slug, number } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const deleted = db
        .delete(issues)
        .where(and(eq(issues.projectId, project.id), eq(issues.number, number)))
        .returning()
        .get()
      if (!deleted) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      bus.publishIssueDeleted(project.id, deleted.id, deleted.number)
      return c.body(null, 204)
    })
}
