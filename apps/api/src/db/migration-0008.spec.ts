import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, test } from 'vitest';
import * as schema from './schema';

const migrationsFolder = join(import.meta.dirname, '../../drizzle');

// A throwaway copy of the real migrations folder with 0008 and everything after
// it removed, so a fresh db can be brought to the pre-#81 schema and seeded with
// legacy data before 0008 (the migration under test) runs on top of it. Cuts at
// 0008 rather than naming every later migration by tag, so a migration added
// after 0008 (e.g. #82's 0009, which reads the author_id column 0008 adds)
// doesn't reintroduce this same "no such column" break on its own arrival.
function preMigrationFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pre-0008-'));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cutoff = journal.entries.findIndex(
    (e) => e.tag === '0008_issues_author_id',
  );
  const [kept, dropped] = [
    journal.entries.slice(0, cutoff),
    journal.entries.slice(cutoff),
  ];
  journal.entries = kept;
  writeFileSync(journalPath, JSON.stringify(journal));
  for (const entry of dropped) {
    rmSync(join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

// Exercises the migration's actual data-moving logic (#81), not just its shape:
// a real pre-existing "Web" actor's attributions are reassigned to the lowest-id
// human, Web itself is removed, and every pre-existing issue is backfilled to
// that same author - the exact acceptance criterion ("no attribution lost").
describe('migration 0008 (issues.authorId)', () => {
  test('collapses a distinct Web human actor into H and backfills authorId', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: preMigrationFolder() });

    // Legacy pre-#81 shape: a "Human" actor already exists (lower id, H), and a
    // separate lazy "Web" browser identity (higher id) holds an assignment and
    // authored a comment - exactly what the SPA created before this ticket.
    const human = sqlite
      .prepare<[], { id: number }>(
        `INSERT INTO actors (name, kind) VALUES ('Human', 'human') RETURNING id`,
      )
      .get();
    const web = sqlite
      .prepare<[], { id: number }>(
        `INSERT INTO actors (name, kind) VALUES ('Web', 'human') RETURNING id`,
      )
      .get();
    const project = sqlite
      .prepare<[], { id: number }>(
        `INSERT INTO projects (key, name) VALUES ('DEMO', 'Demo') RETURNING id`,
      )
      .get();
    if (!human || !web || !project) {
      throw new Error('setup insert did not return a row');
    }
    const issue = sqlite
      .prepare<[number, number], { id: number }>(
        `INSERT INTO issues (project_id, number, title, type, rank, assignee_id)
         VALUES (?, 1, 'Wire it up', 'task', 'a0', ?) RETURNING id`,
      )
      .get(project.id, web.id);
    if (!issue) {
      throw new Error('issue insert did not return a row');
    }
    sqlite
      .prepare<[number, number]>(
        `INSERT INTO comments (issue_id, actor_id, body) VALUES (?, ?, 'note')`,
      )
      .run(issue.id, web.id);

    migrate(db, { migrationsFolder });

    const actors = sqlite
      .prepare<[], { name: string }>('SELECT name FROM actors')
      .all();
    expect(actors.map((a) => a.name)).toEqual(['Human']);

    const updatedIssue = sqlite
      .prepare<[number], { assigneeId: number; authorId: number }>(
        'SELECT assignee_id AS assigneeId, author_id AS authorId FROM issues WHERE id = ?',
      )
      .get(issue.id);
    expect(updatedIssue?.assigneeId).toBe(human.id);
    expect(updatedIssue?.authorId).toBe(human.id);

    const comment = sqlite
      .prepare<[number], { actorId: number }>(
        'SELECT actor_id AS actorId FROM comments WHERE issue_id = ?',
      )
      .get(issue.id);
    expect(comment?.actorId).toBe(human.id);
  });
});
