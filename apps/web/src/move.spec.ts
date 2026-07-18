import { describe, expect, test } from 'vitest';
import type { Issue, Label } from './api';
import type { BoardColumn } from './board-layout';
import { applyPlan, planMove, rankForDrop, reorderColumnAxis } from './move';

const label = (id: number, name: string): Label => ({
  id,
  projectId: 1,
  name,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const issue = (over: Partial<Issue> & Pick<Issue, 'id'>): Issue => ({
  projectId: 1,
  number: over.id,
  title: `Issue ${over.id}`,
  type: 'task',
  body: '',
  state: 'open',
  rank: 'a0',
  assigneeId: null,
  parentId: null,
  key: `DEMO-${over.id}`,
  labels: [],
  blockers: [],
  blocked: false,
  ready: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const todo = label(10, 'To Do');
const doing = label(20, 'Doing');
const bug = label(99, 'bug'); // a non-axis label that must never be touched

const axisColumn = (labelId: number): BoardColumn => ({
  key: `label-${labelId}`,
  title: `col ${labelId}`,
  labelId,
  kind: 'axis',
  cards: [],
});
const noStatus: BoardColumn = {
  key: 'no-status',
  title: 'No status',
  labelId: null,
  kind: 'no-status',
  cards: [],
};
const done: BoardColumn = {
  key: 'done',
  title: 'Done',
  labelId: null,
  kind: 'done',
  cards: [],
};
const axis = [10, 20];

describe('planMove', () => {
  test('between axis columns swaps the axis label, keeps rank + non-axis labels', () => {
    const card = issue({ id: 1, labels: [todo, bug] });
    const plan = planMove(card, axisColumn(20), axis, 'a5');
    expect(plan).toEqual({ rank: 'a5', attach: [20], detach: [10] });
  });

  test('within the same axis column moves rank only (no label churn)', () => {
    const card = issue({ id: 1, labels: [todo] });
    const plan = planMove(card, axisColumn(10), axis, 'a5');
    expect(plan).toEqual({ rank: 'a5', attach: [], detach: [] });
  });

  test('into Done closes and keeps the label', () => {
    const card = issue({ id: 1, labels: [todo] });
    const plan = planMove(card, done, axis, 'a5');
    expect(plan).toEqual({
      rank: 'a5',
      attach: [],
      detach: [],
      state: 'closed',
    });
  });

  test('out of Done into an axis column reopens and sets the new label', () => {
    const card = issue({ id: 1, state: 'closed', labels: [todo] });
    const plan = planMove(card, axisColumn(20), axis, 'a5');
    expect(plan).toEqual({
      rank: 'a5',
      attach: [20],
      detach: [10],
      state: 'open',
    });
  });

  test('into No status reopens and clears every axis label, keeping non-axis labels', () => {
    const card = issue({ id: 1, state: 'closed', labels: [todo, doing, bug] });
    const plan = planMove(card, noStatus, axis, 'a5');
    expect(plan).toEqual({
      rank: 'a5',
      attach: [],
      detach: [10, 20],
      state: 'open',
    });
  });
});

describe('applyPlan', () => {
  const labelById = new Map([todo, doing, bug].map((l) => [l.id, l]));

  test('applies rank, state and the label swap optimistically', () => {
    const card = issue({ id: 1, labels: [todo, bug] });
    const plan = planMove(card, axisColumn(20), axis, 'a5');
    const next = applyPlan(card, plan, labelById);
    expect(next.rank).toBe('a5');
    expect(next.labels.map((l) => l.id).sort((a, b) => a - b)).toEqual([
      20, 99,
    ]);
  });

  test('into Done keeps labels, flips state', () => {
    const card = issue({ id: 1, labels: [todo] });
    const next = applyPlan(card, planMove(card, done, axis, 'a5'), labelById);
    expect(next.state).toBe('closed');
    expect(next.labels.map((l) => l.id)).toEqual([10]);
  });
});

describe('reorderColumnAxis', () => {
  test('moves a column from its old index to the new one', () => {
    expect(reorderColumnAxis([10, 20, 30], 0, 2)).toEqual([20, 30, 10]);
    expect(reorderColumnAxis([10, 20, 30], 2, 0)).toEqual([30, 10, 20]);
    expect(reorderColumnAxis([10, 20, 30], 1, 2)).toEqual([10, 30, 20]);
  });

  test('a no-op move (same index) returns the axis unchanged', () => {
    expect(reorderColumnAxis([10, 20, 30], 1, 1)).toEqual([10, 20, 30]);
  });

  test('an out-of-range source index leaves the axis untouched', () => {
    expect(reorderColumnAxis([10, 20], 5, 0)).toEqual([10, 20]);
  });
});

describe('rankForDrop', () => {
  const cards = [
    issue({ id: 1, rank: 'a0' }),
    issue({ id: 2, rank: 'a1' }),
    issue({ id: 3, rank: 'a2' }),
  ];

  test('to the top lands before the first card', () => {
    expect(rankForDrop(cards, 3, 0) < 'a0').toBe(true);
  });

  test('reorder within a column inserts between the post-removal neighbors', () => {
    // Drag card 1 (a0) down to index 1: neighbors become a1 and a2.
    const r = rankForDrop(cards, 1, 1);
    expect(r > 'a1' && r < 'a2').toBe(true);
  });

  test('to the bottom lands after the last card', () => {
    // Drag card 1 (a0) to the last slot: post-removal neighbors are a2 then nothing.
    expect(rankForDrop(cards, 1, cards.length - 1) > 'a2').toBe(true);
  });
});
