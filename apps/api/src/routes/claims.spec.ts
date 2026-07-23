import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { testApp } from '../test/app';
import { nextEventOfType, readEvents } from '../test/sse';
import { ActorSchema } from './actors';
import { IssueSchema } from './issues';
import { ErrorSchema } from './projects';

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with migrations applied. No mocking of Drizzle, SQLite, or the bus.
let app: ReturnType<typeof testApp>['app'];

beforeEach(() => {
  ({ app } = testApp());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const createProject = async (key: string) =>
  app.request('/api/projects', { method: 'POST', ...json({ key, name: key }) });

const createIssue = async (title: string, type = 'task') =>
  app.request('/api/projects/demo/issues', {
    method: 'POST',
    ...json({ title, type }),
  });

const createActor = async (name: string, kind: 'human' | 'agent' = 'agent') =>
  ActorSchema.parse(
    await (
      await app.request('/api/actors', {
        method: 'POST',
        ...json({ name, kind }),
      })
    ).json(),
  );

const patchIssue = async (number: number, body: unknown) =>
  app.request(`/api/projects/demo/issues/${number}`, {
    method: 'PATCH',
    ...json(body),
  });

// The claimant is the acting (header) actor, never a body field (#81) - a
// claim is always self-referential.
const claim = async (number: number, actorId: number) =>
  app.request(`/api/projects/demo/issues/${number}/claim`, {
    method: 'POST',
    headers: { 'X-Actor-Id': String(actorId) },
  });

const claimNext = async (actorId: number, filters: unknown = {}) =>
  app.request('/api/projects/demo/issues/claim-next', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Actor-Id': String(actorId),
    },
    body: JSON.stringify(filters),
  });

const parseIssue = async (res: Response) => IssueSchema.parse(await res.json());

describe('POST /api/projects/:slug/issues/:number/claim', () => {
  beforeEach(async () => {
    await createProject('DEMO');
    await createIssue('One');
  });

  test('claims an unassigned issue and stamps claimedAt', async () => {
    const agent = await createActor('claude:a');
    const res = await claim(1, agent.id);
    expect(res.status).toBe(200);
    const issue = await parseIssue(res);
    expect(issue.assigneeId).toBe(agent.id);
    expect(issue.claimedAt).not.toBeNull();
  });

  test('re-claim by the holder renews the lease (heartbeat)', async () => {
    const agent = await createActor('claude:a');
    await claim(1, agent.id);
    const res = await claim(1, agent.id);
    expect(res.status).toBe(200);
    expect((await parseIssue(res)).assigneeId).toBe(agent.id);
  });

  test('409s when held by another actor within the TTL', async () => {
    const [a, b] = [
      await createActor('claude:a'),
      await createActor('claude:b'),
    ];
    await claim(1, a.id);
    const res = await claim(1, b.id);
    expect(res.status).toBe(409);
    expect(ErrorSchema.parse(await res.json()).error).toContain(`${a.id}`);
  });

  test('steals an expired agent lease', async () => {
    vi.stubEnv('CLAIM_TTL_MINUTES', '-1'); // every lease is already expired
    const [a, b] = [
      await createActor('claude:a'),
      await createActor('claude:b'),
    ];
    await claim(1, a.id);
    const res = await claim(1, b.id);
    expect(res.status).toBe(200);
    expect((await parseIssue(res)).assigneeId).toBe(b.id);
  });

  test('never steals from a human, even past the TTL', async () => {
    vi.stubEnv('CLAIM_TTL_MINUTES', '-1');
    const human = await createActor('Josh', 'human');
    const agent = await createActor('claude:a');
    await patchIssue(1, { assigneeId: human.id });
    expect((await claim(1, agent.id)).status).toBe(409);
  });

  test('409s on a closed issue', async () => {
    const agent = await createActor('claude:a');
    await patchIssue(1, { state: 'closed' });
    expect((await claim(1, agent.id)).status).toBe(409);
  });

  test('404s for an unknown actor, 404s for unknown issue/project', async () => {
    const agent = await createActor('claude:a');
    expect((await claim(1, 999)).status).toBe(404);
    expect((await claim(99, agent.id)).status).toBe(404);
    expect(
      (
        await app.request('/api/projects/nope/issues/1/claim', {
          method: 'POST',
          headers: { 'X-Actor-Id': String(agent.id) },
        })
      ).status,
    ).toBe(404);
  });

  test('emits issue.changed on claim', async () => {
    const agent = await createActor('claude:a');
    const controller = new AbortController();
    const events = readEvents(
      await app.request('/api/projects/demo/events', {
        signal: controller.signal,
      }),
    );
    await claim(1, agent.id);
    const evt = await nextEventOfType(events, 'issue.changed');
    expect(evt.data).toMatchObject({ number: 1, assigneeId: agent.id });
    controller.abort();
  });
});

