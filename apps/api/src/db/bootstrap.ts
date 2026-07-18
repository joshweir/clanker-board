import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { actors } from './schema';

// Every running instance gets one discoverable human actor so agents can hand a
// ticket back to a person: convention is "assign to the first kind='human'
// actor". Idempotent on kind, not name, so renaming "Human" to a real name
// keeps the invariant. Called from server boot (and mirrored by the seed).
export function ensureHumanActor(db: Db) {
  const existing = db
    .select()
    .from(actors)
    .where(eq(actors.kind, 'human'))
    .get();
  return (
    existing ??
    db.insert(actors).values({ name: 'Human', kind: 'human' }).returning().get()
  );
}
