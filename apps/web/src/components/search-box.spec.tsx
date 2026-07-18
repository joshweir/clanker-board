import { screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { ApiClient } from '../api';
import { renderApp } from '../test/harness';

// Seam 2: the real inline SearchBox (#39, replaces the dedicated Search view) rendered
// in the board header, against a real in-process api with the live FTS5 index. No
// network, no mocks - the genuine ranked search contract, the debounced field, and the
// shared detail modal (#36) for opening a hit or the jump-to-#N row.

const slug = 'demo';
const param = { slug };

async function createIssue(
  client: ApiClient,
  title: string,
  body = '',
): Promise<number> {
  const res = await client.api.projects[':slug'].issues.$post({
    param,
    json: { title, type: 'task', body },
  });
  const created = await res.json();
  if (!('number' in created)) {
    throw new Error(`expected a created issue, got ${JSON.stringify(created)}`);
  }
  return created.number;
}

async function openBoard(seed: (client: ApiClient) => Promise<void>) {
  const { client, router, user } = await renderApp(async (client) => {
    await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
    await seed(client);
  });
  await router.navigate({ to: '/projects/$slug', params: { slug } });
  const input = await screen.findByRole<HTMLInputElement>('searchbox', {
    name: /Search issues and comments/,
  });
  return { client, user, input };
}

describe('inline search box', () => {
  test('a text query shows the matching issue with its matched field and highlight', async () => {
    const { user, input } = await openBoard(async (client) => {
      await createIssue(client, 'Fix the login page');
      await createIssue(client, 'Unrelated work');
    });

    await user.type(input, 'login');

    const open = await screen.findByRole('button', {
      name: /Open DEMO-1 Fix the login page/,
    });
    expect(open).toBeDefined();
    // The matched-field badge and the highlighted term both render.
    expect(screen.getByText('Title')).toBeDefined();
    expect(screen.getByText('login').tagName.toLowerCase()).toBe('mark');
    // The non-matching issue is absent from the results (board cards, which also
    // carry a button role, use no "Open …" label, so this stays scoped to results).
    expect(
      screen.queryByRole('button', { name: /Open .*Unrelated work/ }),
    ).toBeNull();
  });

  test('clicking a result opens the modal and keeps the query and results behind it', async () => {
    const { user, input } = await openBoard(async (client) => {
      await createIssue(client, 'Fix the login page');
    });

    await user.type(input, 'login');
    await user.click(
      await screen.findByRole('button', {
        name: /Open DEMO-1 Fix the login page/,
      }),
    );

    expect(
      await screen.findByRole('heading', { name: 'DEMO-1' }),
    ).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe(
      'Fix the login page',
    );
    // The field keeps its text and the results list stays mounted behind the modal.
    expect(input.value).toBe('login');
    expect(screen.getByRole('list', { name: 'Search results' })).toBeDefined();
  });

  test('the clear button empties the field and dismisses the results', async () => {
    const { user, input } = await openBoard(async (client) => {
      await createIssue(client, 'Fix the login page');
    });

    await user.type(input, 'login');
    await screen.findByRole('button', {
      name: /Open DEMO-1 Fix the login page/,
    });

    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(input.value).toBe('');
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  test('an all-digit query pins a Jump to #N row that opens that issue', async () => {
    const { user, input } = await openBoard(async (client) => {
      await createIssue(client, 'First issue');
      await createIssue(client, 'Second issue');
    });

    await user.type(input, '2');

    const jump = await screen.findByRole('button', {
      name: /Jump to DEMO-2: Second issue/,
    });
    await user.click(jump);

    // The shared modal opens on DEMO-2, not DEMO-1.
    expect(
      await screen.findByRole('heading', { name: 'DEMO-2' }),
    ).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe(
      'Second issue',
    );
  });

  test('no jump row when the number does not resolve to an issue', async () => {
    const { user, input } = await openBoard(async (client) => {
      await createIssue(client, 'Only issue');
    });

    await user.type(input, '999');

    // Give the debounce + resolve effect a beat, then assert there is no jump row.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull();
    });
  });
});
