import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { ApiClient } from '../api';
import { renderApp } from '../test/harness';

// Seam 2: the real SPA + issue modal against a real in-process api emitting real SSE
// (#36, #40). Title/description are Jira-style inline edits (view -> ✓/✗); the other
// fields autosave. Dirty-field protection and live comment append all run over the
// exact zod-openapi contract the browser and agents consume - no mocks.

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

// Seed a project with one placed card, mount the board, and open the card's modal.
async function openCardModal() {
  let number = 0;
  const { client, router, user } = await renderApp(async (client) => {
    await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
    const todo = await createLabel(client, 'To Do');
    number = await createIssue(client, 'Wire the board');
    await client.api.projects[':slug'].issues[':number'].labels[
      ':labelId'
    ].$put({
      param: { slug, number: String(number), labelId: String(todo) },
    });
    await client.api.projects[':slug'].board.$patch({
      param,
      json: { columnAxis: [todo] },
    });
  });
  await router.navigate({ to: '/projects/$slug', params: { slug } });
  await user.click(await screen.findByText('Wire the board'));
  await screen.findByLabelText('Edit title');
  return { client, user, number };
}

// Enter the title inline editor (click the view region) and return its input.
async function openTitleEditor(
  user: Awaited<ReturnType<typeof openCardModal>>['user'],
) {
  await user.click(screen.getByLabelText('Edit title'));
  return screen.getByLabelText<HTMLInputElement>('Title');
}

