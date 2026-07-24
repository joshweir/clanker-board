import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { Actor, Comment, IssueEvent } from '../api';
import { formatOpened } from '../lib/relative-time';
import { colorFor } from '../type-color';
import { ActorName } from './actor-name';
import { Markdown } from './markdown';
import type { MentionableIssue } from './remark-mentions';

// GitHub-style activity rail (#77/#83): events and comments merged into one
// date-ordered stream. Variant A "Classic rail" - locked, reproduced exactly from
// `prototype/77-timeline-ui-wip` @ 8ecd052: one continuous vertical spine, event
// icons sit on it, comments are full-width cards the spine runs behind, the
// composer sits at the very bottom.
//
// #83 laid down the rail rendering comments and the `opened` event (itself
// dropped from the rail below, because the description card above already
// reads "<author> opened <when>"). #84 adds real phrasing/icons for the
// lifecycle (`closed`/`reopened`), field (`renamed`/`typed`) and involvement
// (`assigned`/`unassigned`) shapes; #85 adds the label chip wording (`labeled`/
// `unlabeled`); #87 adds the `mentioned` wording plus its link back to the
// source issue. #86 adds the relationship family (two-sided parent/sub-issue/
// blocked-by/blocking edges), rendered outside `eventLine` entirely -
// `groupTimeline` folds adjacent same-type same-actor runs into one row with
// counterpart links below. The merge, ordering and rail layout never change.

type TimelineNode =
  | { kind: 'event'; key: string; event: IssueEvent }
  | { kind: 'comment'; key: string; comment: Comment };

// Merge + order two independent id sequences by (createdAt, id) - the same rule
// the API applies within a single batch (#79 "Event-generation architecture") and
// the one this component's live SSE appends preserve.
export function mergeTimeline(
  events: IssueEvent[],
  comments: Comment[],
): TimelineNode[] {
  const nodes: TimelineNode[] = [
    ...events.map((event) => ({
      kind: 'event' as const,
      key: `event-${event.id}`,
      event,
    })),
    ...comments.map((comment) => ({
      kind: 'comment' as const,
      key: `comment-${comment.id}`,
      comment,
    })),
  ];
  const createdAt = (n: TimelineNode) =>
    n.kind === 'event' ? n.event.createdAt : n.comment.createdAt;
  const id = (n: TimelineNode) =>
    n.kind === 'event' ? n.event.id : n.comment.id;
  return nodes.sort((a, b) => {
    const [ca, cb] = [createdAt(a), createdAt(b)];
    return ca === cb ? id(a) - id(b) : ca < cb ? -1 : 1;
  });
}

// A label's chip, colored via `colorFor(labelId)` (#85) - color is never stored
// (labels have no color column), so it is re-derived here from the frozen
// {labelId, name} snapshot on the event, not read live off the label.
function labelChip({ labelId, name }: { labelId: number; name: string }) {
  const { bg, fg } = colorFor(labelId);
  return (
    <span
      className="label-chip"
      style={{ backgroundColor: bg, color: fg, borderColor: bg }}
    >
      {name}
    </span>
  );
}

