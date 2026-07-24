import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  findIssue,
  findIssueById,
  findProjectBySlug,
  toIssue,
} from '../db/queries';
import { issueBlockedBy, issues } from '../db/schema';
import type { EventBus } from '../events/bus';
import { withEvents } from '../events/with-events';
import type { ActorEnv } from '../middleware/actor';
import { IssueSchema } from './issues';
import { idParam, jsonBody, SlugParamSchema } from './openapi';
import { ErrorSchema } from './projects';

const IssueParamSchema = SlugParamSchema.extend({ number: idParam('number') });

const BlockedByParamSchema = IssueParamSchema.extend({
  blockerNumber: idParam('blockerNumber'),
});

const SetParentSchema = z
  .object({ parentNumber: z.number().int().positive().openapi({ example: 1 }) })
  .openapi('SetParent');

// Walking parentId upward from `startId`: does the chain reach `targetId`? Used to
// reject a parent assignment that would make the single-parent tree cyclic (#30).
// The visited guard is defensive - the tree is kept acyclic, so it never triggers.
const reachesViaParent = (
  db: Db,
  startId: number,
  targetId: number,
): boolean => {
  const seen = new Set<number>();
  let currentId: number | null = startId;
  while (currentId !== null) {
    if (currentId === targetId) {
      return true;
    }
    if (seen.has(currentId)) {
      break;
    }
    seen.add(currentId);
    const row = db
      .select({ parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, currentId))
      .get();
    currentId = row?.parentId ?? null;
  }
  return false;
};

// Following blocked-by edges from `startId`: does the dependency chain reach
// `targetId`? Used to reject a new edge that would make the blocking DAG cyclic
// (#30). Iterative DFS with a visited guard so a pre-existing tangle can't loop.
const reachesViaBlockers = (
  db: Db,
  startId: number,
  targetId: number,
): boolean => {
  const seen = new Set<number>();
  const stack = [startId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === undefined || seen.has(currentId)) {
      continue;
    }
    if (currentId === targetId) {
      return true;
    }
    seen.add(currentId);
    for (const edge of db
      .select({ blockerId: issueBlockedBy.blockerId })
      .from(issueBlockedBy)
      .where(eq(issueBlockedBy.issueId, currentId))
      .all()) {
      stack.push(edge.blockerId);
    }
  }
  return false;
};

const setParentRoute = createRoute({
  method: 'put',
  path: '/projects/{slug}/issues/{number}/parent',
  summary: "Set an issue's single parent (rejects self-parenting and cycles)",
  request: {
    params: IssueParamSchema,
    body: {
      content: { 'application/json': { schema: SetParentSchema } },
      required: true,
    },
  },
  responses: {
    200: jsonBody(IssueSchema, 'The issue with its new parent'),
    400: jsonBody(ErrorSchema, 'Validation failure or self-parenting'),
    404: jsonBody(ErrorSchema, 'No such project, issue, or parent'),
    409: jsonBody(ErrorSchema, 'Setting this parent would create a cycle'),
  },
});

const clearParentRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/issues/{number}/parent',
  summary: "Clear an issue's parent",
  request: { params: IssueParamSchema },
  responses: {
    200: jsonBody(IssueSchema, 'The issue with no parent'),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
});

const blockRoute = createRoute({
  method: 'put',
  path: '/projects/{slug}/issues/{number}/blocked-by/{blockerNumber}',
  summary:
    'Declare a blocked-by edge (idempotent; rejects self-blocks and cycles)',
  request: { params: BlockedByParamSchema },
  responses: {
    200: jsonBody(
      IssueSchema,
      'The blocked issue with its updated derived state',
    ),
    400: jsonBody(ErrorSchema, 'An issue cannot block itself'),
    404: jsonBody(ErrorSchema, 'No such project, issue, or blocker'),
    409: jsonBody(
      ErrorSchema,
      'This edge would create a cycle in the blocking graph',
    ),
  },
});

const unblockRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/issues/{number}/blocked-by/{blockerNumber}',
  summary: 'Remove a blocked-by edge',
  request: { params: BlockedByParamSchema },
  responses: {
    200: jsonBody(
      IssueSchema,
      'The blocked issue with its updated derived state',
    ),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
});

