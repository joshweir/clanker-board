import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { ApiClient } from '../api';
import { renderApp } from '../test/harness';

// Seam 2: the standalone ticket page (#40) - the shared IssueDetail surface on its own
// URL, under a project/parent/ticket breadcrumb, over the real in-process api.

const slug = 'demo';
const param = { slug };

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

async function readIssue(client: ApiClient, number: number) {
  const res = await client.api.projects[':slug'].issues[':number'].$get({
    param: { slug, number: String(number) },
  });
  const body = await res.json();
  if (!('title' in body)) {
    throw new Error(`expected an issue, got ${JSON.stringify(body)}`);
  }
  return body;
}

// Seed a parent + child (child's parent set) and open the child's page.
async function openChildPage() {
  let child = 0;
  const { client, router, user } = await renderApp(async (client) => {
    await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
    await createIssue(client, 'Parent epic');
    child = await createIssue(client, 'Child ticket');
    await client.api.projects[':slug'].issues[':number'].parent.$put({
      param: { slug, number: String(child) },
      json: { parentNumber: 1 },
    });
  });
  await router.navigate({
    to: '/projects/$slug/issues/$number',
    params: { slug, number: String(child) },
  });
  await screen.findByRole('heading', { name: 'Child ticket' });
  return { client, router, user, child };
}

describe('ticket detail page', () => {
  test('renders a project / parent / ticket breadcrumb', async () => {
    await openChildPage();

    const crumb = within(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    );
    expect(crumb.getByRole('link', { name: 'demo' })).toBeDefined();
    const parentLink = crumb.getByRole('link', { name: 'DEMO-1' });
    expect(parentLink.getAttribute('href')).toBe('/projects/demo/issues/1');
    // The ticket's own crumb links to its page and opens in a new tab.
    const selfLink = crumb.getByRole('link', { name: 'DEMO-2' });
    expect(selfLink.getAttribute('href')).toBe('/projects/demo/issues/2');
    expect(selfLink.getAttribute('target')).toBe('_blank');
  });

  test('the title inline edit commits on the page', async () => {
    const { client, user, child } = await openChildPage();

    await user.click(screen.getByLabelText('Edit title'));
    const input = screen.getByLabelText<HTMLInputElement>('Title');
    await user.clear(input);
    await user.type(input, 'Renamed on the page');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      expect((await readIssue(client, child)).title).toBe(
        'Renamed on the page',
      );
    });
  });
});
