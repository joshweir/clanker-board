import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

import type { Db } from '../db/client'
import { findIssue, findProjectBySlug, labelsForIssue, toIssue } from '../db/queries'
import { issueLabels, issues, labels } from '../db/schema'
import type { EventBus } from '../events/bus'
import { jsonBody } from './openapi'
import { ErrorSchema } from './projects'

// drizzle-zod derives the base schema from the Drizzle table (#14). Labels are
// strictly per-project (#24); the route is scoped under /projects/{slug}.
export const LabelSchema = createSelectSchema(labels).openapi('Label')

const LabelBodySchema = createInsertSchema(labels, {
  name: (schema) => schema.min(1, 'name is required'),
})
  .pick({ name: true })
  .openapi('LabelBody')

const SlugParamSchema = z.object({
  slug: z.string().openapi({ param: { name: 'slug', in: 'path' }, example: 'demo' }),
})

// Positive-integer path param (coerced from the string URL segment).
const idParam = (name: string) =>
  z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name, in: 'path' }, example: 1 })

const LabelParamSchema = SlugParamSchema.extend({ id: idParam('id') })

const AttachParamSchema = SlugParamSchema.extend({
  number: idParam('number'),
  labelId: idParam('labelId'),
})

// A label belongs to a project iff its projectId matches - the storage-layer guard
// against one project's vocabulary leaking into another (#24).
const findLabel = (db: Db, projectId: number, id: number) =>
  db
    .select()
    .from(labels)
    .where(and(eq(labels.projectId, projectId), eq(labels.id, id)))
    .get()

// Case-insensitive name lookup within a project - the app-level mirror of the
// (project_id, lower(name)) unique index, so a clash returns 409 not a raw 500.
const findLabelByName = (db: Db, projectId: number, name: string) =>
  db
    .select()
    .from(labels)
    .where(and(eq(labels.projectId, projectId), sql`lower(${labels.name}) = ${name.toLowerCase()}`))
    .get()

// Issue reads embed their labels, so a label rename/delete changes the snapshot of
// every issue it is attached to; re-publish those issue.changed events so open
// clients converge (#24). Call AFTER the label mutation so labelsForIssue reflects
// it (a rename shows the new name; a delete shows the label gone).
const republishIssuesWithLabel = (
  db: Db,
  bus: EventBus,
  project: { id: number; key: string },
  issueRows: (typeof issues.$inferSelect)[],
): void => {
  for (const row of issueRows) {
    bus.publishIssueChanged(project.id, toIssue(row, project.key, labelsForIssue(db, row.id)))
  }
}

const issuesWithLabel = (db: Db, labelId: number): (typeof issues.$inferSelect)[] =>
  db
    .select(getTableColumns(issues))
    .from(issues)
    .innerJoin(issueLabels, eq(issueLabels.issueId, issues.id))
    .where(eq(issueLabels.labelId, labelId))
    .all()

const listLabelsRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/labels',
  summary: "List a project's labels",
  request: { params: SlugParamSchema },
  responses: {
    200: jsonBody(z.array(LabelSchema), 'The project labels, ordered by name'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
})

const createLabelRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/labels',
  summary: 'Create a label in a project',
  request: {
    params: SlugParamSchema,
    body: { content: { 'application/json': { schema: LabelBodySchema } }, required: true },
  },
  responses: {
    201: jsonBody(LabelSchema, 'The created label'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
    409: jsonBody(ErrorSchema, 'A label with this name already exists in the project'),
  },
})

const renameLabelRoute = createRoute({
  method: 'patch',
  path: '/projects/{slug}/labels/{id}',
  summary: 'Rename a label',
  request: {
    params: LabelParamSchema,
    body: { content: { 'application/json': { schema: LabelBodySchema } }, required: true },
  },
  responses: {
    200: jsonBody(LabelSchema, 'The renamed label'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No such project or label'),
    409: jsonBody(ErrorSchema, 'A label with this name already exists in the project'),
  },
})

const deleteLabelRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/labels/{id}',
  summary: 'Delete a label (detaches it from every issue)',
  request: { params: LabelParamSchema },
  responses: {
    204: { description: 'Deleted' },
    404: jsonBody(ErrorSchema, 'No such project or label'),
  },
})

