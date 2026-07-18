import { z } from '@hono/zod-openapi';
import { hc } from 'hono/client';
import { describe, expect, test } from 'vitest';
import { createApp, type AppType } from './app';
import { createDb } from './db/client';
import { BoardSchema } from './routes/board';
import { IssueSchema } from './routes/issues';
import { LabelSchema } from './routes/labels';
import { ProjectSchema } from './routes/projects';
import { seed, type SeedClient } from './seed';

// Drive the seed exactly as `pnpm seed` does - the real hc client wired to the
// real Hono app over a fresh in-memory SQLite (Seam 1). No mocks: the seed
// exercises the same route surface a developer's data would.
const makeClient = (): SeedClient => {
  const app = createApp(createDb(':memory:'));
  const fetchImpl: typeof fetch = async (input, init) =>
    app.request(input, init);
  return hc<AppType>('http://localhost', { fetch: fetchImpl });
};

const SLUG = 'demo';

const counts = async (client: SeedClient) => {
  const projects = z
    .array(ProjectSchema)
    .parse(await (await client.api.projects.$get()).json());
  const labels = z.array(LabelSchema).parse(
    await (
      await client.api.projects[':slug'].labels.$get({
        param: { slug: SLUG },
      })
    ).json(),
  );
  const issues = z.array(IssueSchema).parse(
    await (
      await client.api.projects[':slug'].issues.$get({
        param: { slug: SLUG },
      })
    ).json(),
  );
  return {
    projects: projects.length,
    labels: labels.length,
    issues: issues.length,
  };
};

describe('seed', () => {
  test('creates the demo project with labels, issues, and a populated board axis', async () => {
    const client = makeClient();
    await seed(client);

    const project = ProjectSchema.parse(
      await (
        await client.api.projects[':slug'].$get({ param: { slug: SLUG } })
      ).json(),
    );
    expect(project.slug).toBe(SLUG);

    const { labels, issues } = await counts(client);
    expect(labels).toBeGreaterThanOrEqual(3);
    expect(issues).toBeGreaterThan(0);

    const board = BoardSchema.parse(
      await (
        await client.api.projects[':slug'].board.$get({ param: { slug: SLUG } })
      ).json(),
    );
    // The board axis is set to demo labels, so the seeded board renders columns.
    expect(board.columnAxis.length).toBeGreaterThanOrEqual(3);

    // At least one issue carries an axis label (lands in a column) and at least
    // one is closed (lands in the virtual "Done" column) - a populated board.
    const issueRows = z.array(IssueSchema).parse(
      await (
        await client.api.projects[':slug'].issues.$get({
          param: { slug: SLUG },
        })
      ).json(),
    );
    expect(issueRows.some((i) => i.labels.length > 0)).toBe(true);
    expect(issueRows.some((i) => i.state === 'closed')).toBe(true);
  });

  test('is idempotent: rerunning creates no duplicate projects, labels, or issues', async () => {
    const client = makeClient();
    await seed(client);
    const first = await counts(client);
    await seed(client);
    const second = await counts(client);
    expect(second).toEqual(first);
  });
});