// The self-contained one-liner phrasing for an event type, GitHub-style ("<actor>
// <predicate> <time>"). `opened` never actually reaches here (filtered below,
// kept for completeness). Lifecycle/field/involvement (#84), labels (#85) and
// mentions (#87) all render real wording here; the relationship family (#86,
// below) never reaches this switch either - `groupTimeline` peels those event
// types off into their own grouped rendering with counterpart links.
function eventLine(event: IssueEvent, actors: Actor[]): ReactNode {
  switch (event.type) {
    case 'opened':
      return 'opened this';
    case 'mentioned':
      return 'mentioned this from';
    case 'closed':
      return 'closed this';
    case 'reopened':
      return 'reopened this';
    case 'renamed':
      return (
        <>
          renamed this from "{event.data.from}" to "{event.data.to}"
        </>
      );
    case 'typed':
      return (
        <>
          changed the type from{' '}
          <span className="issue-type-badge issue-type-badge-old">
            {event.data.from}
          </span>{' '}
          to <span className="issue-type-badge">{event.data.to}</span>
        </>
      );
    case 'assigned':
      // Self-vs-other is derived here, never stored (#84): the acting actor
      // claiming/assigning themselves reads "self-assigned"; anyone assigning
      // someone else names the assignee via the shared actor-display helper.
      return event.actorId === event.data.assigneeActorId ? (
        'self-assigned this'
      ) : (
        <>
          assigned{' '}
          <ActorName actorId={event.data.assigneeActorId} actors={actors} />
        </>
      );
    case 'unassigned':
      return event.actorId === event.data.assigneeActorId ? (
        'removed their assignment'
      ) : (
        <>
          unassigned{' '}
          <ActorName actorId={event.data.assigneeActorId} actors={actors} />
        </>
      );
    case 'labeled':
      return <>added {labelChip(event.data)}</>;
    case 'unlabeled':
      return <>removed {labelChip(event.data)}</>;
    default:
      return event.type;
  }
}

// The 8 two-sided relationship shapes (#86): the one family this ticket renders
// with counterpart links + adjacency grouping. `Extract` (not a cast) narrows
// `IssueEvent`'s discriminated union down to just these types' `.data` shape
// (`{projectKey, number, title}` - domain/events.ts's CounterpartData).
const RELATIONSHIP_TYPES = [
  'parent_added',
  'parent_removed',
  'sub_issue_added',
  'sub_issue_removed',
  'blocked_by_added',
  'blocked_by_removed',
  'blocking_added',
  'blocking_removed',
] as const;
type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];
type RelationshipEvent = Extract<IssueEvent, { type: RelationshipType }>;

function isRelationshipEvent(event: IssueEvent): event is RelationshipEvent {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(event.type);
}

// The blocking-DAG half of the family (as opposed to the parent-tree half):
// renders with the octagon+minus-bar icon instead of the plain status dot.
const BLOCKING_TYPES = new Set<RelationshipType>([
  'blocked_by_added',
  'blocked_by_removed',
  'blocking_added',
  'blocking_removed',
]);

// One header phrase per relationship type, singular or plural (GitHub adjacency
// grouping, #86): "<actor> <phrase> <time>", counterpart links listed below.
function relationshipLabel(type: RelationshipType, count: number): string {
  const n = count > 1 ? count : null;
  switch (type) {
    case 'parent_added':
      return n ? `added ${n} parents` : 'added a parent';
    case 'parent_removed':
      return n ? `removed ${n} parents` : 'removed a parent';
    case 'sub_issue_added':
      return n ? `added ${n} sub-issues` : 'added a sub-issue';
    case 'sub_issue_removed':
      return n ? `removed ${n} sub-issues` : 'removed a sub-issue';
    case 'blocked_by_added':
      return n
        ? `marked this as blocked by ${n} issues`
        : 'marked this as blocked';
    case 'blocked_by_removed':
      return n ? `removed ${n} blocking issues` : 'removed a blocking issue';
    case 'blocking_added':
      return n
        ? `marked this as blocking ${n} issues`
        : 'marked this as blocking';
    case 'blocking_removed':
      return n ? `removed ${n} blocked issues` : 'removed a blocked issue';
  }
}

// A run of adjacent relationship events, same type + same actor, folded into one
// row (#86 "GitHub adjacency" grouping - no time window, any other item between
// them breaks the run). A lone event is a group of one; the render is identical.
export interface EventGroup {
  kind: 'event-group';
  key: string;
  type: RelationshipType;
  actorId: number;
  createdAt: string;
  events: RelationshipEvent[];
}

export type DisplayNode =
  | { kind: 'comment'; key: string; comment: Comment }
  | { kind: 'event'; key: string; event: IssueEvent }
  | EventGroup;