describe('POST /api/projects/:slug/issues/claim-next', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('claims the first ready issue in rank order, skipping held ones', async () => {
    await createIssue('One');
    await createIssue('Two');
    const [a, b] = [
      await createActor('claude:a'),
      await createActor('claude:b'),
    ];
    const first = await parseIssue(await claimNext(a.id));
    expect(first.number).toBe(1);
    const second = await parseIssue(await claimNext(b.id));
    expect(second.number).toBe(2);
  });

  test('skips blocked issues (only the frontier is claimable)', async () => {
    await createIssue('Blocker');
    await createIssue('Dependent');
    await app.request('/api/projects/demo/issues/2/blocked-by/1', {
      method: 'PUT',
    });
    const agent = await createActor('claude:a');
    // #1 blocks #2, so both claims land on... #1 first; then nothing is ready.
    expect((await parseIssue(await claimNext(agent.id))).number).toBe(1);
    await patchIssue(1, { state: 'closed' });
    // Closing the blocker frees #2 - but #1 is closed, so claim-next skips it.
    expect((await parseIssue(await claimNext(agent.id))).number).toBe(2);
  });

  test('404s when nothing matches', async () => {
    const agent = await createActor('claude:a');
    expect((await claimNext(agent.id)).status).toBe(404);
  });

  test('404s for an unknown actor, 404s for an unknown project', async () => {
    const agent = await createActor('claude:a');
    expect((await claimNext(999)).status).toBe(404);
    expect(
      (
        await app.request('/api/projects/nope/issues/claim-next', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Actor-Id': String(agent.id),
          },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(404);
  });

  test('filters by type and label (case-insensitive)', async () => {
    await createIssue('A chore', 'chore');
    await createIssue('A task', 'task');
    const labelRes = await app.request('/api/projects/demo/labels', {
      method: 'POST',
      ...json({ name: 'ready-for-agent' }),
    });
    const { id: labelId } = (await labelRes.json()) as { id: number };
    await app.request(`/api/projects/demo/issues/2/labels/${labelId}`, {
      method: 'PUT',
    });
    const agent = await createActor('claude:a');
    const byLabel = await parseIssue(
      await claimNext(agent.id, { label: 'Ready-For-Agent' }),
    );
    expect(byLabel.number).toBe(2);
    await patchIssue(2, { assigneeId: null });
    const byType = await parseIssue(
      await claimNext(agent.id, { type: 'chore' }),
    );
    expect(byType.number).toBe(1);
  });

  test('rejects an unknown label or parent with 400', async () => {
    const agent = await createActor('claude:a');
    expect((await claimNext(agent.id, { label: 'nope' })).status).toBe(400);
    expect((await claimNext(agent.id, { parentNumber: 99 })).status).toBe(400);
  });

  test('filters by parentNumber (children of a spec)', async () => {
    await createIssue('Spec', 'spec');
    await createIssue('Child A');
    await createIssue('Orphan');
    await app.request('/api/projects/demo/issues/2/parent', {
      method: 'PUT',
      ...json({ parentNumber: 1 }),
    });
    const agent = await createActor('claude:a');
    const claimed = await parseIssue(
      await claimNext(agent.id, { parentNumber: 1 }),
    );
    expect(claimed.number).toBe(2);
  });

  test('steals an expired agent lease but not a live one', async () => {
    await createIssue('One');
    const [a, b] = [
      await createActor('claude:a'),
      await createActor('claude:b'),
    ];
    await claim(1, a.id);
    expect((await claimNext(b.id)).status).toBe(404);
    vi.stubEnv('CLAIM_TTL_MINUTES', '-1');
    const stolen = await parseIssue(await claimNext(b.id));
    expect(stolen.assigneeId).toBe(b.id);
  });
});
