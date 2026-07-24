import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { Actor, Comment, IssueEvent } from '../api';
import { groupTimeline, mergeTimeline, Timeline } from './timeline';

// Seam 2 pure-unit (#79 testing decisions: "timeline merge orders events +
// comments by (createdAt, id)"). Fixtures cover both shapes the merge sees today
// (comments, the `opened` event) and a shape #84 has not landed yet (`closed`) -
// the merge/render machinery does not care which event type it is handed.

const human: Actor = { id: 1, name: 'Ada', kind: 'human', createdAt: 't' };
const agent: Actor = {
  id: 2,
  name: 'claude:abc123',
  kind: 'agent',
  createdAt: 't',
};
const actors = [human, agent];

// Both shapes used below have an empty `data: {}` payload, so one literal covers
// either `type` without a cast (CLAUDE.md: never cast as a type).
function event(
  type: 'opened' | 'closed',
  id: number,
  createdAt: string,
  actorId: number = human.id,
): IssueEvent {
  return { id, issueId: 1, actorId, type, data: {}, createdAt };
}

// A relationship event (#86): same shape as `event` above but carrying the
// frozen counterpart snapshot instead of an empty payload.
function relEvent(
  type: 'blocked_by_added' | 'parent_added',
  id: number,
  createdAt: string,
  actorId: number = human.id,
  number = 2,
): IssueEvent {
  return {
    id,
    issueId: 1,
    actorId,
    type,
    data: { projectKey: 'DEMO', number, title: `Issue ${number}` },
    createdAt,
  };
}

function comment(overrides: Partial<Comment> & Pick<Comment, 'id'>): Comment {
  return {
    issueId: 1,
    actorId: human.id,
    body: 'hello',
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('mergeTimeline', () => {
  test('orders by createdAt, then by id on a tie', () => {
    const events: IssueEvent[] = [
      event('opened', 5, '2026-07-20T00:00:02.000Z'),
      event('opened', 1, '2026-07-20T00:00:00.000Z'),
    ];
    const comments: Comment[] = [
      comment({ id: 2, createdAt: '2026-07-20T00:00:00.000Z' }), // ties event id 1
      comment({ id: 9, createdAt: '2026-07-20T00:00:01.000Z' }),
    ];

    const keys = mergeTimeline(events, comments).map((n) => n.key);

    expect(keys).toEqual([
      'event-1', // createdAt :00, id 1 < comment id 2
      'comment-2', // createdAt :00, id 2
      'comment-9', // createdAt :01
      'event-5', // createdAt :02
    ]);
  });
});

describe('groupTimeline', () => {
  test('folds adjacent same-type, same-actor relationship events into one group, labelled with the latest time', () => {
    const nodes = mergeTimeline(
      [
        relEvent(
          'blocked_by_added',
          1,
          '2026-07-20T00:00:00.000Z',
          human.id,
          2,
        ),
        relEvent(
          'blocked_by_added',
          2,
          '2026-07-20T00:00:01.000Z',
          human.id,
          3,
        ),
      ],
      [],
    );

    const groups = groupTimeline(nodes);

    expect(groups).toHaveLength(1);
    const [group] = groups;
    if (group?.kind !== 'event-group') {
      throw new Error('expected a group');
    }
    expect(group.events.map((e) => e.id)).toEqual([1, 2]);
    expect(group.createdAt).toBe('2026-07-20T00:00:01.000Z');
  });

  test('breaks the run on a different actor', () => {
    const nodes = mergeTimeline(
      [
        relEvent('blocked_by_added', 1, '2026-07-20T00:00:00.000Z', human.id),
        relEvent('blocked_by_added', 2, '2026-07-20T00:00:01.000Z', agent.id),
      ],
      [],
    );

    expect(groupTimeline(nodes)).toHaveLength(2);
  });

  test('breaks the run on a different relationship type', () => {
    const nodes = mergeTimeline(
      [
        relEvent('blocked_by_added', 1, '2026-07-20T00:00:00.000Z'),
        relEvent('parent_added', 2, '2026-07-20T00:00:01.000Z'),
      ],
      [],
    );

    expect(groupTimeline(nodes)).toHaveLength(2);
  });

  test('breaks the run when a comment lands between two matching events', () => {
    const nodes = mergeTimeline(
      [
        relEvent('blocked_by_added', 1, '2026-07-20T00:00:00.000Z'),
        relEvent('blocked_by_added', 3, '2026-07-20T00:00:02.000Z'),
      ],
      [comment({ id: 1, createdAt: '2026-07-20T00:00:01.000Z' })],
    );

    const groups = groupTimeline(nodes);

    expect(groups.map((g) => g.kind)).toEqual([
      'event-group',
      'comment',
      'event-group',
    ]);
  });

  test('passes non-relationship events and comments through unchanged', () => {
    const nodes = mergeTimeline(
      [event('opened', 1, '2026-07-20T00:00:00.000Z')],
      [comment({ id: 1, createdAt: '2026-07-20T00:00:01.000Z' })],
    );

    expect(groupTimeline(nodes)).toEqual(nodes);
  });
});

describe('Timeline', () => {
  test('drops the redundant `opened` event but renders other event shapes interleaved with comments, in order', () => {
    const events: IssueEvent[] = [
      event('opened', 1, '2026-07-20T00:00:00.000Z'),
      event('closed', 2, '2026-07-20T00:00:02.000Z', agent.id),
    ];
    const comments: Comment[] = [
      comment({ id: 1, createdAt: '2026-07-20T00:00:01.000Z', body: 'first' }),
    ];

    render(
      <Timeline
        events={events}
        comments={comments}
        actors={actors}
        freshKeys={new Set()}
        composer={<div>composer-slot</div>}
      />,
    );

    const rows = within(
      screen.getByRole('region', { name: 'Activity' }),
    ).getAllByRole('listitem');
    // No row for `opened` - redundant with the description's own opened line.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('first');
    expect(rows[1]?.textContent).toContain('closed');
    // Composer renders at the bottom of the stream.
    expect(screen.getByText('composer-slot')).toBeDefined();
  });

  test('reuses the shared actor-display helper: agents badged, humans bare', () => {
    render(
      <Timeline
        events={[event('closed', 2, '2026-07-20T00:00:00.000Z', agent.id)]}
        comments={[comment({ id: 1, actorId: human.id })]}
        actors={actors}
        freshKeys={new Set()}
        composer={null}
      />,
    );

    // Only the agent row gets a badge - the human comment author stays bare.
    expect(document.querySelectorAll('.actor-kind-badge')).toHaveLength(1);
    expect(screen.getAllByText('Ada')[0]?.closest('.comment-meta')).not.toBe(
      null,
    );
  });

  test('flags a live-inserted row as fresh by its key', () => {
    render(
      <Timeline
        events={[]}
        comments={[comment({ id: 7 })]}
        actors={actors}
        freshKeys={new Set(['comment-7'])}
        composer={null}
      />,
    );

    expect(screen.getByRole('listitem').className).toContain('timeline-fresh');
  });
});
