import type { Db } from '../db/client';
import { toEventSnapshot } from '../db/queries';
import { events } from '../db/schema';
import { EventPayloadSchema, type EventPayload } from '../domain/events';
import type { EventBus } from './bus';

// The transaction-scoped handle a withEvents callback runs its own mutation on
// (#82/#76) - inferred from Db['transaction'] itself so it can never drift from
// the real drizzle type.
type Tx = Parameters<Db['transaction']>[0] extends (tx: infer T) => unknown
  ? T
  : never;

export type EmitInput = { issueId: number } & EventPayload;

export type Emit = (input: EmitInput) => void;

// Centralized transaction-aware event-emission spine (#76/#82). The CALLER stays
// authority on which semantic events fire (auto-diff cannot see actor intent,
// two-sided relationships, or mentions); this helper owns validate-against-the-
// union -> insert -> publish-post-commit:
//
// - `fn` runs inside one db.transaction() alongside its own mutation (via `tx`),
//   so the mutation and every event it emits commit or roll back together.
// - Every emitted row shares one `createdAt` (`now`, passed in by the caller -
//   reusing its own "now" rather than this helper minting a second one) and one
//   acting `actorId` - the batch's timestamp and actor are invariant, matching
//   the two-sided-pair "same actor + timestamp" rule.
// - SSE broadcasts are buffered and flushed ONLY after the transaction commits:
//   a rolled-back mutation (fn throws) never reaches the flush loop, so it never
//   broadcasts a phantom event (the insert itself is rolled back too, same txn).
// - A no-op mutation that never calls `emit` broadcasts nothing - idempotency is
//   the caller's job (redundant attach, unchanged PATCH field, zero-row unblock),
//   not this helper's.
export function withEvents<T>(
  db: Db,
  bus: EventBus,
  ctx: { projectId: number; actorId: number; now: string },
  fn: (tx: Tx, emit: Emit) => T,
): T {
  const buffered: (typeof events.$inferSelect)[] = [];
  const result = db.transaction((tx) => {
    const emit: Emit = (input) => {
      // Validated against the discriminated union, never cast (CLAUDE.md) - the
      // stored `data` column is exactly this payload's `data`, JSON-serialized.
      const payload = EventPayloadSchema.parse({
        type: input.type,
        data: input.data,
      });
      const row = tx
        .insert(events)
        .values({
          issueId: input.issueId,
          actorId: ctx.actorId,
          type: payload.type,
          data: JSON.stringify(payload.data),
          createdAt: ctx.now,
        })
        .returning()
        .get();
      buffered.push(row);
    };
    return fn(tx, emit);
  });
  for (const stored of buffered) {
    bus.publishEventCreated(ctx.projectId, toEventSnapshot(stored));
  }
  return result;
}
