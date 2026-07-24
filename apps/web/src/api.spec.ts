import { describe, expect, test } from 'vitest';
import { createClient } from './api';

// #81 fix: resolveActorId must not memoise a *rejected* actor-lookup promise -
// a transient first failure (network blip, momentary empty-actor race) has to
// recover on the next request instead of wedging the client forever.
describe('createClient actor resolution', () => {
  test('a transient first-lookup failure recovers on the next request', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      // Call 1: the actor-lookup fetch inside resolveActorId, made to fail once.
      if (calls === 1) {
        throw new Error('network blip');
      }
      expect(input).toBe('/api/actors');
      return new Response(JSON.stringify([{ id: 7, kind: 'human' }]));
    };
    const client = createClient(fetchImpl);

    // First request: resolveActorId's lookup rejects, so the whole request
    // rejects too. Before the fix, the rejected promise stayed cached and
    // every later request would throw the same way forever.
    await expect(client.api.actors.$get()).rejects.toThrow('network blip');

    // Second request: must retry the lookup (call 2, now succeeding) rather
    // than replaying the cached rejection, then proceed to the real request
    // (call 3).
    const res = await client.api.actors.$get();
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  test('a resolved actor id is cached across requests (lookup fetched once)', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify([{ id: 7, kind: 'human' }]));
    };
    const client = createClient(fetchImpl);

    await client.api.actors.$get(); // resolveActorId fetch (1) + real request (2)
    await client.api.actors.$get(); // actorId cached: just the real request (3)

    expect(calls).toBe(3);
  });
});
