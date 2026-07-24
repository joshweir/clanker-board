import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { findIssue, findProjectBySlug, toIssue } from '../db/queries';
import { actors, issues, labels } from '../db/schema';
import type { EventBus } from '../events/bus';
import { withEvents } from '../events/with-events';
import type { ActorEnv } from '../middleware/actor';
import { IssueSchema } from './issues';
import { idParam, jsonBody, SlugParamSchema } from './openapi';
import { ErrorSchema } from './projects';

// Claiming is the multi-agent primitive (#6: assignee IS the claim). A claim by
// an agent actor is a lease, not ownership: claimed_at records when the current
// assignee was set, and a claim older than the TTL whose holder is an agent may
// be stolen - a crashed session can never wedge a ticket. Human assignees are
// never stolen. Re-claiming your own issue refreshes the lease (heartbeat).
//
// ponytail: TTL is one instance-wide env knob (CLAIM_TTL_MINUTES, default 45);
// add per-project or per-issue TTLs only when one value proves wrong in practice.
const claimTtlMs = () => Number(process.env.CLAIM_TTL_MINUTES ?? 45) * 60_000;

type IssueRow = typeof issues.$inferSelect;

// Can `actorId` take this open issue right now? Unassigned and self-held issues
// are claimable; an agent-held lease is claimable once expired. A row assigned
// without a claimed_at (defensive: pre-migration data) is treated as held.
const isClaimable = (db: Db, row: IssueRow, actorId: number): boolean => {
  if (row.assigneeId === null || row.assigneeId === actorId) {
    return true;
  }
  const holder = db
    .select({ kind: actors.kind })
    .from(actors)
    .where(eq(actors.id, row.assigneeId))
    .get();
  if (holder?.kind !== 'agent' || row.claimedAt === null) {
    return false;
  }
  return Date.now() - Date.parse(row.claimedAt) > claimTtlMs();
};

// Optional filters narrow what claim-next may pick: a label name (case-
// insensitive), a freeform type, and/or a parent issue (its per-project number).
// The claimant is the acting actor (X-Actor-Id), never a body field - a claim is
// always self-referential (#9, #81).
const ClaimNextSchema = z
  .object({
    label: z.string().min(1).optional().openapi({ example: 'ready-for-agent' }),
    type: z.string().min(1).optional().openapi({ example: 'task' }),
    parentNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ example: 1 }),
  })
  .openapi('ClaimNext');

const IssueParamSchema = SlugParamSchema.extend({ number: idParam('number') });

const claimIssueRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/issues/{number}/claim',
  summary:
    'Atomically claim an issue for the acting actor (re-claim by the holder renews the lease)',
  request: { params: IssueParamSchema },
  responses: {
    200: jsonBody(IssueSchema, 'The claimed issue'),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
    409: jsonBody(ErrorSchema, 'Issue is closed or held by someone else'),
  },
});

const claimNextRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/issues/claim-next',
  summary:
    'Atomically claim the first ready issue for the acting actor (open, unheld, all blockers closed)',
  request: {
    params: SlugParamSchema,
    body: {
      content: { 'application/json': { schema: ClaimNextSchema } },
      required: true,
    },
  },
  responses: {
    200: jsonBody(IssueSchema, 'The claimed issue'),
    400: jsonBody(ErrorSchema, 'Validation failure or unknown filter'),
    404: jsonBody(ErrorSchema, 'No such project, or no ready issue matches'),
  },
});

