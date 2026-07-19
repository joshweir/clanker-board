import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { ApiClient } from '../api';
import { renderApp } from '../test/harness';

// Seam 2: the real SPA issues list against a real in-process api emitting real SSE
// (#37). The list seeds from its loader, then converges live off the per-project
// stream - the same contract the board consumes - and shares the board's detail
// modal (#36). No network, no mocks.

const slug = 'demo';
const param = { slug };

function expectId(body: unknown): number {
  if (
    typeof body === 'object' &&
    body !== null &&
    'id' in body &&
    typeof body.id === 'number'
  ) {
    return body.id;
  }
  throw new Error(`expected an entity with an id, got ${JSON.stringify(body)}`);
}

async function createLabel(client: ApiClient, name: string): Promise<number> {
  return expectId(
    await (
      await client.api.projects[':slug'].labels.$post({ param, json: { name } })
    ).json(),
  );
}

async function createIssue(client: ApiClient, title: string): Promise<number> {
  const res = await client.api.projects[':slug'].issues.$post({
    param,
    json: { title, type: 'task' },
  });
  const body = await res.json();
  if (!('number' in body)) {
    throw new Error(`expected a created issue, got ${JSON.stringify(body)}`);
  }
  return body.number;
}

async function attachLabel(
  client: ApiClient,
  issueNumber: number,
  labelId: number,
): Promise<void> {
  await client.api.projects[':slug'].issues[':number'].labels[':labelId'].$put({
    param: { slug, number: String(issueNumber), labelId: String(labelId) },
  });
}

// Seed a project with one placed, assigned, labelled card, then open the issues tab.
async function openSeededIssues() {
  let assigneeId = 0;
  let todo = 0;
  const { client, router, user } = await renderApp(async (client) => {
    await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
    assigneeId = expectId(
      await (
        await client.api.actors.$post({ json: { name: 'Ada', kind: 'human' } })
      ).json(),
    );
    todo = await createLabel(client, 'To Do');
    const number = await createIssue(client, 'Wire the list');
    await attachLabel(client, number, todo);
    await client.api.projects[':slug'].issues[':number'].$patch({
      param: { slug, number: String(number) },
      json: { assigneeId },
    });
  });
  await router.navigate({ to: '/projects/$slug/issues', params: { slug } });
  return { client, user };
}

describe('project issues list', () => {
  test('renders the issue as a table row with its columns', async () => {
    await openSeededIssues();

    // One row, so each column value is unambiguous at the screen level.
    const row = (
      await screen.findByRole('button', { name: /Open DEMO-1 Wire the list/ })
    ).closest('tr');
    if (row === null) {
      throw new Error('open button is not inside a table row');
    }
    expect(within(row).getByText('DEMO-1')).toBeDefined();
    expect(within(row).getByText('task')).toBeDefined();
    expect(within(row).getByText('Wire the list')).toBeDefined();
    expect(within(row).getByText('open')).toBeDefined();
    expect(within(row).getByText('Ada')).toBeDefined();
    expect(within(row).getByText('To Do')).toBeDefined();
  });

  test('a row click opens the shared detail modal', async () => {
    const { user } = await openSeededIssues();

    await user.click(
      await screen.findByRole('button', { name: /Open DEMO-1 Wire the list/ }),
    );

    // The shared detail surface: the id as a link + the title as its heading.
    expect(await screen.findByRole('link', { name: 'DEMO-1' })).toBeDefined();
    expect(
      screen.getByRole('heading', { name: 'Wire the list' }),
    ).toBeDefined();
  });

  test('an issue created via the API appears live with no reload', async () => {
    const { client } = await openSeededIssues();
    // Awaiting the seeded row guarantees the list has mounted and its SSE stream is
    // subscribed (the handler subscribes synchronously when app.request resolves).
    await screen.findByRole('button', { name: /Open DEMO-1 Wire the list/ });

    await createIssue(client, 'Live row');

    expect(
      await screen.findByRole('button', { name: /Open DEMO-2 Live row/ }),
    ).toBeDefined();
  });

  test('an edit made via the API updates the row live', async () => {
    const { client, user } = await openSeededIssues();
    await screen.findByRole('button', { name: /Open DEMO-1 Wire the list/ });

    // Show every state so closing the issue keeps its row visible (default is Open, #38).
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'State' }),
      'all',
    );

    await client.api.projects[':slug'].issues[':number'].$patch({
      param: { slug, number: String(1) },
      json: { state: 'closed' },
    });

    // The row's state cell flips open -> closed live off issue.changed.
    expect(await screen.findByText('closed')).toBeDefined();
  });

  test('an issue deleted via the API drops its row live', async () => {
    const { client } = await openSeededIssues();
    await screen.findByRole('button', { name: /Open DEMO-1 Wire the list/ });

    await client.api.projects[':slug'].issues[':number'].$delete({
      param: { slug, number: String(1) },
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Open DEMO-1 Wire the list/ }),
      ).toBeNull();
    });
  });

  test('the tab switcher links to the board view', async () => {
    await openSeededIssues();

    const boardTab = await screen.findByRole('link', { name: 'Board' });
    expect(boardTab.getAttribute('href')).toBe('/projects/demo');
    // The Issues tab is the current view.
    expect(
      screen.getByRole('link', { name: 'Issues' }).getAttribute('aria-current'),
    ).toBe('page');
  });
});
