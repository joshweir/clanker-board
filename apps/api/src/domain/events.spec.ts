import { describe, expect, test } from 'vitest';
import { EVENT_TYPES, EventPayloadSchema, EventSchema } from './events';

// Pure-unit: the zod discriminated union is the storage-layer guard (never cast
// - CLAUDE.md) that both withEvents (write) and the read/SSE paths (read) share.

describe('EventPayloadSchema (storage-side write validation)', () => {
  test('accepts every taxonomy type with its matching payload shape', () => {
    const cases: { type: (typeof EVENT_TYPES)[number]; data: unknown }[] = [
      { type: 'opened', data: {} },
      { type: 'closed', data: {} },
      { type: 'reopened', data: {} },
      { type: 'renamed', data: { from: 'old', to: 'new' } },
      { type: 'typed', data: { from: 'bug', to: 'task' } },
      { type: 'assigned', data: { assigneeActorId: 1 } },
      { type: 'unassigned', data: { assigneeActorId: 1 } },
      { type: 'labeled', data: { labelId: 1, name: 'bug' } },
      { type: 'unlabeled', data: { labelId: 1, name: 'bug' } },
      {
        type: 'parent_added',
        data: { projectKey: 'DEMO', number: 1, title: 'Parent' },
      },
      {
        type: 'parent_removed',
        data: { projectKey: 'DEMO', number: 1, title: 'Parent' },
      },
      {
        type: 'sub_issue_added',
        data: { projectKey: 'DEMO', number: 2, title: 'Child' },
      },
      {
        type: 'sub_issue_removed',
        data: { projectKey: 'DEMO', number: 2, title: 'Child' },
      },
      {
        type: 'blocked_by_added',
        data: { projectKey: 'DEMO', number: 3, title: 'Blocker' },
      },
      {
        type: 'blocked_by_removed',
        data: { projectKey: 'DEMO', number: 3, title: 'Blocker' },
      },
      {
        type: 'blocking_added',
        data: { projectKey: 'DEMO', number: 4, title: 'Dependent' },
      },
      {
        type: 'blocking_removed',
        data: { projectKey: 'DEMO', number: 4, title: 'Dependent' },
      },
      {
        type: 'mentioned',
        data: { projectKey: 'DEMO', number: 5, title: 'Source' },
      },
    ];
    expect(cases).toHaveLength(EVENT_TYPES.length);
    for (const { type, data } of cases) {
      expect(EventPayloadSchema.parse({ type, data })).toEqual({ type, data });
    }
  });

  test('rejects a payload shape that does not match its type', () => {
    expect(() =>
      EventPayloadSchema.parse({ type: 'opened', data: { oops: true } }),
    ).toThrow();
    expect(() =>
      EventPayloadSchema.parse({ type: 'assigned', data: {} }),
    ).toThrow();
  });

  test('rejects an unknown type', () => {
    expect(() =>
      EventPayloadSchema.parse({ type: 'deleted', data: {} }),
    ).toThrow();
  });
});

describe('EventSchema (full stored+parsed row, read/SSE side)', () => {
  test('parses a full opened row', () => {
    const row = {
      id: 1,
      issueId: 2,
      actorId: 3,
      type: 'opened' as const,
      data: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(EventSchema.parse(row)).toEqual(row);
  });
});