export function claimsRouter(db: Db, bus: EventBus) {
  // The single write path for both routes. Sync driver, single process: nothing
  // interleaves between the claimability check and this update, so the check-
  // then-set pair is atomic (same invariant the issue-numbering insert leans on).
  //
  // Claim / claim-next converge on the `assigned` event (#84), same as a
  // PATCH-assignee: self-vs-other phrasing is derived at render time
  // (event.actorId === assigneeActorId), never stored. A re-claim by the
  // current holder (heartbeat renewal) leaves assigneeId unchanged, so it
  // emits nothing - idempotency is this caller's job, per withEvents.
  const writeClaim = (row: IssueRow, actorId: number, projectKey: string) => {
    const now = new Date().toISOString();
    const updated = withEvents(
      db,
      bus,
      { projectId: row.projectId, actorId, now },
      (tx, emit) => {
        const updatedRow = tx
          .update(issues)
          .set({ assigneeId: actorId, claimedAt: now, updatedAt: now })
          .where(eq(issues.id, row.id))
          .returning()
          .get();
        if (row.assigneeId !== actorId) {
          emit({
            issueId: updatedRow.id,
            type: 'assigned',
            data: { assigneeActorId: actorId },
          });
        }
        return updatedRow;
      },
    );
    const issue = toIssue(db, updated, projectKey);
    bus.publishIssueChanged(updated.projectId, issue);
    return issue;
  };

  return new OpenAPIHono<ActorEnv>({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400);
      }
    },
  })
    .openapi(claimIssueRoute, (c) => {
      const { slug, number } = c.req.valid('param');
      // The claimant is the acting actor (requireActor already validated it).
      const actorId = c.get('actorId');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      const row = findIssue(db, project.id, number);
      if (!row) {
        return c.json({ error: 'Issue not found' }, 404);
      }
      if (row.state === 'closed') {
        return c.json({ error: 'Issue is closed' }, 409);
      }
      if (!isClaimable(db, row, actorId)) {
        return c.json(
          { error: `Issue already claimed by actor ${row.assigneeId}` },
          409,
        );
      }
      return c.json(writeClaim(row, actorId, project.key), 200);
    })
    .openapi(claimNextRoute, (c) => {
      const { slug } = c.req.valid('param');
      const { label, type, parentNumber } = c.req.valid('json');
      // The claimant is the acting actor (requireActor already validated it).
      const actorId = c.get('actorId');
      const project = findProjectBySlug(db, slug);
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      let parentId: number | undefined;
      if (parentNumber !== undefined) {
        const parent = findIssue(db, project.id, parentNumber);
        if (!parent) {
          return c.json({ error: `No issue with number ${parentNumber}` }, 400);
        }
        parentId = parent.id;
      }
      // An unknown label name can never match, so reject it loudly (typo guard).
      if (label !== undefined) {
        const known = db
          .select({ id: labels.id })
          .from(labels)
          .where(
            and(
              eq(labels.projectId, project.id),
              sql`lower(${labels.name}) = lower(${label})`,
            ),
          )
          .get();
        if (!known) {
          return c.json({ error: `No label named "${label}"` }, 400);
        }
      }
      // Candidates in board order (rank, then number - same order the issue list
      // uses), filtered in JS via the shared snapshot derivation: `ready` (all
      // blockers closed) and the attached labels come from toIssue, claimability
      // from the lease check above. N+1 like every other read path - fine at
      // this scale (single-process SQLite).
      const where = [
        eq(issues.projectId, project.id),
        eq(issues.state, 'open' as const),
      ];
      if (type !== undefined) {
        where.push(eq(issues.type, type));
      }
      if (parentId !== undefined) {
        where.push(eq(issues.parentId, parentId));
      }
      const candidates = db
        .select()
        .from(issues)
        .where(and(...where))
        .orderBy(asc(issues.rank), asc(issues.number))
        .all();
      for (const row of candidates) {
        if (!isClaimable(db, row, actorId)) {
          continue;
        }
        const snapshot = toIssue(db, row, project.key);
        if (!snapshot.ready) {
          continue;
        }
        if (
          label !== undefined &&
          !snapshot.labels.some(
            (l) => l.name.toLowerCase() === label.toLowerCase(),
          )
        ) {
          continue;
        }
        return c.json(writeClaim(row, actorId, project.key), 200);
      }
      return c.json({ error: 'No ready issue matches' }, 404);
    });
}
