import { describe, expect, test } from 'vitest';
import type { BoardSnapshot } from '../db/queries';
import { createEventBus } from './bus';

// Direct unit tests for the in-memory pub/sub the SSE routes fan out over. The
// route specs exercise delivery end-to-end; these pin the Channel lifecycle
// (unsubscribe + close) the routes rely on to avoid leaked/orphaned streams.
const board = (projectId: number): BoardSnapshot => ({
  id: projectId,
  projectId,
  columnAxis: [],
  createdAt: 'now',
  updatedAt: 'now',
});

describe('event bus channels', () => {
  test('delivers each published message to every subscriber', () => {
    const bus = createEventBus();
    const a: string[] = [];
    const b: string[] = [];
    const channel = bus.projectChannel(1);
    channel.subscribe((m) => a.push(m.event));
    channel.subscribe((m) => b.push(m.event));

    bus.publishBoardChanged(1, board(1));

    expect(a).toEqual(['board.changed']);
    expect(b).toEqual(['board.changed']);
  });

  test('unsubscribe removes the listener (no delivery after teardown)', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const channel = bus.projectChannel(1);
    const unsubscribe = channel.subscribe((m) => seen.push(m.event));

    unsubscribe();
    bus.publishBoardChanged(1, board(1));

    expect(seen).toEqual([]);
  });

  test('a message on one project channel never reaches another', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.projectChannel(1).subscribe((m) => seen.push(m.event));

    bus.publishBoardChanged(2, board(2));

    expect(seen).toEqual([]);
  });

  test('deleting a project closes its channel: onClose fires and listeners drop', () => {
    const bus = createEventBus();
    const channel = bus.projectChannel(1);
    let closed = false;
    const seen: string[] = [];
    channel.subscribe((m) => seen.push(m.event));
    channel.onClose(() => {
      closed = true;
    });

    bus.publishProjectDeleted(1);

    expect(closed).toBe(true);
    // The map entry is gone, so this publishes on a fresh channel - the old
    // subscriber, dropped by close(), stays silent (no leak of a dead stream).
    bus.publishBoardChanged(1, board(1));
    expect(seen).toEqual([]);
  });

  test('onClose can be unregistered before the channel closes', () => {
    const bus = createEventBus();
    const channel = bus.projectChannel(1);
    let fired = false;
    const off = channel.onClose(() => {
      fired = true;
    });

    off();
    bus.publishProjectDeleted(1);

    expect(fired).toBe(false);
  });
});
