import { beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../app';
import { ensureHumanActor } from '../db/bootstrap';
import { createDb } from '../db/client';

// Seam 1: the requireActor contract itself (#81), isolated from any one route.
// Every other route spec relies on test/app.ts defaulting this header, so this
// file is the one place the 400/404/exemption edges are exercised directly.
let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof createDb>;

beforeEach(() => {
  db = createDb(':memory:');
  app = createApp(db);
});

describe('requireActor', () => {
  test('rejects a mutation with no X-Actor-Id header', async () => {
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'DEMO', name: 'Demo' }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects a non-integer X-Actor-Id header', async () => {
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Actor-Id': 'nope',
      },
      body: JSON.stringify({ key: 'DEMO', name: 'Demo' }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown X-Actor-Id', async () => {
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Actor-Id': '999',
      },
      body: JSON.stringify({ key: 'DEMO', name: 'Demo' }),
    });
    expect(res.status).toBe(404);
  });

  test('passes through and attributes a mutation for a known actor', async () => {
    const actor = ensureHumanActor(db);
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Actor-Id': String(actor.id),
      },
      body: JSON.stringify({ key: 'DEMO', name: 'Demo' }),
    });
    expect(res.status).toBe(201);
  });

  test('does not require X-Actor-Id for GET requests', async () => {
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
  });

  test('exempts POST /api/actors (bootstrap chicken-and-egg)', async () => {
    const res = await app.request('/api/actors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', kind: 'human' }),
    });
    expect(res.status).toBe(201);
  });
});
