import { createApp } from '../app';
import { ensureHumanActor } from '../db/bootstrap';
import { createDb } from '../db/client';

// Seam-1 test app: mirrors server.ts's boot sequence (a Human actor exists)
// and defaults every request to that actor's X-Actor-Id (#81), so the route
// specs don't each have to mention the actor. A test exercising the header
// contract itself (missing/unknown actor, or attribution to a second actor)
// passes its own 'X-Actor-Id' header on that one call to override it.
export function testApp() {
  const db = createDb(':memory:');
  const actorId = ensureHumanActor(db).id;
  const real = createApp(db);
  const request: typeof real.request = async (input, init, ...rest) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('X-Actor-Id')) {
      headers.set('X-Actor-Id', String(actorId));
    }
    return real.request(input, { ...init, headers }, ...rest);
  };
  return { app: { request }, actorId };
}
