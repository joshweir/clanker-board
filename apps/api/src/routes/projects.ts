import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import type { Db } from '../db/client';
import { findProjectBySlug, toProject } from '../db/queries';
import { boards, projects } from '../db/schema';
import type { EventBus } from '../events/bus';
import { jsonBody } from './openapi';

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

// drizzle-zod derives the base schemas from the Drizzle tables (#14); routes
// refine them. slug is derived (key.toLowerCase()), never stored (#18).
const projectRow = createSelectSchema(projects);

export const ProjectSchema = projectRow
  .extend({ slug: z.string().openapi({ example: 'demo' }) })
  .openapi('Project');

const CreateProjectSchema = createInsertSchema(projects, {
  key: z
    .string()
    .regex(
      KEY_PATTERN,
      'key must be 2-10 chars: an uppercase letter then uppercase letters/digits',
    )
    .openapi({ example: 'DEMO' }),
  name: (schema) => schema.min(1),
})
  .pick({ key: true, name: true })
  .openapi('CreateProject');

const RenameProjectSchema = CreateProjectSchema.pick({ name: true }).openapi(
  'RenameProject',
);

export const ErrorSchema = z.object({ error: z.string() }).openapi('Error');

const SlugParamSchema = z.object({
  slug: z
    .string()
    .openapi({ param: { name: 'slug', in: 'path' }, example: 'demo' }),
});

const listProjectsRoute = createRoute({
  method: 'get',
  path: '/projects',
  summary: 'List all projects',
  responses: {
    200: jsonBody(z.array(ProjectSchema), 'All projects on the instance'),
  },
});

const createProjectRoute = createRoute({
  method: 'post',
  path: '/projects',
  summary: 'Create a project',
  request: {
    body: {
      content: { 'application/json': { schema: CreateProjectSchema } },
      required: true,
    },
  },
  responses: {
    201: jsonBody(ProjectSchema, 'The created project'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    409: jsonBody(ErrorSchema, 'A project with this key already exists'),
  },
});

const getProjectRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}',
  summary: 'Fetch a project by slug (lowercased key)',
  request: { params: SlugParamSchema },
  responses: {
    200: jsonBody(ProjectSchema, 'The project'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
});

const renameProjectRoute = createRoute({
  method: 'patch',
  path: '/projects/{slug}',
  summary: 'Rename a project (key is immutable)',
  request: {
    params: SlugParamSchema,
    body: {
      content: { 'application/json': { schema: RenameProjectSchema } },
      required: true,
    },
  },
  responses: {
    200: jsonBody(ProjectSchema, 'The renamed project'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
});

const deleteProjectRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}',
  summary: 'Delete a project and all project-owned data',
  request: { params: SlugParamSchema },
  responses: {
    204: { description: 'Deleted' },
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
});

export function projectsRouter(db: Db, bus: EventBus) {
  return new OpenAPIHono({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400);
      }
    },
  })
    .openapi(listProjectsRoute, (c) => {
      const rows = db.select().from(projects).orderBy(projects.key).all();
      return c.json(rows.map(toProject), 200);
    })
    .openapi(createProjectRoute, (c) => {
      const { key, name } = c.req.valid('json');
      // Sync driver, single process: check-then-insert cannot interleave; the
      // ci-unique index on lower(key) is the storage-layer backstop.
      if (findProjectBySlug(db, key.toLowerCase())) {
        return c.json(
          { error: `A project with key "${key}" already exists` },
          409,
        );
      }
      // Every project owns exactly one board, created here so a board is always
      // available (#24); its column_axis starts empty (the '[]' column default).
      // One transaction keeps the invariant atomic: a project is never persisted
      // without its board (and vice-versa) even if the second insert fails.
      const row = db.transaction((tx) => {
        const created = tx
          .insert(projects)
          .values({ key, name })
          .returning()
          .get();
        tx.insert(boards).values({ projectId: created.id }).run();
        return created;
      });
      const project = toProject(row);
      bus.publishProjectChanged(project);
      return c.json(project, 201);
    })
    .openapi(getProjectRoute, (c) => {
      const row = findProjectBySlug(db, c.req.valid('param').slug);
      if (!row) {
        return c.json({ error: 'Project not found' }, 404);
      }
      return c.json(toProject(row), 200);
    })
    .openapi(renameProjectRoute, (c) => {
      const { slug } = c.req.valid('param');
      const { name } = c.req.valid('json');
      const row = db
        .update(projects)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(sql`lower(${projects.key}) = ${slug}`)
        .returning()
        .get();
      if (!row) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const project = toProject(row);
      bus.publishProjectChanged(project);
      return c.json(project, 200);
    })
    .openapi(deleteProjectRoute, (c) => {
      const { slug } = c.req.valid('param');
      // Project-owned data (issues, comments, labels, boards, edges) cascades
      // via ON DELETE CASCADE foreign keys as those tables land; actors are
      // instance-level and survive (#18). returning() gives the id to emit.
      const deleted = db
        .delete(projects)
        .where(sql`lower(${projects.key}) = ${slug}`)
        .returning()
        .get();
      if (!deleted) {
        return c.json({ error: 'Project not found' }, 404);
      }
      bus.publishProjectDeleted(deleted.id);
      return c.body(null, 204);
    });
}
