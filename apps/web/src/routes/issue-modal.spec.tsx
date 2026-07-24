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
// `extraSeed` runs inside the same pre-mount seed (harness.tsx: "seed runs before
// mount") so e.g. an actor it creates is already in IssueDetail's once-loaded
// actors list by the time the modal opens.
async function openCardModal(extraSeed?: (client: ApiClient) => Promise<void>) {
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
    if (extraSeed) {
      await extraSeed(client);
    }
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
    await user.click(screen.getByRole('region', { name: 'Activity' }));
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

  test('a comment created elsewhere appends live, badged for an agent actor', async () => {
    let actorId = 0;
    // Seeded pre-mount so IssueDetail's once-loaded actors list already has it
    // (see openCardModal's `extraSeed` doc comment).
    const { client, number } = await openCardModal(async (client) => {
      actorId = expectId(
        await (
          await client.api.actors.$post({
            json: { name: 'Agent Smith', kind: 'agent' },
          })
        ).json(),
      );
    });

    // Override the client's default X-Actor-Id (#81) so this comment is
    // attributed to Agent Smith rather than the modal's own actor.
    await client.api.projects[':slug'].issues[':number'].comments.$post(
      {
        param: { slug, number: String(number) },
        json: { body: 'Looks good to me' },
      },
      { headers: { 'X-Actor-Id': String(actorId) } },
    );

    const row = (await screen.findByText('Looks good to me')).closest(
      '.timeline-node',
    );
    // The shared actor-display helper (#81/#83) badges the agent.
    expect(row?.querySelector('.actor-kind-badge')).not.toBeNull();
  });

  test('composing a comment posts it add-only and it appears', async () => {
    const { user } = await openCardModal();

    await user.type(screen.getByLabelText('Add a comment'), 'My first note');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    expect(await screen.findByText('My first note')).toBeDefined();
  });

  test('the activity rail has no redundant "opened" row - the description card already carries it', async () => {
    const { user } = await openCardModal();

    await user.type(screen.getByLabelText('Add a comment'), 'One comment');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    await screen.findByText('One comment');

    // Exactly one row: the comment. The issue's own `opened` event (#82) exists
    // in the underlying data but is filtered from the rail (Variant A, #83) since
    // it would just repeat the description's own "<author> opened <when>" line.
    const rows = within(
      screen.getByRole('region', { name: 'Activity' }),
    ).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
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
    // The chip's span carries a `title` attribute the Timeline's counterpart
    // link (#86) does not - scope to it, since both now render the text
    // "DEMO-2" once the relationship event lands in the activity rail too.
    await user.selectOptions(modal.getByLabelText('Add a blocker'), '2');
    expect(
      await modal.findByText('DEMO-2', { selector: 'span[title]' }),
    ).toBeDefined();
    await modal.findByText('Blocked');

    // The chip's × removes the edge; both the chip and the Blocked status clear.
    await user.click(
      modal.getByRole('button', { name: 'Remove blocker DEMO-2' }),
    );
    await waitFor(() => {
      expect(
        modal.queryByText('DEMO-2', { selector: 'span[title]' }),
      ).toBeNull();
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

    // The hover card is `aria-hidden` (#88 review N2), so the link's
    // accessible name is just its visible typed text, not the card's too.
    const mention = await screen.findByRole('link', { name: '#DEMO-2' });
    expect(mention.getAttribute('href')).toBe('/projects/demo/issues/2');
    expect(mention.getAttribute('target')).toBe('_blank');
    expect(mention.getAttribute('rel')).toBe('noopener');
    // The look-alike stays plain prose - never a link.
    expect(screen.queryByRole('link', { name: /SOC-2/ })).toBeNull();
    expect(screen.getByText(/look-alike SOC-2/)).toBeDefined();
  });

  test('a relationship event renders its counterpart as a full link under the header (#86)', async () => {
    const { router, user } = await renderApp(async (client) => {
      await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
      await createIssue(client, 'Wire the board');
      await createIssue(client, 'Ship the API');
    });
    await router.navigate({ to: '/projects/$slug', params: { slug } });
    await user.click(await screen.findByText('Wire the board'));
    await screen.findByLabelText('Edit title');
    const modal = within(screen.getByRole('dialog'));
    const activity = within(screen.getByRole('region', { name: 'Activity' }));

    await user.selectOptions(modal.getByLabelText('Parent'), '2');
    await activity.findByText(/added a parent/);

    // The header line names the event only - the counterpart lives in its own
    // list below (never inline), one continuous-underline link with the status
    // dot, title, and muted key all inside it.
    const header = activity
      .getByText(/added a parent/)
      .closest('.timeline-line');
    expect(header?.textContent).not.toMatch(/Ship the API/);
    const link = await activity.findByRole('link', {
      name: /Ship the API.*DEMO-2/,
    });
    expect(link.closest('.timeline-counterparts')).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/projects/demo/issues/2');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.querySelector('.counterpart-dot')).not.toBeNull();
  });

  test('adjacent same-type relationship events collapse into one grouped row (#86)', async () => {
    const { router, user } = await renderApp(async (client) => {
      await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } });
      await createIssue(client, 'Wire the board');
      await createIssue(client, 'Ship the API');
      await createIssue(client, 'Write the docs');
    });
    await router.navigate({ to: '/projects/$slug', params: { slug } });
    await user.click(await screen.findByText('Wire the board'));
    await screen.findByLabelText('Edit title');
    const modal = within(screen.getByRole('dialog'));
    const activity = within(screen.getByRole('region', { name: 'Activity' }));

    // Two blockers declared back to back by the same actor: one grouped row,
    // not two, plural-worded, each counterpart still linked below (#86 "GitHub
    // adjacency" grouping).
    await user.selectOptions(modal.getByLabelText('Add a blocker'), '2');
    await activity.findByText(/marked this as blocked/);
    await user.selectOptions(modal.getByLabelText('Add a blocker'), '3');
    await activity.findByText(/blocked by 2 issues/);

    const rows = activity.getAllByText(/blocked by 2 issues/);
    expect(rows).toHaveLength(1);
    expect(
      await activity.findByRole('link', { name: /Ship the API.*DEMO-2/ }),
    ).toBeDefined();
    expect(
      await activity.findByRole('link', { name: /Write the docs.*DEMO-3/ }),
    ).toBeDefined();
    // The blocking family swaps the plain dot for the octagon+minus icon.
    const link = await activity.findByRole('link', {
      name: /Ship the API.*DEMO-2/,
    });
    expect(link.querySelector('.counterpart-blocked-icon')).not.toBeNull();
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
