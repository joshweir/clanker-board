import { z } from 'zod';

// The full event taxonomy (#72/#79 "Implementation Decisions"): a mutation emits
// an event when it changes something others reason about. This ticket (#82) only
// ever *emits* `opened` (on create); the other 17 types are wired by their own
// tickets (#84-#87). The whole taxonomy is declared here up front because the
// `events.type` column and its data union are schema, not per-emit-site: adding a
// type later would mean another migration, which the "one uniform read path"
// decision (#79) explicitly avoids.
export const EVENT_TYPES = [
  // Lifecycle (#84): data: {}.
  'opened',
  'closed',
  'reopened',
  // Field (#84): {from, to}.
  'renamed',
  'typed',
  // Involvement (#84): {assigneeActorId}. Claim / claim-next fold into `assigned`;
  // self-vs-other is derived (event.actorId === assigneeActorId), not stored.
  'assigned',
  'unassigned',
  // Labels (#85): {labelId, name} - name is frozen render text.
  'labeled',
  'unlabeled',
  // Relationships (#86, two-sided - each edge change emits on both issues, same
  // actor + timestamp), counterpart snapshot {projectKey, number, title}.
  'parent_added',
  'parent_removed',
  'sub_issue_added',
  'sub_issue_removed',
  'blocked_by_added',
  'blocked_by_removed',
  'blocking_added',
  'blocking_removed',
  // Cross-reference (#87): {projectKey, number, title}, written to the target
  // issue only, snapshot is the source issue.
  'mentioned',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// Payload shapes (#79 "Snapshot principle"): snapshot only the non-derivable and
// non-live-resolvable. Actor ids are resolved live elsewhere (actors are never
// deleted); a label/counterpart snapshot freezes its render text so a later
// rename/delete of the referent never rewrites history.
const EmptyData = z.object({}).strict();

const FromToData = z.object({ from: z.string(), to: z.string() }).strict();

const AssigneeData = z
  .object({ assigneeActorId: z.number().int().positive() })
  .strict();

const LabelData = z
  .object({ labelId: z.number().int().positive(), name: z.string() })
  .strict();

// {projectKey}-{number} is the derived KEY-N handle (never stored); title is
// frozen render text. Shared by every relationship + mention event.
const CounterpartData = z
  .object({
    projectKey: z.string(),
    number: z.number().int().positive(),
    title: z.string(),
  })
  .strict();

// One {type, data} pair per taxonomy entry - the single source both the storage
// validator and the API/SSE read schema derive from (never duplicated, never
// cast). Order matches EVENT_TYPES.
const EVENT_VARIANTS = [
  z.object({ type: z.literal('opened'), data: EmptyData }),
  z.object({ type: z.literal('closed'), data: EmptyData }),
  z.object({ type: z.literal('reopened'), data: EmptyData }),
  z.object({ type: z.literal('renamed'), data: FromToData }),
  z.object({ type: z.literal('typed'), data: FromToData }),
  z.object({ type: z.literal('assigned'), data: AssigneeData }),
  z.object({ type: z.literal('unassigned'), data: AssigneeData }),
  z.object({ type: z.literal('labeled'), data: LabelData }),
  z.object({ type: z.literal('unlabeled'), data: LabelData }),
  z.object({ type: z.literal('parent_added'), data: CounterpartData }),
  z.object({ type: z.literal('parent_removed'), data: CounterpartData }),
  z.object({ type: z.literal('sub_issue_added'), data: CounterpartData }),
  z.object({ type: z.literal('sub_issue_removed'), data: CounterpartData }),
  z.object({ type: z.literal('blocked_by_added'), data: CounterpartData }),
  z.object({ type: z.literal('blocked_by_removed'), data: CounterpartData }),
  z.object({ type: z.literal('blocking_added'), data: CounterpartData }),
  z.object({ type: z.literal('blocking_removed'), data: CounterpartData }),
  z.object({ type: z.literal('mentioned'), data: CounterpartData }),
] as const;

// Validates a {type, data} pair against the union for its type (never cast) -
// storage-side guard used by withEvents before every insert.
export const EventPayloadSchema = z.discriminatedUnion('type', EVENT_VARIANTS);

export type EventPayload = z.infer<typeof EventPayloadSchema>;

// The full stored+parsed row shape (id/issueId/actorId/createdAt + the typed
// payload), used for the API response and the event.created SSE frame: each
// payload variant extended with the row columns the JSON `data` column doesn't
// carry, so the discriminated union covers the whole row, not just data. Written
// out explicitly (never derived via a cast) so the tuple type stays a real
// literal union, matching EVENT_VARIANTS one-for-one.
const row = <T extends z.ZodRawShape>(shape: T) =>
  z.object({
    id: z.number().int().positive(),
    issueId: z.number().int().positive(),
    actorId: z.number().int().positive(),
    createdAt: z.string(),
    ...shape,
  });

export const EventSchema = z.discriminatedUnion('type', [
  row({ type: z.literal('opened'), data: EmptyData }),
  row({ type: z.literal('closed'), data: EmptyData }),
  row({ type: z.literal('reopened'), data: EmptyData }),
  row({ type: z.literal('renamed'), data: FromToData }),
  row({ type: z.literal('typed'), data: FromToData }),
  row({ type: z.literal('assigned'), data: AssigneeData }),
  row({ type: z.literal('unassigned'), data: AssigneeData }),
  row({ type: z.literal('labeled'), data: LabelData }),
  row({ type: z.literal('unlabeled'), data: LabelData }),
  row({ type: z.literal('parent_added'), data: CounterpartData }),
  row({ type: z.literal('parent_removed'), data: CounterpartData }),
  row({ type: z.literal('sub_issue_added'), data: CounterpartData }),
  row({ type: z.literal('sub_issue_removed'), data: CounterpartData }),
  row({ type: z.literal('blocked_by_added'), data: CounterpartData }),
  row({ type: z.literal('blocked_by_removed'), data: CounterpartData }),
  row({ type: z.literal('blocking_added'), data: CounterpartData }),
  row({ type: z.literal('blocking_removed'), data: CounterpartData }),
  row({ type: z.literal('mentioned'), data: CounterpartData }),
]);

export type Event = z.infer<typeof EventSchema>;
