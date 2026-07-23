import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { testApp } from '../test/app';
import { ErrorSchema, ProjectSchema } from './projects';

// Seam 1: drive the real Hono app through app.request against a real
// in-memory SQLite with migrations applied. No mocking of Drizzle or SQLite.
// Response bodies are zod-parsed: assertion + typing in one step, no casts.
let app: ReturnType<typeof testApp>['app'];

beforeEach(() => {
  ({ app } = testApp());
});

const createProject = async (body: unknown) =>
  app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const parseProject = async (res: Response) =>
  ProjectSchema.parse(await res.json());
const parseError = async (res: Response) => ErrorSchema.parse(await res.json());

describe('POST /api/projects', () => {
  test('creates a project and derives slug from key', async () => {
    const res = await createProject({ name: 'Demo Project', key: 'DEMO' });
    expect(res.status).toBe(201);
    const project = await parseProject(res);
    expect(project).toMatchObject({
      name: 'Demo Project',
      key: 'DEMO',
      slug: 'demo',
    });
    expect(project.id).toBeTypeOf('number');
    expect(project.createdAt).toBeTypeOf('string');
    expect(project.updatedAt).toBeTypeOf('string');
  });

  test.each([
    ['lowercase', 'demo'],
    ['leading digit', '1AB'],
    ['too short', 'A'],
    ['too long (11 chars)', 'ABCDEFGHIJK'],
    ['symbols', 'AB-C'],
    ['empty', ''],
  ])('rejects invalid key (%s) with 400 and a message', async (_label, key) => {
    const res = await createProject({ name: 'Demo', key });
    expect(res.status).toBe(400);
    const body = await parseError(res);
    expect(body.error.length).toBeGreaterThan(0);
  });

  test('rejects missing/empty name with 400', async () => {
    expect((await createProject({ key: 'DEMO' })).status).toBe(400);
    expect((await createProject({ name: '', key: 'DEMO' })).status).toBe(400);
  });

  test('rejects duplicate key with 409', async () => {
    expect((await createProject({ name: 'One', key: 'DEMO' })).status).toBe(
      201,
    );
    const dup = await createProject({ name: 'Two', key: 'DEMO' });
    expect(dup.status).toBe(409);
    const body = await parseError(dup);
    expect(body.error).toContain('DEMO');
  });
});

describe('GET /api/projects', () => {
  test('lists projects', async () => {
    await createProject({ name: 'Alpha', key: 'ALPHA' });
    await createProject({ name: 'Beta', key: 'BETA' });
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
    const projects = z.array(ProjectSchema).parse(await res.json());
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.slug)).toEqual(['alpha', 'beta']);
  });

  test('returns empty array on a fresh instance', async () => {
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('GET /api/projects/:slug', () => {
  test('fetches a project by lowercased-key slug', async () => {
    await createProject({ name: 'Demo', key: 'DEMO' });
    const res = await app.request('/api/projects/demo');
    expect(res.status).toBe(200);
    expect(await parseProject(res)).toMatchObject({
      name: 'Demo',
      key: 'DEMO',
      slug: 'demo',
    });
  });

  test('404s for an unknown slug', async () => {
    const res = await app.request('/api/projects/nope');
    expect(res.status).toBe(404);
    const body = await parseError(res);
    expect(body.error.length).toBeGreaterThan(0);
  });

  test('slug is lowercase: the uppercase key is not a valid slug', async () => {
    await createProject({ name: 'Demo', key: 'DEMO' });
    expect((await app.request('/api/projects/DEMO')).status).toBe(404);
  });
});

describe('PATCH /api/projects/:slug', () => {
  test('renames a project', async () => {
    await createProject({ name: 'Old Name', key: 'DEMO' });
    const res = await app.request('/api/projects/demo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(res.status).toBe(200);
    expect(await parseProject(res)).toMatchObject({
      name: 'New Name',
      key: 'DEMO',
      slug: 'demo',
    });
    const fetched = await parseProject(await app.request('/api/projects/demo'));
    expect(fetched.name).toBe('New Name');
  });

  test('rejects an empty name with 400', async () => {
    await createProject({ name: 'Demo', key: 'DEMO' });
    const res = await app.request('/api/projects/demo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('key is immutable: a key field in the body is ignored', async () => {
    await createProject({ name: 'Demo', key: 'DEMO' });
    const res = await app.request('/api/projects/demo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', key: 'OTHER' }),
    });
    expect(res.status).toBe(200);
    expect(await parseProject(res)).toMatchObject({
      name: 'Renamed',
      key: 'DEMO',
    });
  });

  test('404s for an unknown slug', async () => {
    const res = await app.request('/api/projects/nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/:slug', () => {
  test('deletes a project', async () => {
    await createProject({ name: 'Demo', key: 'DEMO' });
    const res = await app.request('/api/projects/demo', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await app.request('/api/projects/demo')).status).toBe(404);
    expect(await (await app.request('/api/projects')).json()).toEqual([]);
  });

  test('the key of a deleted project can be reused', async () => {
    await createProject({ name: 'First', key: 'DEMO' });
    await app.request('/api/projects/demo', { method: 'DELETE' });
    expect((await createProject({ name: 'Second', key: 'DEMO' })).status).toBe(
      201,
    );
  });

  test('404s for an unknown slug', async () => {
    const res = await app.request('/api/projects/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('API discovery', () => {
  test('GET /openapi.json documents the project routes (top-level, no /api prefix on the doc route)', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = z
      .object({
        info: z.object({ title: z.string() }),
        paths: z.record(z.string(), z.unknown()),
      })
      .parse(await res.json());
    expect(doc.info.title.length).toBeGreaterThan(0);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/projects', '/api/projects/{slug}']),
    );
  });

  test('GET /docs serves interactive docs (top-level)', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('openapi.json');
  });
});