export function relationshipsRouter(db: Db, bus: EventBus) {
  return new OpenAPIHono<ActorEnv>({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400);
      }
    },
  })
    .openapi(setParentRoute, (c) => {
      const { slug, number } = c.req.valid('param');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const issue = findIssue(db, project.id, number);
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      const parent = findIssue(
        db,
        project.id,
        c.req.valid('json').parentNumber,
      );
      if (!parent) {
        return c.json({ error: 'Parent issue not found' }, 404);
      }
      if (parent.id === issue.id) {
        return c.json({ error: 'An issue cannot be its own parent' }, 400);
      }
      // A cycle would form iff this issue is already an ancestor of the prospective
      // parent - i.e. walking up from the parent reaches this issue.
      if (reachesViaParent(db, parent.id, issue.id)) {
        return c.json(
          { error: 'Setting this parent would create a cycle' },
          409,
        );
      }
      // Re-declaring the SAME parent is a no-op for events (mirrors block's
      // onConflictDoNothing idempotency, #86) - read the previous parent (if any)
      // before the write so a genuine reparent can emit its `_removed` pair too.
      const previousParentId = issue.parentId;
      const previousParent =
        previousParentId !== null && previousParentId !== parent.id
          ? findIssueById(db, previousParentId)
          : undefined;
      const actorId = c.get('actorId');
      const now = new Date().toISOString();
      const row = withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now },
        (tx, emit) => {
          const updated = tx
            .update(issues)
            .set({ parentId: parent.id, updatedAt: now })
            .where(eq(issues.id, issue.id))
            .returning()
            .get();
          if (previousParentId !== parent.id) {
            if (previousParent) {
              emit({
                issueId: issue.id,
                type: 'parent_removed',
                data: {
                  projectKey: project.key,
                  number: previousParent.number,
                  title: previousParent.title,
                },
              });
              emit({
                issueId: previousParent.id,
                type: 'sub_issue_removed',
                data: {
                  projectKey: project.key,
                  number: issue.number,
                  title: issue.title,
                },
              });
            }
            emit({
              issueId: issue.id,
              type: 'parent_added',
              data: {
                projectKey: project.key,
                number: parent.number,
                title: parent.title,
              },
            });
            emit({
              issueId: parent.id,
              type: 'sub_issue_added',
              data: {
                projectKey: project.key,
                number: issue.number,
                title: issue.title,
              },
            });
          }
          return updated;
        },
      );
      if (!row) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      const snapshot = toIssue(db, row, project.key);
      bus.publishIssueChanged(project.id, snapshot);
      return c.json(snapshot, 200);
    })
    .openapi(clearParentRoute, (c) => {
      const { slug, number } = c.req.valid('param');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const issue = findIssue(db, project.id, number);
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      // No parent set is already a no-op (existing test); emits nothing (#86).
      const previousParent =
        issue.parentId !== null ? findIssueById(db, issue.parentId) : undefined;
      const actorId = c.get('actorId');
      const now = new Date().toISOString();
      const row = withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now },
        (tx, emit) => {
          const updated = tx
            .update(issues)
            .set({ parentId: null, updatedAt: now })
            .where(eq(issues.id, issue.id))
            .returning()
            .get();
          if (previousParent) {
            emit({
              issueId: issue.id,
              type: 'parent_removed',
              data: {
                projectKey: project.key,
                number: previousParent.number,
                title: previousParent.title,
              },
            });
            emit({
              issueId: previousParent.id,
              type: 'sub_issue_removed',
              data: {
                projectKey: project.key,
                number: issue.number,
                title: issue.title,
              },
            });
          }
          return updated;
        },
      );
      if (!row) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      const snapshot = toIssue(db, row, project.key);
      bus.publishIssueChanged(project.id, snapshot);
      return c.json(snapshot, 200);
    })
    .openapi(blockRoute, (c) => {
      const { slug, number, blockerNumber } = c.req.valid('param');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const issue = findIssue(db, project.id, number);
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      const blocker = findIssue(db, project.id, blockerNumber);
      if (!blocker) {
        return c.json({ error: 'Blocker issue not found' }, 404);
      }
      if (blocker.id === issue.id) {
        return c.json({ error: 'An issue cannot block itself' }, 400);
      }
      // Adding "issue blocked-by blocker" is a cycle iff the blocker already
      // depends (transitively) on the issue - reject rather than deadlock.
      if (reachesViaBlockers(db, blocker.id, issue.id)) {
        return c.json(
          { error: 'This edge would create a cycle in the blocking graph' },
          409,
        );
      }
      const actorId = c.get('actorId');
      const now = new Date().toISOString();
      withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now },
        (tx, emit) => {
          // Composite PK makes re-declaring the same edge a no-op (idempotent);
          // `.returning()` on an ON CONFLICT DO NOTHING only yields the rows that
          // were actually inserted, so an empty array IS the no-op signal (#86).
          const inserted = tx
            .insert(issueBlockedBy)
            .values({ issueId: issue.id, blockerId: blocker.id })
            .onConflictDoNothing()
            .returning()
            .all();
          if (inserted.length > 0) {
            emit({
              issueId: issue.id,
              type: 'blocked_by_added',
              data: {
                projectKey: project.key,
                number: blocker.number,
                title: blocker.title,
              },
            });
            emit({
              issueId: blocker.id,
              type: 'blocking_added',
              data: {
                projectKey: project.key,
                number: issue.number,
                title: issue.title,
              },
            });
          }
        },
      );
      // toIssue re-derives blocked/ready from the freshly-written edge.
      const snapshot = toIssue(db, issue, project.key);
      bus.publishIssueChanged(project.id, snapshot);
      return c.json(snapshot, 200);
    })
    .openapi(unblockRoute, (c) => {
      const { slug, number, blockerNumber } = c.req.valid('param');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const issue = findIssue(db, project.id, number);
      if (!issue) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      const blocker = findIssue(db, project.id, blockerNumber);
      if (!blocker) {
        return c.json({ error: 'Blocker issue not found' }, 404);
      }
      const actorId = c.get('actorId');
      const now = new Date().toISOString();
      withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now },
        (tx, emit) => {
          // A zero-row delete (the edge was never declared) emits nothing (#86).
          const removed = tx
            .delete(issueBlockedBy)
            .where(
              and(
                eq(issueBlockedBy.issueId, issue.id),
                eq(issueBlockedBy.blockerId, blocker.id),
              ),
            )
            .returning()
            .all();
          if (removed.length > 0) {
            emit({
              issueId: issue.id,
              type: 'blocked_by_removed',
              data: {
                projectKey: project.key,
                number: blocker.number,
                title: blocker.title,
              },
            });
            emit({
              issueId: blocker.id,
              type: 'blocking_removed',
              data: {
                projectKey: project.key,
                number: issue.number,
                title: issue.title,
              },
            });
          }
        },
      );
      const snapshot = toIssue(db, issue, project.key);
      bus.publishIssueChanged(project.id, snapshot);
      return c.json(snapshot, 200);
    });
}