// Fold `mergeTimeline`'s already-ordered nodes into display nodes: consecutive
// relationship events of the same type by the same actor merge into one group
// (labelled with the LATEST event's time); everything else (comments, every
// other event shape) passes through unchanged and breaks any run it interrupts.
export function groupTimeline(nodes: TimelineNode[]): DisplayNode[] {
  const out: DisplayNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'event' && isRelationshipEvent(node.event)) {
      const last = out[out.length - 1];
      if (
        last?.kind === 'event-group' &&
        last.type === node.event.type &&
        last.actorId === node.event.actorId
      ) {
        last.events.push(node.event);
        last.createdAt = node.event.createdAt;
        continue;
      }
      out.push({
        kind: 'event-group',
        key: `group-${node.event.id}`,
        type: node.event.type,
        actorId: node.event.actorId,
        createdAt: node.event.createdAt,
        events: [node.event],
      });
      continue;
    }
    out.push(node);
  }
  return out;
}

// Live status of a counterpart, resolved against the project's already-loaded
// issue set (same mechanism as mention resolution, #88) - the stored event data
// never carries state, only the frozen {projectKey, number, title} snapshot. A
// counterpart absent from the set (deleted since - #86 "snapshot, not a
// reference") renders muted, same as a closed one: there's no live state left to
// show, and a struck-through look reads as "no longer there" either way.
function counterpartOpen(
  number: number,
  issues: readonly MentionableIssue[],
): boolean {
  return issues.find((i) => i.number === number)?.state === 'open';
}

// One relationship counterpart, rendered as a single link with a continuous
// underline: [status glyph] [title, fg] [KEY-N, muted] (#86). The blocking half
// of the family (blocked_by_*/blocking_*) swaps the plain status dot for an
// octagon + horizontal minus-bar icon. Opens the target's own page in a new tab,
// mirroring IssueKeyLink (#40).
function CounterpartLink({
  data,
  blocking,
  issues,
}: {
  data: RelationshipEvent['data'];
  blocking: boolean;
  issues: readonly MentionableIssue[];
}) {
  const slug = data.projectKey.toLowerCase();
  const open = counterpartOpen(data.number, issues);
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(data.number) }}
      target="_blank"
      rel="noopener"
      className="counterpart-link"
    >
      {blocking ? (
        <svg
          className="counterpart-blocked-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polygon points="7.86,2 16.14,2 22,7.86 22,16.14 16.14,22 7.86,22 2,16.14 2,7.86" />
          <line x1="7" y1="12" x2="17" y2="12" />
        </svg>
      ) : (
        <span
          className={
            open ? 'counterpart-dot' : 'counterpart-dot counterpart-dot-closed'
          }
          aria-hidden="true"
        />
      )}
      <span className="counterpart-title">{data.title}</span>
      <span className="counterpart-id">
        {data.projectKey}-{data.number}
      </span>
    </Link>
  );
}

// The `mentioned` row's link back to the SOURCE issue (#87): a plain `<a>`
// (not the router's `Link`) opening in a new tab, mirroring `IssueKeyLink`
// (#40) / the mention-link convention already used in rendered markdown
// (`remark-mentions.ts`'s href shape, `markdown.tsx`'s target/rel) - a
// snapshot link, not a router navigation, so this component stays free of a
// router-context dependency.
function mentionSourceLink(
  event: IssueEvent,
): { href: string; label: string } | null {
  if (event.type !== 'mentioned') return null;
  const { projectKey, number, title } = event.data;
  return {
    href: `/projects/${projectKey.toLowerCase()}/issues/${number}`,
    label: `${projectKey}-${number} ${title}`,
  };
}

