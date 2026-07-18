import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import type { ApiClient } from '../api';
import { renderApp } from '../test/harness';

// Type and Label are dropdowns now (#38): open the axis (idempotent - only if closed)
// before toggling one of its option checkboxes.
async function toggleTypeOption(user: UserEvent, name: string): Promise<void> {
  const trigger = screen.getByRole('button', { name: /^Type/ });
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    await user.click(trigger);
  }
  await user.click(await screen.findByRole('checkbox', { name }));
}

// Seam 2: the shared, URL-driven filter bar (#38) on both the Board and Issues tabs,
// driven against a real in-process api. Filtering reduces which cards/rows show
// without ever restructuring the board, filter state lives in the URL query only,
// and Clear-all resets the axes but not the view controls (Hide Done / Open-All).

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

async function createActor(client: ApiClient, name: string): Promise<number> {
  return expectId(
    await (
      await client.api.actors.$post({ json: { name, kind: 'human' } })
    ).json(),
  );
}

async function createIssue(
  client: ApiClient,
  title: string,
  type: string,
): Promise<number> {
  const res = await client.api.projects[':slug'].issues.$post({
    param,
    json: { title, type },
  });
  const body = await res.json();
  if (!('number' in body)) {
    throw new Error(`expected a created issue, got ${JSON.stringify(body)}`);
  }
  return body.number;
}

async function attachLabel(
  client: ApiClient,
  number: number,
  labelId: number,
): Promise<void> {
  await client.api.projects[':slug'].issues[':number'].labels[':labelId'].$put({
    param: { slug, number: String(number), labelId: String(labelId) },
  });
}

async function assign(
  client: ApiClient,
  number: number,
  assigneeId: number,
): Promise<void> {
  await client.api.projects[':slug'].issues[':number'].$patch({
    param: { slug, number: String(number) },
    json: { assigneeId },
  });
}

async function close(client: ApiClient, number: number): Promise<void> {
  await client.api.projects[':slug'].issues[':number'].$patch({
    param: { slug, number: String(number) },
    json: { state: 'closed' },
  });
}

async function block(
  client: ApiClient,
  number: number,
  blockerNumber: number,
): Promise<void> {
  await client.api.projects[':slug'].issues[':number']['blocked-by'][
    ':blockerNumber'
  ].$put({
    param: {
      slug,
      number: String(number),
      blockerNumber: String(blockerNumber),
    },
  });
}

// A mixed fixture exercising every axis: a bug (Ada, To Do, ready), a task (Bob,
// Doing, blocked by the chore), an unassigned chore (No status, ready), and a closed
// task (Done). Titles are unique so a card is unambiguous at the screen level.
async function seed(client: ApiClient) {
  await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
  const todo = await createLabel(client, 'To Do');
  const doing = await createLabel(client, 'Doing');
  const ada = await createActor(client, 'Ada');
  const bob = await createActor(client, 'Bob');

  const bug = await createIssue(client, 'Bug for Ada', 'bug');
  await attachLabel(client, bug, todo);
  await assign(client, bug, ada);

  const chore = await createIssue(client, 'Loose chore', 'chore');

  const task = await createIssue(client, 'Task for Bob', 'task');
  await attachLabel(client, task, doing);
  await assign(client, task, bob);
  await block(client, task, chore); // open blocker -> task is blocked, not ready

  const shipped = await createIssue(client, 'Shipped work', 'task');
  await close(client, shipped);

  await client.api.projects[':slug'].board.$patch({
    param,
    json: { columnAxis: [todo, doing] },
  });
}

async function openBoard(navigateSearch: Record<string, unknown> = {}) {
  const { router, user } = await renderApp(seed);
  await router.navigate({
    to: '/projects/$slug',
    params: { slug },
    search: navigateSearch,
  });
  await screen.findByText('Bug for Ada');
  return { router, user };
}

async function openIssues(navigateSearch: Record<string, unknown> = {}) {
  const { router, user } = await renderApp(seed);
  await router.navigate({
    to: '/projects/$slug/issues',
    params: { slug },
    search: navigateSearch,
  });
  await screen.findByText('Bug for Ada');
  return { router, user };
}

const column = (name: string) => screen.getByRole('region', { name });

