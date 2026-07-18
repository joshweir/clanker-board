import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { ensureHumanActor } from './bootstrap';
import { createDb } from './client';
import { actors } from './schema';

// The discoverable human actor is an instance invariant (server boot + seed both
// call this). Pin the idempotency the whole function exists for: kind, not name.
describe('ensureHumanActor', () => {
  test('creates one human actor and returns it again on repeat calls', () => {
    const db = createDb(':memory:');

    const first = ensureHumanActor(db);
    expect(first.kind).toBe('human');

    const second = ensureHumanActor(db);
    expect(second.id).toBe(first.id);

    const humans = db
      .select()
      .from(actors)
      .where(eq(actors.kind, 'human'))
      .all();
    expect(humans).toHaveLength(1);
  });

  test('is idempotent on kind, not name: keeps a renamed human', () => {
    const db = createDb(':memory:');
    const created = ensureHumanActor(db);
    db.update(actors)
      .set({ name: 'Alice' })
      .where(eq(actors.id, created.id))
      .run();

    const again = ensureHumanActor(db);

    expect(again.id).toBe(created.id);
    expect(again.name).toBe('Alice');
    expect(
      db.select().from(actors).where(eq(actors.kind, 'human')).all(),
    ).toHaveLength(1);
  });
});