// The rail marker for a lifecycle event (#84): `closed`/`reopened` swap the
// plain neutral dot for their own status glyph (same ~1.5rem band, no ring) so
// the rail itself shows the state transition, not just its wording. Every other
// event type keeps the plain dot.
function statusDot(event: IssueEvent): ReactNode {
  if (event.type === 'closed') {
    return (
      <span className="timeline-dot timeline-dot-closed" aria-hidden="true">
        ✓
      </span>
    );
  }
  if (event.type === 'reopened') {
    return (
      <span className="timeline-dot timeline-dot-open" aria-hidden="true" />
    );
  }
  return <span className="timeline-dot" aria-hidden="true" />;
}

export function Timeline({
  events,
  comments,
  actors,
  freshKeys,
  mentions,
  composer,
}: {
  events: IssueEvent[];
  comments: Comment[];
  actors: Actor[];
  // Live-inserted rows get a brief flash so a busy issue's new activity is easy to
  // spot without a refresh (#83 "Live: new events + comments appear without
  // refresh"); keyed the same as each node (`event-<id>` / `comment-<id>`).
  freshKeys: Set<string>;
  // Mention-link resolver input (#88), forwarded to each comment's `Markdown` body -
  // same shape IssueDetail already passes the description.
  mentions?: {
    projectKey: string;
    issues: readonly MentionableIssue[];
  };
  // The comment composer is owned by IssueDetail (real autosave/submit wiring) -
  // this component only places it at the bottom of the stream.
  composer: ReactNode;
}) {
  const nodes = groupTimeline(
    mergeTimeline(events, comments).filter(
      (n) => !(n.kind === 'event' && n.event.type === 'opened'),
    ),
  );
  const counterpartIssues = mentions?.issues ?? [];
  return (
    <section className="timeline" aria-label="Activity">
      <ol className="timeline-rail">
        {nodes.map((node) => {
          const fresh = freshKeys.has(node.key) ? ' timeline-fresh' : '';
          if (node.kind === 'comment') {
            const { comment } = node;
            return (
              <li
                key={node.key}
                className={`timeline-node timeline-node-comment${fresh}`}
              >
                <div className="comment">
                  <div className="comment-meta">
                    <span className="comment-author">
                      <ActorName actorId={comment.actorId} actors={actors} />
                    </span>
                    <time className="comment-when" dateTime={comment.createdAt}>
                      {formatOpened(comment.createdAt)}
                    </time>
                  </div>
                  <div className="comment-body">
                    <Markdown source={comment.body} mentions={mentions} />
                  </div>
                </div>
              </li>
            );
          }

          if (node.kind === 'event-group') {
            const blocking = BLOCKING_TYPES.has(node.type);
            return (
              <li
                key={node.key}
                className={`timeline-node timeline-node-event${fresh}`}
              >
                <span className="timeline-dot" aria-hidden="true" />
                <p className="timeline-line">
                  <ActorName actorId={node.actorId} actors={actors} />{' '}
                  {relationshipLabel(node.type, node.events.length)}{' '}
                  <time dateTime={node.createdAt}>
                    {formatOpened(node.createdAt)}
                  </time>
                </p>
                <ul className="timeline-counterparts">
                  {node.events.map((event) => (
                    <li key={event.id}>
                      <CounterpartLink
                        data={event.data}
                        blocking={blocking}
                        issues={counterpartIssues}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            );
          }

          const { event } = node;
          const source = mentionSourceLink(event);
          return (
            <li
              key={node.key}
              className={`timeline-node timeline-node-event${fresh}`}
            >
              {statusDot(event)}
              <p className="timeline-line">
                <ActorName actorId={event.actorId} actors={actors} />{' '}
                {eventLine(event, actors)}{' '}
                {source ? (
                  <>
                    <a href={source.href} target="_blank" rel="noopener">
                      {source.label}
                    </a>{' '}
                  </>
                ) : null}
                <time dateTime={event.createdAt}>
                  {formatOpened(event.createdAt)}
                </time>
              </p>
            </li>
          );
        })}
      </ol>
      <div className="timeline-composer">{composer}</div>
    </section>
  );
}
