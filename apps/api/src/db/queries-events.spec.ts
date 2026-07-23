import { describe, expect, test } from 'vitest';
import { ensureHumanActor } from './bootstrap';
import { createDb } from './client';
import { eventsForIssue, toEventSnapshot } from './queries';
import { events, issues, projects } from './schema';

// Direct unit tests for the events read path (#82): eventsForIssue is the one
// hot query the events_issue_created_idx index exists for, and toEventSnapshot
// is the shared parse (never cast) both this query and withEvents' post-commit
// publish use.

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
  return { db, actorId, issue };
}

describe('eventsForIssue', () => {
  test('orders by (createdAt, id), independent of insertion order', () => {
    const { db, actorId, issue } = seed();
    // Insert out of createdAt order, and with a tied createdAt pair (mirrors a
    // withEvents batch) to prove id is the tiebreak, not insertion order.
    db.insert(events)
      .values([
        {
          issueId: issue.id,
          actorId,
          type: 'closed',
          data: '{}',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          issueId: issue.id,
          actorId,
          type: 'opened',
          data: '{}',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          issueId: issue.id,
          actorId,
          type: 'reopened',
          data: '{}',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ])
      .run();

    const list = eventsForIssue(db, issue.id);
    expect(list.map((e) => e.type)).toEqual(['opened', 'reopened', 'closed']);
  });

  test('scopes to the given issue only', () => {
    const { db, actorId, issue } = seed();
    const other = db
      .insert(issues)
      .values({
        projectId: issue.projectId,
        number: 2,
        title: 'Other',
        type: 'bug',
        rank: 'a1',
        authorId: actorId,
      })
      .returning()
      .get();
    db.insert(events)
      .values([
        { issueId: issue.id, actorId, type: 'opened', data: '{}' },
        { issueId: other.id, actorId, type: 'opened', data: '{}' },
      ])
      .run();

    expect(eventsForIssue(db, issue.id)).toHaveLength(1);
    expect(eventsForIssue(db, other.id)).toHaveLength(1);
  });

  test('toEventSnapshot parses the JSON data column against the union', () => {
    const { db, actorId, issue } = seed();
    const row = db
      .insert(events)
      .values({
        issueId: issue.id,
        actorId,
        type: 'labeled',
        data: JSON.stringify({ labelId: 1, name: 'bug' }),
      })
      .returning()
      .get();

    expect(toEventSnapshot(row)).toMatchObject({
      type: 'labeled',
      data: { labelId: 1, name: 'bug' },
    });
  });
});
