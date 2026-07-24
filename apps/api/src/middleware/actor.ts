import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { Db } from '../db/client';
import { actors } from '../db/schema';

// Shared Env so a mounted sub-router's handler can safely `c.get('actorId')`
// after this middleware has run (#18, #81): the acting identity is read from
// context once, never re-parsed from a request body.
export type ActorEnv = { Variables: { actorId: number } };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Creating the very first actor identity cannot itself require a pre-existing
// actor (chicken-and-egg), so POST /api/actors is the one exempt mutation.
const isBootstrap = (method: string, path: string) =>
  method === 'POST' && path === '/api/actors';

// Every mutation under /api is attributed to an ambient, caller-asserted actor
// (#18): missing X-Actor-Id -> 400, unknown id -> 404, valid -> stashed on the
// context. By locked decision #18 the API forces *an* actor but cannot police
// that the caller truthfully is that actor - out of scope.
export function requireActor(db: Db) {
  return createMiddleware<ActorEnv>(async (c, next) => {
    if (
      READ_METHODS.has(c.req.method) ||
      isBootstrap(c.req.method, c.req.path)
    ) {
      return next();
    }
    const header = c.req.header('X-Actor-Id');
    if (header === undefined) {
      return c.json({ error: 'X-Actor-Id header is required' }, 400);
    }
    const actorId = Number(header);
    if (!Number.isInteger(actorId) || actorId <= 0) {
      return c.json({ error: 'X-Actor-Id must be a positive integer' }, 400);
    }
    const actor = db.select().from(actors).where(eq(actors.id, actorId)).get();
    if (!actor) {
      return c.json({ error: `No actor with id ${actorId}` }, 404);
    }
    c.set('actorId', actorId);
    return next();
  });
}
