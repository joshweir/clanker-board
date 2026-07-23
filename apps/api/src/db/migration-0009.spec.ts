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

// A throwaway copy of the real migrations folder with 0009 (the migration under
// test) and anything after it removed, so a fresh db can be brought to the
// pre-#82 schema (author_id already backfilled by 0008) and seeded with
// pre-launch issues before 0009 runs on top of it.
function preMigrationFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pre-0009-'));
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cutoff = journal.entries.findIndex(
    (e) => e.tag === '0009_events_foundation',
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

// Exercises the migration's data-moving logic (#79/#82), not just its shape: a
// real pre-launch issue (already authorId-backfilled by 0008) gets exactly one
// materialized `opened` event from its own createdAt + author - the sanctioned
// truthful synthesis, no other history fabricated.
describe('migration 0009 (events foundation)', () => {
  test('materializes one opened event per pre-launch issue from createdAt + author', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: preMigrationFolder() });

    // Pre-#82 shape: author_id already exists (0008 ran), no events table yet.
    const author = sqlite
      .prepare<[], { id: number }>(
        `INSERT INTO actors (name, kind) VALUES ('Human', 'human') RETURNING id`,
      )
      .get();
    const project = sqlite
      .prepare<[], { id: number }>(
        `INSERT INTO projects (key, name) VALUES ('DEMO', 'Demo') RETURNING id`,
      )
      .get();
    if (!author || !project) {
      throw new Error('setup insert did not return a row');
    }
    const issue = sqlite
      .prepare<[number, number], { id: number; createdAt: string }>(
        `INSERT INTO issues (project_id, number, title, type, rank, author_id, created_at)
         VALUES (?, 1, 'Pre-launch issue', 'task', 'a0', ?, '2020-01-01T00:00:00.000Z')
         RETURNING id, created_at AS createdAt`,
      )
      .get(project.id, author.id);
    if (!issue) {
      throw new Error('issue insert did not return a row');
    }

    migrate(db, { migrationsFolder });

    const rows = sqlite
      .prepare<
        [number],
        {
          issueId: number;
          actorId: number;
          type: string;
          data: string;
          createdAt: string;
        }
      >(
        `SELECT issue_id AS issueId, actor_id AS actorId, type, data, created_at AS createdAt
         FROM events WHERE issue_id = ?`,
      )
      .all(issue.id);

    expect(rows).toEqual([
      {
        issueId: issue.id,
        actorId: author.id,
        type: 'opened',
        data: '{}',
        createdAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
  });

  test('fabricates no other event types for pre-launch issues', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: preMigrationFolder() });

    const author = sqlite
      .prepare<[], { id: number }>(
        `INSERT INTO actors (name, kind) VALUES ('Human', 'human') RETURNING id`,
      )
      .get();
    const project = sqlite
      .prepare<[], { id: number }>(
        `INSERT INTO projects (key, name) VALUES ('DEMO', 'Demo') RETURNING id`,
      )
      .get();
    if (!author || !project) {
      throw new Error('setup insert did not return a row');
    }
    sqlite
      .prepare(
        `INSERT INTO issues (project_id, number, title, type, rank, author_id, state)
         VALUES (?, 1, 'Closed pre-launch issue', 'task', 'a0', ?, 'closed')`,
      )
      .run(project.id, author.id);

    migrate(db, { migrationsFolder });

    const types = sqlite
      .prepare<[], { type: string }>('SELECT type FROM events')
      .all()
      .map((r) => r.type);
    // Even a pre-launch issue that is already closed gets only its `opened`
    // synthesis - no fabricated `closed` (or label/blocker/parent) history.
    expect(types).toEqual(['opened']);
  });
});