describe('issue modal', () => {
  test('title inline edit commits on ✓, and only on ✓', async () => {
    const { client, user, number } = await openCardModal();

    const title = await openTitleEditor(user);
    await user.clear(title);
    await user.type(title, 'Renamed inline');

    // Sticky: clicking elsewhere in the modal does not save or leave edit mode.
    await user.click(screen.getByRole('heading', { name: 'Comments' }));
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe(
      'Renamed inline',
    );
    expect((await readIssue(client, number)).title).toBe('Wire the board');

    // The ✓ button commits the change and returns to the title view.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      expect((await readIssue(client, number)).title).toBe('Renamed inline');
    });
  });

  test('title inline edit ✗ discards the draft', async () => {
    const { client, user, number } = await openCardModal();

    const title = await openTitleEditor(user);
    await user.clear(title);
    await user.type(title, 'Should not stick');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Back to the view showing the original title; nothing was saved.
    expect(await screen.findByLabelText('Edit title')).toBeDefined();
    expect((await readIssue(client, number)).title).toBe('Wire the board');
  });

  test('an edited title is not clobbered by a remote change; the description updates live', async () => {
    const { client, user, number } = await openCardModal();

    // Start editing the title (now protected) without saving.
    const title = await openTitleEditor(user);
    await user.clear(title);
    await user.type(title, 'My local edit');

    // A remote change lands for both the edited title and the untouched description.
    await client.api.projects[':slug'].issues[':number'].$patch({
      param: { slug, number: String(number) },
      json: { title: 'Remote title', body: 'Remote body' },
    });

    // The edited title keeps the user's text and surfaces the "changed remotely" hint.
    await screen.findByText(/changed remotely/i);
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe(
      'My local edit',
    );
    // The description is not being edited, so it renders the remote body live.
    expect(await screen.findByText('Remote body')).toBeDefined();
  });

  test('a comment created elsewhere appends live', async () => {
    const { client, number } = await openCardModal();

    const actorId = expectId(
      await (
        await client.api.actors.$post({
          json: { name: 'Agent Smith', kind: 'agent' },
        })
      ).json(),
    );
    // Override the client's default X-Actor-Id (#81) so this comment is
    // attributed to Agent Smith rather than the modal's own actor.
    await client.api.projects[':slug'].issues[':number'].comments.$post(
      {
        param: { slug, number: String(number) },
        json: { body: 'Looks good to me' },
      },
      { headers: { 'X-Actor-Id': String(actorId) } },
    );

    expect(await screen.findByText('Looks good to me')).toBeDefined();
  });

  test('composing a comment posts it add-only and it appears', async () => {
    const { user } = await openCardModal();

    await user.type(screen.getByLabelText('Add a comment'), 'My first note');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    expect(await screen.findByText('My first note')).toBeDefined();
  });

  test('the description editor toggles between Edit and Preview markdown', async () => {
    const { user } = await openCardModal();

    await user.click(screen.getByLabelText('Edit description'));
    await user.type(screen.getByLabelText('Body'), '**bold**');
    await user.click(
      within(
        screen.getByRole('tablist', { name: 'Body editor mode' }),
      ).getByRole('tab', { name: 'Preview' }),
    );

    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  test('deletes behind a single confirm', async () => {
    const { user } = await openCardModal();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    // A lightweight confirm (no type-to-confirm) arms the delete.
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('Wire the board')).toBeNull();
    });
  });

  test('adding a blocker shows a removable chip (and flips the status)', async () => {
    const { router, user } = await renderApp(async (client) => {
      await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
      const todo = await createLabel(client, 'To Do');
      const first = await createIssue(client, 'Wire the board');
      await createIssue(client, 'Ship the API');
      await client.api.projects[':slug'].issues[':number'].labels[
        ':labelId'
      ].$put({
        param: { slug, number: String(first), labelId: String(todo) },
      });
      await client.api.projects[':slug'].board.$patch({
        param,
        json: { columnAxis: [todo] },
      });
    });
    await router.navigate({ to: '/projects/$slug', params: { slug } });
    await user.click(await screen.findByText('Wire the board'));
    await screen.findByLabelText('Edit title');
    // Scope to the modal - the board's FilterBar also has Ready/Blocked controls.
    const modal = within(screen.getByRole('dialog'));

    // The open issue starts with no blockers.
    expect(modal.getByText('Ready')).toBeDefined();

    // Declare DEMO-2 as a blocker; the chip appears live off issue.changed - the
    // feedback the status word alone could not give - and the status flips.
    await user.selectOptions(modal.getByLabelText('Add a blocker'), '2');
    expect(await modal.findByText('DEMO-2')).toBeDefined();
    await modal.findByText('Blocked');

    // The chip's × removes the edge; both the chip and the Blocked status clear.
    await user.click(
      modal.getByRole('button', { name: 'Remove blocker DEMO-2' }),
    );
    await waitFor(() => {
      expect(modal.queryByText('DEMO-2')).toBeNull();
    });
    await modal.findByText('Ready');
  });

  test('a mention in the description links to the target issue, in a new tab (#88)', async () => {
    let first = 0;
    const { router, user } = await renderApp(async (client) => {
      await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
      first = await createIssue(client, 'Wire the board');
      const second = await createIssue(client, 'Ship the API');
      await client.api.projects[':slug'].issues[':number'].$patch({
        param: { slug, number: String(first) },
        json: { body: `See #DEMO-${second} and a look-alike SOC-2.` },
      });
    });
    await router.navigate({ to: '/projects/$slug', params: { slug } });
    await user.click(await screen.findByText('Wire the board'));
    await screen.findByLabelText('Edit title');

    // The link's accessible name also picks up its nested hover-card text
    // (key/state/title), so match on the visible prefix rather than the
    // full concatenated name.
    const mention = await screen.findByRole('link', { name: /^#DEMO-2/ });
    expect(mention.getAttribute('href')).toBe('/projects/demo/issues/2');
    expect(mention.getAttribute('target')).toBe('_blank');
    expect(mention.getAttribute('rel')).toBe('noopener');
    // The look-alike stays plain prose - never a link.
    expect(screen.queryByRole('link', { name: /SOC-2/ })).toBeNull();
    expect(screen.getByText(/look-alike SOC-2/)).toBeDefined();
  });

  test('the header New issue button creates via the same modal', async () => {
    const { router, user } = await renderApp(async (client) => {
      await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
    });
    await router.navigate({ to: '/projects/$slug', params: { slug } });
    await user.click(await screen.findByRole('button', { name: 'New issue' }));

    await user.type(screen.getByLabelText('Title'), 'Brand new issue');
    await user.click(screen.getByRole('button', { name: 'Create issue' }));

    // The modal transitions to the detail surface: the id becomes a link. The title
    // then shows twice - as the modal heading and as the new board card behind it.
    expect(await screen.findByRole('link', { name: 'DEMO-1' })).toBeDefined();
    await waitFor(() =>
      expect(screen.getAllByText('Brand new issue')).toHaveLength(2),
    );
  });
});