const attachLabelRoute = createRoute({
  method: 'put',
  path: '/projects/{slug}/issues/{number}/labels/{labelId}',
  summary: "Attach a label to an issue (idempotent), returning the issue's labels",
  request: { params: AttachParamSchema },
  responses: {
    200: jsonBody(z.array(LabelSchema), "The issue's labels after the attach"),
    404: jsonBody(ErrorSchema, 'No such project, issue, or label'),
  },
})

const detachLabelRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/issues/{number}/labels/{labelId}',
  summary: "Detach a label from an issue, returning the issue's labels",
  request: { params: AttachParamSchema },
  responses: {
    200: jsonBody(z.array(LabelSchema), "The issue's labels after the detach"),
    404: jsonBody(ErrorSchema, 'No such project, issue, or label'),
  },
})

export function labelsRouter(db: Db, bus: EventBus) {
  return new OpenAPIHono({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400)
      }
    },
  })
    .openapi(listLabelsRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const rows = db
        .select()
        .from(labels)
        .where(eq(labels.projectId, project.id))
        .orderBy(asc(labels.name))
        .all()
      return c.json(rows, 200)
    })
    .openapi(createLabelRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const { name } = c.req.valid('json')
      // Sync driver, single process: check-then-insert cannot interleave; the
      // (project_id, lower(name)) unique index is the storage-layer backstop.
      if (findLabelByName(db, project.id, name)) {
        return c.json({ error: `A label named "${name}" already exists in this project` }, 409)
      }
      const row = db.insert(labels).values({ projectId: project.id, name }).returning().get()
      bus.publishLabelChanged(project.id, row)
      return c.json(row, 201)
    })
    .openapi(renameLabelRoute, (c) => {
      const { slug, id } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      if (!findLabel(db, project.id, id)) {
        return c.json({ error: 'Label not found' }, 404)
      }
      const { name } = c.req.valid('json')
      const clash = findLabelByName(db, project.id, name)
      if (clash && clash.id !== id) {
        return c.json({ error: `A label named "${name}" already exists in this project` }, 409)
      }
      const row = db
        .update(labels)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(eq(labels.id, id))
        .returning()
        .get()
      if (!row) {
        return c.json({ error: 'Label not found' }, 404)
      }
      bus.publishLabelChanged(project.id, row)
      // A rename changes the label embedded in every issue that carries it.
      republishIssuesWithLabel(db, bus, project, issuesWithLabel(db, id))
      return c.json(row, 200)
    })
    .openapi(deleteLabelRoute, (c) => {
      const { slug, id } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      if (!findLabel(db, project.id, id)) {
        return c.json({ error: 'Label not found' }, 404)
      }
      // Capture the affected issues before the delete cascades the join rows away,
      // then re-publish them (labelsForIssue now excludes the deleted label).
      const affected = issuesWithLabel(db, id)
      db.delete(labels).where(eq(labels.id, id)).run()
      bus.publishLabelDeleted(project.id, id)
      republishIssuesWithLabel(db, bus, project, affected)
      return c.body(null, 204)
    })
    .openapi(attachLabelRoute, (c) => {
      const { slug, number, labelId } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const issue = findIssue(db, project.id, number)
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      if (!findLabel(db, project.id, labelId)) {
        return c.json({ error: 'Label not found' }, 404)
      }
      // Composite PK makes re-attaching the same label a no-op (idempotent).
      db.insert(issueLabels).values({ issueId: issue.id, labelId }).onConflictDoNothing().run()
      const attached = labelsForIssue(db, issue.id)
      bus.publishIssueChanged(project.id, toIssue(issue, project.key, attached))
      return c.json(attached, 200)
    })
    .openapi(detachLabelRoute, (c) => {
      const { slug, number, labelId } = c.req.valid('param')
      const project = findProjectBySlug(db, slug)
      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }
      const issue = findIssue(db, project.id, number)
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404)
      }
      if (!findLabel(db, project.id, labelId)) {
        return c.json({ error: 'Label not found' }, 404)
      }
      db.delete(issueLabels)
        .where(and(eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, labelId)))
        .run()
      const remaining = labelsForIssue(db, issue.id)
      bus.publishIssueChanged(project.id, toIssue(issue, project.key, remaining))
      return c.json(remaining, 200)
    })
}
