import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { and, asc, eq, max } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import type { Db } from '../db/client';
import {
  blockersOf,
  childrenOf,
  dependentsOf,
  findIssue,
  findIssueById,
  findProjectBySlug,
  toIssue,
} from '../db/queries';
import { actors, issues } from '../db/schema';
import { newlyMentionedTargets } from '../domain/mentions';
import { rankAfter } from '../domain/rank';
import type { EventBus } from '../events/bus';
import { withEvents } from '../events/with-events';
import type { ActorEnv } from '../middleware/actor';
import { LabelSchema } from './labels';
import { idParam, jsonBody, SlugParamSchema } from './openapi';
import { ErrorSchema } from './projects';

// drizzle-zod derives the base schema from the Drizzle table (#14); the route adds
// the derived KEY-N handle (project key + per-project number, never stored - #18)
// and the issue's attached labels (#24).
export const IssueSchema = createSelectSchema(issues)
  .extend({
    key: z.string().openapi({ example: 'DEMO-1' }),
    labels: z.array(LabelSchema),
    // The issue's declared blockers (#30): a thin handle per blocking issue, enough
    // to render and remove it. Derived from the blocked-by edges: see toIssue.
    blockers: z.array(
      z.object({
        number: z.number().openapi({ example: 2 }),
        title: z.string().openapi({ example: 'Ship the API' }),
        state: z.enum(['open', 'closed']).openapi({ example: 'open' }),
        key: z.string().openapi({ example: 'DEMO-2' }),
      }),
    ),
    // Derived relationship state (#30), never stored: see toIssue.
    blocked: z.boolean().openapi({ example: false }),
    ready: z.boolean().openapi({ example: true }),
  })
  .openapi('Issue');

const CreateIssueSchema = createInsertSchema(issues, {
  title: (schema) => schema.min(1),
  type: (schema) => schema.min(1, 'type is required'),
  body: (schema) => schema.optional(),
})
  .pick({ title: true, type: true, body: true })
  .openapi('CreateIssue');

// Every field optional (PATCH semantics): absent = unchanged. Derived from the
// table (#14) so state's enum stays single-sourced; assigneeId is nullable so
// null explicitly unassigns while absent leaves it be.
const PatchIssueSchema = createInsertSchema(issues, {
  title: (schema) => schema.min(1),
  type: (schema) => schema.min(1),
  rank: (schema) => schema.min(1),
})
  .pick({
    title: true,
    body: true,
    type: true,
    state: true,
    rank: true,
    assigneeId: true,
  })
  .partial()
  .openapi('PatchIssue');

const IssueParamSchema = SlugParamSchema.extend({ number: idParam('number') });

// Server-side list filters so agents (and hooks, e.g. a session-end claim
// release) can query without pulling the whole project: assignee ('unassigned'
// or an actor id), the derived ready flag, a label name (case-insensitive), a
// freeform type, and state. All optional and combinable (AND semantics).
const ListIssuesQuerySchema = z.object({
  assigneeId: z
    .string()
    .regex(/^(unassigned|[1-9]\d*)$/, 'must be "unassigned" or an actor id')
    .optional()
    .openapi({ example: 'unassigned' }),
  ready: z.enum(['true', 'false']).optional().openapi({ example: 'true' }),
  label: z.string().min(1).optional().openapi({ example: 'ready-for-agent' }),
  type: z.string().min(1).optional().openapi({ example: 'task' }),
  state: z.enum(['open', 'closed']).optional().openapi({ example: 'open' }),
});

const listIssuesRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/issues',
  summary: "List a project's issues in rank order (optionally filtered)",
  request: { params: SlugParamSchema, query: ListIssuesQuerySchema },
  responses: {
    200: jsonBody(z.array(IssueSchema), 'The project issues, ordered by rank'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
});

const createIssueRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/issues',
  summary: 'Create an issue (assigns the next per-project number)',
  request: {
    params: SlugParamSchema,
    body: {
      content: { 'application/json': { schema: CreateIssueSchema } },
      required: true,
    },
  },
  responses: {
    201: jsonBody(IssueSchema, 'The created issue'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
});

const getIssueRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/issues/{number}',
  summary: 'Fetch an issue by its per-project number',
  request: { params: IssueParamSchema },
  responses: {
    200: jsonBody(IssueSchema, 'The issue'),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
});

const patchIssueRoute = createRoute({
  method: 'patch',
  path: '/projects/{slug}/issues/{number}',
  summary: 'Update an issue (title, body, type, state, rank, assignee)',
  request: {
    params: IssueParamSchema,
    body: {
      content: { 'application/json': { schema: PatchIssueSchema } },
      required: true,
    },
  },
  responses: {
    200: jsonBody(IssueSchema, 'The updated issue'),
    400: jsonBody(ErrorSchema, 'Validation failure or unknown assignee'),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
});

const deleteIssueRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/issues/{number}',
  summary: 'Delete an issue',
  request: { params: IssueParamSchema },
  responses: {
    204: { description: 'Deleted' },
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
});

