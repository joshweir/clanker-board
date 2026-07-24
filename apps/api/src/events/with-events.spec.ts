import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { ensureHumanActor } from '../db/bootstrap';
import { createDb } from '../db/client';
import { events, issues, projects } from '../db/schema';
import { createEventBus } from './bus';
import { withEvents } from './with-events';

// Direct unit tests against a real in-memory SQLite (no mocking of Drizzle,
// SQLite, or the bus - CLAUDE.md), pinning the invariants #76/#82 hang the rest
// of the taxonomy (#84-#87) on: one transaction, buffered post-commit publish.

function seed() {
  const db = createDb(':memory:');
  const actorId = ensureHumanActor(db).id;
  const project = db
    .insert(projects)
    .values({ key: 'DEMO', name: 'Demo' })
    .returning()
    .get();
  const issue = db
    .insert(issues)
    .values({
      projectId: project.id,
      number: 1,
      title: 'Task',
      type: 'bug',
      rank: 'a0',
      authorId: actorId,
    })
    .returning()
    .get();
  return { db, actorId, project, issue };
}

describe('withEvents', () => {
  test('runs the mutation and its event insert in one transaction, then broadcasts', () => {
    const { db, actorId, project, issue } = seed();
    const bus = createEventBus();
    const seen: string[] = [];
    bus.projectChannel(project.id).subscribe((m) => seen.push(m.event));

    const now = '2026-01-01T00:00:00.000Z';
    const row = withEvents(
      db,
      bus,
      { projectId: project.id, actorId, now },
      (tx, emit) => {
        const updated = tx
          .update(issues)
          .set({ title: 'Renamed' })
          .where(eq(issues.id, issue.id))
          .returning()
          .get();
        emit({ issueId: issue.id, type: 'opened', data: {} });
        return updated;
      },
    );

    expect(row.title).toBe('Renamed');
    const stored = db.select().from(events).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      issueId: issue.id,
      actorId,
      type: 'opened',
      data: '{}',
      createdAt: now,
    });
    expect(seen).toEqual(['event.created']);
  });

  test('a rolled-back mutation emits no event and broadcasts nothing', () => {
    const { db, actorId, project, issue } = seed();
    const bus = createEventBus();
    const seen: string[] = [];
    bus.projectChannel(project.id).subscribe((m) => seen.push(m.event));

    expect(() =>
      withEvents(
        db,
        bus,
        { projectId: project.id, actorId, now: new Date().toISOString() },
        (tx, emit) => {
          tx.update(issues)
            .set({ title: 'Doomed' })
            .where(eq(issues.id, issue.id))
            .run();
          emit({ issueId: issue.id, type: 'opened', data: {} });
          throw new Error('boom');
        },
      ),
    ).toThrow('boom');

    expect(db.select().from(events).all()).toEqual([]);
    expect(
      db.select().from(issues).where(eq(issues.id, issue.id)).get()?.title,
    ).toBe('Task');
    expect(seen).toEqual([]);
  });

  test('a no-op mutation (no emit call) broadcasts nothing', () => {
    const { db, actorId, project, issue } = seed();
    const bus = createEventBus();
    const seen: string[] = [];
    bus.projectChannel(project.id).subscribe((m) => seen.push(m.event));

    withEvents(
      db,
      bus,
      { projectId: project.id, actorId, now: new Date().toISOString() },
      (tx) => tx.select().from(issues).where(eq(issues.id, issue.id)).get(),
    );

    expect(db.select().from(events).all()).toEqual([]);
    expect(seen).toEqual([]);
  });

  test('a batch of emits shares one createdAt, ordered by id', () => {
    const { db, actorId, project, issue } = seed();
    const bus = createEventBus();
    const now = '2026-01-01T00:00:00.000Z';

    withEvents(
      db,
      bus,
      { projectId: project.id, actorId, now },
      (_tx, emit) => {
        emit({ issueId: issue.id, type: 'opened', data: {} });
        emit({ issueId: issue.id, type: 'closed', data: {} });
      },
    );

    const stored = db.select().from(events).all();
    expect(stored.map((e) => e.createdAt)).toEqual([now, now]);
    expect(stored.map((e) => e.type)).toEqual(['opened', 'closed']);
    expect(stored).toHaveLength(2);
    const [first, second] = stored;
    if (!first || !second) {
      throw new Error('expected two stored events');
    }
    expect(first.id).toBeLessThan(second.id);
  });
});