describe('board filter bar', () => {
  test('Done is hidden by default; the axis columns always render', async () => {
    await openBoard();
    const regions = screen
      .getAllByRole('region')
      .map((el) => el.getAttribute('aria-label'));
    expect(regions).toEqual(['To Do', 'Doing', 'No status']);
    // The closed card is not on the board by default.
    expect(screen.queryByText('Shipped work')).toBeNull();
  });

  test('a type filter reduces cards without restructuring; empty columns say No cards', async () => {
    const { user } = await openBoard();

    await toggleTypeOption(user, 'bug');

    // Only the bug remains, and it stays in its own column.
    expect(within(column('To Do')).getByText('Bug for Ada')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Task for Bob')).toBeNull());
    expect(screen.queryByText('Loose chore')).toBeNull();
    // The board shape is intact: the now-empty columns still render, saying "No cards".
    expect(within(column('Doing')).getByText('No cards')).toBeDefined();
    expect(within(column('No status')).getByText('No cards')).toBeDefined();
  });

  test('the blocked toggle narrows to blocked cards', async () => {
    const { user } = await openBoard();
    await user.click(screen.getByRole('checkbox', { name: 'Blocked' }));

    expect(within(column('Doing')).getByText('Task for Bob')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Bug for Ada')).toBeNull());
    expect(screen.queryByText('Loose chore')).toBeNull();
  });

  test('the ready toggle narrows to ready cards', async () => {
    const { user } = await openBoard();
    await user.click(screen.getByRole('checkbox', { name: 'Ready' }));

    expect(screen.getByText('Bug for Ada')).toBeDefined();
    expect(screen.getByText('Loose chore')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Task for Bob')).toBeNull());
  });

  test('the assignee filter narrows to a single actor', async () => {
    const { user } = await openBoard();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Assignee' }),
      'Ada',
    );

    expect(screen.getByText('Bug for Ada')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Task for Bob')).toBeNull());
    expect(screen.queryByText('Loose chore')).toBeNull();
  });

  test('filter state lives in the URL query and is applied when read back', async () => {
    // Opening straight from a shared URL applies the filter with no interaction.
    const { user, router } = await openBoard({ type: ['bug'] });
    expect(screen.queryByText('Task for Bob')).toBeNull();
    expect(within(column('To Do')).getByText('Bug for Ada')).toBeDefined();

    // Toggling a filter writes it to the raw query string (shareable, per-viewer);
    // an inactive axis is omitted entirely so the URL stays clean.
    expect(router.state.location.searchStr).toContain('bug');
    await toggleTypeOption(user, 'bug'); // clear it
    await waitFor(() =>
      expect(router.state.location.searchStr).not.toContain('type'),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Blocked' }));
    await waitFor(() =>
      expect(router.state.location.searchStr).toContain('blocked'),
    );
  });

  test('Clear all appears only when a filter is active and resets the axes, not Hide Done', async () => {
    const { user } = await openBoard();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();

    // Reveal Done (a view control, not a filter axis) and add a real filter.
    await user.click(screen.getByRole('checkbox', { name: 'Hide Done' })); // now showing Done
    expect(within(column('Done')).getByText('Shipped work')).toBeDefined();
    await toggleTypeOption(user, 'bug');

    const clear = await screen.findByRole('button', { name: 'Clear all' });
    await user.click(clear);

    // Axes reset: every open card is back...
    await waitFor(() => expect(screen.getByText('Task for Bob')).toBeDefined());
    expect(screen.getByText('Loose chore')).toBeDefined();
    // ...but Hide Done was left untouched, so Done is still shown.
    expect(within(column('Done')).getByText('Shipped work')).toBeDefined();
    // Clear all is gone now that no axis is active.
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });
});

describe('issues list filter bar', () => {
  test('the Open/Closed/All state control defaults to Open', async () => {
    await openIssues();
    expect(screen.getByText('Bug for Ada')).toBeDefined();
    expect(screen.getByText('Task for Bob')).toBeDefined();
    // The closed issue is hidden under the default Open state.
    expect(screen.queryByText('Shipped work')).toBeNull();
  });

  test('switching state to Closed / All changes which rows show', async () => {
    const { user } = await openIssues();
    const state = screen.getByRole('combobox', { name: 'State' });

    await user.selectOptions(state, 'closed');
    expect(await screen.findByText('Shipped work')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Bug for Ada')).toBeNull());

    await user.selectOptions(state, 'all');
    expect(await screen.findByText('Bug for Ada')).toBeDefined();
    expect(screen.getByText('Shipped work')).toBeDefined();
  });

  test('a filter axis combines with the state control (AND) and Clear all resets only the axis', async () => {
    const { user } = await openIssues({ state: 'all' });
    // Filter to tasks across all states: the open task and the closed task remain.
    await toggleTypeOption(user, 'task');
    await waitFor(() => expect(screen.queryByText('Bug for Ada')).toBeNull());
    expect(screen.getByText('Task for Bob')).toBeDefined();
    expect(screen.getByText('Shipped work')).toBeDefined();

    await user.click(await screen.findByRole('button', { name: 'Clear all' }));

    // The axis is cleared (the bug returns) but the All state control is preserved.
    expect(await screen.findByText('Bug for Ada')).toBeDefined();
    expect(screen.getByText('Shipped work')).toBeDefined();
  });
});