export function issuesRouter(db: Db, bus: EventBus) {
  return new OpenAPIHono<ActorEnv>({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400);
      }
    },
  })
    .openapi(listIssuesRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const query = c.req.valid('query');
      const rows = db
        .select()
        .from(issues)
        .where(eq(issues.projectId, project.id))
        .orderBy(asc(issues.rank), asc(issues.number))
        .all();
      // Filter over the derived snapshots (ready/labels live there, not on the
      // row) - same N+1 read path as the unfiltered list, fine at this scale.
      const list = rows
        .map((row) => toIssue(db, row, project.key))
        .filter(
          (issue) =>
            (query.assigneeId === undefined ||
              (query.assigneeId === 'unassigned'
                ? issue.assigneeId === null
                : issue.assigneeId === Number(query.assigneeId))) &&
            (query.ready === undefined ||
              issue.ready === (query.ready === 'true')) &&
            (query.type === undefined || issue.type === query.type) &&
            (query.state === undefined || issue.state === query.state) &&
            (query.label === undefined ||
              issue.labels.some(
                (l) => l.name.toLowerCase() === query.label?.toLowerCase(),
              )),
        );
      return c.json(list, 200);
    })
    .openapi(createIssueRoute, (c) => {
      const project = findProjectBySlug(db, c.req.valid('param').slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const { title, type, body } = c.req.valid('json');
      // Sync driver, single process: this max()-then-insert cannot interleave, so
      // numbering stays sequential; the (project_id, number) unique index is the
      // storage-layer backstop. rankAfter appends to the end of the rank order.
      const agg = db
        .select({ maxNumber: max(issues.number), maxRank: max(issues.rank) })
        .from(issues)
        .where(eq(issues.projectId, project.id))
        .get();
      const number = (agg?.maxNumber ?? 0) + 1;
      const rank = rankAfter(agg?.maxRank ?? null);
      const actorId = c.get('actorId');
      const now = new Date().toISOString();
      // The mutation and its `opened` event insert run in one transaction
      // (#76/#82): a rolled-back create never leaves a phantom event, and the
      // event.created broadcast fires only once the create has committed.
      const row = withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now },
        (tx, emit) => {
          const created = tx
            .insert(issues)
            .values({
              projectId: project.id,
              number,
              title,
              type,
              body: body ?? '',
              rank,
              authorId: actorId,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
          // Create always emits `opened` (actor = context actor = new authorId,
          // data: {}) - the one event this ticket (#82) actually fires.
          emit({ issueId: created.id, type: 'opened', data: {} });
          return created;
        },
      );
      // A brand-new issue has no labels, no parent, and no blockers (ready).
      const issue = toIssue(db, row, project.key);
      bus.publishIssueChanged(project.id, issue);
      return c.json(issue, 201);
    })
    .openapi(getIssueRoute, (c) => {
      const { slug, number } = c.req.valid('param');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const row = findIssue(db, project.id, number);
      if (!row) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      return c.json(toIssue(db, row, project.key), 200);
    })
    .openapi(patchIssueRoute, (c) => {
      const { slug, number } = c.req.valid('param');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const before = findIssue(db, project.id, number);
      if (!before) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      const patch = c.req.valid('json');
      // Reject an assignee that is not a real actor (trust boundary); null is a
      // valid value meaning "unassigned".
      if (patch.assigneeId !== undefined && patch.assigneeId !== null) {
        const actor = db
          .select()
          .from(actors)
          .where(eq(actors.id, patch.assigneeId))
          .get();
        if (!actor) {
          return c.json({ error: `No actor with id ${patch.assigneeId}` }, 400);
        }
      }
      const actorId = c.get('actorId');
      const now = new Date().toISOString();
      // claimedAt tracks when the CURRENT assignee was set, whatever the write
      // path (claim endpoints or this PATCH), so lease staleness (routes/
      // claims.ts) has one consistent meaning; unassigning clears it.
      const claimPatch =
        patch.assigneeId === undefined
          ? {}
          : { claimedAt: patch.assigneeId === null ? null : now };
      // The mutation and its events run in one transaction (#76/#82/#84/#87):
      // diff the before-row against the `.returning()` after-row field-by-field,
      // emitting one event per genuinely-changed event-worthy field (a field
      // sent equal to its current value, or never sent at all, leaves before
      // === after, so it emits nothing). `body` and `rank` are never diffed as
      // their own event, but a changed `body` still triggers the mention scan
      // below - fired = the targets newly resolved from the new body but not
      // the old one, so editing in a fresh reference fires once and removing
      // one retracts nothing (there is no retraction event type).
      const row = withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now },
        (tx, emit) => {
          const updated = tx
            .update(issues)
            .set({ ...patch, ...claimPatch, updatedAt: now })
            .where(
              and(eq(issues.projectId, project.id), eq(issues.number, number)),
            )
            .returning()
            .get();
          if (before.title !== updated.title) {
            emit({
              issueId: updated.id,
              type: 'renamed',
              data: { from: before.title, to: updated.title },
            });
          }
          if (before.type !== updated.type) {
            emit({
              issueId: updated.id,
              type: 'typed',
              data: { from: before.type, to: updated.type },
            });
          }
          if (before.state !== updated.state) {
            emit({
              issueId: updated.id,
              type: updated.state === 'closed' ? 'closed' : 'reopened',
              data: {},
            });
          }
          if (before.assigneeId !== updated.assigneeId) {
            if (updated.assigneeId !== null) {
              emit({
                issueId: updated.id,
                type: 'assigned',
                data: { assigneeActorId: updated.assigneeId },
              });
            } else if (before.assigneeId !== null) {
              emit({
                issueId: updated.id,
                type: 'unassigned',
                data: { assigneeActorId: before.assigneeId },
              });
            }
          }
          if (patch.body !== undefined) {
            const targets = newlyMentionedTargets(
              tx,
              project.id,
              project.key,
              before.id,
              before.body,
              patch.body,
            );
            for (const targetId of targets) {
              emit({
                issueId: targetId,
                type: 'mentioned',
                data: {
                  projectKey: project.key,
                  number: updated.number,
                  title: updated.title,
                },
              });
            }
          }
          return updated;
        },
      );
      if (!row) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      const issue = toIssue(db, row, project.key);
      bus.publishIssueChanged(project.id, issue);
      // A state change flips every dependent's derived blocked/ready, so re-publish
      // them too and open clients converge (#30), mirroring the label re-publish.
      if (patch.state !== undefined) {
        for (const dependent of dependentsOf(db, row.id)) {
          bus.publishIssueChanged(
            project.id,
            toIssue(db, dependent, project.key),
          );
        }
      }
      return c.json(issue, 200);
    })
    .openapi(deleteIssueRoute, (c) => {
      const { slug, number } = c.req.valid('param');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const existing = findIssue(db, project.id, number);
      if (!existing) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      // Read every relationship direction BEFORE the delete (#86): the FK cascade
      // (parent_id -> set null, issue_blocked_by -> cascade) wipes these edges the
      // instant the row goes, so the survivor list has to be captured up front.
      const parent =
        existing.parentId !== null
          ? findIssueById(db, existing.parentId)
          : undefined;
      const children = childrenOf(db, existing.id);
      const blockers = blockersOf(db, existing.id);
      const dependents = dependentsOf(db, existing.id);
      // The deleted issue's own {projectKey, number, title} is the counterpart
      // snapshot on every synthesized survivor event - a snapshot, not a soft FK,
      // is what survives the cascade (#86).
      const counterpart = {
        projectKey: project.key,
        number: existing.number,
        title: existing.title,
      };
      const actorId = c.get('actorId');
      const now = new Date().toISOString();
      const deleted = withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now },
        (tx, emit) => {
          if (parent) {
            emit({
              issueId: parent.id,
              type: 'sub_issue_removed',
              data: counterpart,
            });
          }
          for (const child of children) {
            emit({
              issueId: child.id,
              type: 'parent_removed',
              data: counterpart,
            });
          }
          for (const blocker of blockers) {
            emit({
              issueId: blocker.id,
              type: 'blocking_removed',
              data: counterpart,
            });
          }
          for (const dependent of dependents) {
            emit({
              issueId: dependent.id,
              type: 'blocked_by_removed',
              data: counterpart,
            });
          }
          // FK cascade drops the edges (and the deleted issue's own events) as
          // part of this same statement; no `deleted` event type is ever stored.
          return tx
            .delete(issues)
            .where(
              and(eq(issues.projectId, project.id), eq(issues.number, number)),
            )
            .returning()
            .get();
        },
      );
      if (!deleted) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      bus.publishIssueDeleted(project.id, deleted.id, deleted.number);
      // Only survivors whose derived blocked/ready can flip (the issues `existing`
      // used to block) get re-published (#86), mirroring the state-change re-publish
      // above.
      for (const dependent of dependents) {
        bus.publishIssueChanged(
          project.id,
          toIssue(db, dependent, project.key),
        );
      }
      return c.body(null, 204);
    });
}
