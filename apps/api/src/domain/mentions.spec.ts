import { describe, expect, test } from 'vitest';
import { ensureHumanActor } from '../db/bootstrap';
import { createDb } from '../db/client';
import { issues, projects } from '../db/schema';
import {
  newlyMentionedTargets,
  resolveMentions,
  stripCodeSpans,
} from './mentions';

// Pure-unit (stripCodeSpans) + direct-db unit (resolveMentions,
// newlyMentionedTargets) - the DB-touching half needs a real project/issue
// pair to resolve against, so it follows db/queries-events.spec.ts's "direct
// unit test against a real in-memory db" prior art rather than going through
// the HTTP route layer (that full-stack behavior - the emitted event, its
// actor, its txn atomicity - is Seam 1's job in issues.spec.ts/comments.spec.ts).

describe('stripCodeSpans', () => {
  test('drops a fenced code block entirely', () => {
    expect(stripCodeSpans('see ```DEMO-1``` here')).toBe('see  here');
  });

  test('drops an inline backtick span', () => {
    expect(stripCodeSpans('see `DEMO-1` here')).toBe('see  here');
  });

  test('leaves plain mentions untouched', () => {
    expect(stripCodeSpans('see #DEMO-1 here')).toBe('see #DEMO-1 here');
  });

  test('a fence does not swallow a real mention outside it', () => {
    expect(stripCodeSpans('#DEMO-1 then ```code #DEMO-2``` then #DEMO-3')).toBe(
      '#DEMO-1 then  then #DEMO-3',
    );
  });
});

function seed() {
  const db = createDb(':memory:');
  const actorId = ensureHumanActor(db).id;
  const project = db
    .insert(projects)
    .values({ key: 'DEMO', name: 'Demo' })
    .returning()
    .get();
  const other = db
    .insert(projects)
    .values({ key: 'FOO', name: 'Foo' })
    .returning()
    .get();
  const makeIssue = (projectId: number, number: number, title: string) =>
    db
      .insert(issues)
      .values({
        projectId,
        number,
        title,
        type: 'bug',
        rank: 'a0',
        authorId: actorId,
      })
      .returning()
      .get();
  const source = makeIssue(project.id, 1, 'Source');
  const target = makeIssue(project.id, 2, 'Target');
  const foreignTarget = makeIssue(
    other.id,
    2,
    'Foreign target with same number',
  );
  return { db, project, other, source, target, foreignTarget };
}

describe('resolveMentions', () => {
  test('resolves a bare #N against the current project', () => {
    const { db, project, source, target } = seed();
    const targets = resolveMentions(
      db,
      project.id,
      project.key,
      source.id,
      `see #${target.number}`,
    );
    expect(targets).toEqual(new Set([target.id]));
  });

  test('resolves an explicit KEY-N and a hashed #KEY-N the same way', () => {
    const { db, project, source, target } = seed();
    expect(
      resolveMentions(db, project.id, project.key, source.id, 'DEMO-2'),
    ).toEqual(new Set([target.id]));
    expect(
      resolveMentions(db, project.id, project.key, source.id, '#DEMO-2'),
    ).toEqual(new Set([target.id]));
  });

  test('drops a self-mention', () => {
    const { db, project, source } = seed();
    const targets = resolveMentions(
      db,
      project.id,
      project.key,
      source.id,
      `see #${source.number}`,
    );
    expect(targets.size).toBe(0);
  });

  test('drops a foreign-project explicit key, even if that project+number exists', () => {
    const { db, project, source, foreignTarget } = seed();
    expect(foreignTarget.number).toBe(2); // same number as an in-project target
    const targets = resolveMentions(
      db,
      project.id,
      project.key,
      source.id,
      'FOO-2',
    );
    expect(targets.size).toBe(0);
  });

  test('drops an unresolved number (no such issue in this project)', () => {
    const { db, project, source } = seed();
    const targets = resolveMentions(
      db,
      project.id,
      project.key,
      source.id,
      'see #99999',
    );
    expect(targets.size).toBe(0);
  });

  test('drops a code-span reference', () => {
    const { db, project, source, target } = seed();
    const targets = resolveMentions(
      db,
      project.id,
      project.key,
      source.id,
      `\`#${target.number}\``,
    );
    expect(targets.size).toBe(0);
  });

  test('de-dupes repeated references to the same target within one source', () => {
    const { db, project, source, target } = seed();
    const targets = resolveMentions(
      db,
      project.id,
      project.key,
      source.id,
      `#${target.number} again #${target.number}`,
    );
    expect(targets).toEqual(new Set([target.id]));
  });
});

describe('newlyMentionedTargets', () => {
  test('only the newly-added reference fires, the pre-existing one does not', () => {
    const { db, project, source, target, foreignTarget: extra } = seed();
    void extra;
    const fresh = newlyMentionedTargets(
      db,
      project.id,
      project.key,
      source.id,
      `already mentions #${target.number}`,
      `already mentions #${target.number} and now #${target.number}`,
    );
    expect(fresh.size).toBe(0); // same target, still just one reference-worth
  });

  test('fires only for a genuinely new target added by the edit', () => {
    const { db, project, source, target } = seed();
    const secondTarget = db
      .insert(issues)
      .values({
        projectId: project.id,
        number: 3,
        title: 'Second target',
        type: 'bug',
        rank: 'a1',
        authorId: source.authorId,
      })
      .returning()
      .get();
    const fresh = newlyMentionedTargets(
      db,
      project.id,
      project.key,
      source.id,
      `mentions #${target.number}`,
      `mentions #${target.number} and #${secondTarget.number}`,
    );
    expect(fresh).toEqual(new Set([secondTarget.id]));
  });

  test('removing a mention fires nothing (no retraction event)', () => {
    const { db, project, source, target } = seed();
    const fresh = newlyMentionedTargets(
      db,
      project.id,
      project.key,
      source.id,
      `mentions #${target.number}`,
      'mentions nothing now',
    );
    expect(fresh.size).toBe(0);
  });
});
