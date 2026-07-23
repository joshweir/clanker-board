import { hc, type InferResponseType } from 'hono/client';
import type { AppType } from '@clanker/api';

// Hono RPC (`hc`) over same-origin relative URLs in dev and prod - no API-base
// config, no codegen (#4/#17). Tests inject a `fetch` bound to the real
// in-process api app, so the browser client and Seam-2 tests share one path.
export type ApiClient = ReturnType<typeof hc<AppType>>;

// Every mutation is attributed to an ambient caller-asserted actor (#18, #81).
// The SPA has no auth, so it speaks as the instance's Human actor (the same
// "first kind=human actor" convention as ensureHumanActor/server boot) - looked
// up once (via the unwrapped fetch, to avoid recursing back through itself)
// and cached, then attached as a default X-Actor-Id header on every request.
// Call sites never mention the actor again.
export function createClient(fetchImpl?: typeof fetch): ApiClient {
  const baseFetch = fetchImpl ?? fetch;
  let actorId: Promise<number> | undefined;
  const resolveActorId = async () => {
    actorId ??= (async () => {
      const rows: { id: number; kind: string }[] = await (
        await baseFetch('/api/actors')
      ).json();
      const human = rows.find((row) => row.kind === 'human');
      if (!human) {
        throw new Error('no human actor exists on this instance');
      }
      return human.id;
    })();
    return actorId;
  };
  const withActor: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    // Respect a caller-supplied header (e.g. a test attributing one call to a
    // different actor) rather than clobbering it with the instance default.
    if (!headers.has('X-Actor-Id')) {
      headers.set('X-Actor-Id', String(await resolveActorId()));
    }
    return baseFetch(input, { ...init, headers });
  };
  return hc<AppType>('/', { fetch: withActor });
}

export type Project = InferResponseType<
  ApiClient['api']['projects']['$get']
>[number];

// Per-project board data (#33). Second type arg pins the 200 body so the type is
// the success shape, not the 200-or-404 union `.json()` would otherwise yield.
export type Board = InferResponseType<
  ApiClient['api']['projects'][':slug']['board']['$get'],
  200
>;
export type Label = InferResponseType<
  ApiClient['api']['projects'][':slug']['labels']['$get'],
  200
>[number];
export type Issue = InferResponseType<
  ApiClient['api']['projects'][':slug']['issues']['$get'],
  200
>[number];

// A comment is a flat, append-only, actor-attributed log entry (#31). The modal
// lists them and appends new ones live off comment.created (#36).
export type Comment = InferResponseType<
  ApiClient['api']['projects'][':slug']['issues'][':number']['comments']['$get'],
  200
>[number];

// Instance-level identities (#28), caller-asserted (no auth). The modal attributes
// comments and the assignee to an actor.
export type Actor = InferResponseType<
  ApiClient['api']['actors']['$get']
>[number];

// Full-text search results (#39): grouped one-per-issue, each with the matched field
// and a highlighted snippet. The 200 body pins the success shape past the 404 union.
export type SearchResults = InferResponseType<
  ApiClient['api']['projects'][':slug']['search']['$get'],
  200
>;
export type SearchHit = SearchResults['results'][number];
