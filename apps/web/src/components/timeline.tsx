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
// `unlabeled`); relationships (#86) and mentions (#87) still fall through
// `eventLine`'s placeholder - the merge, ordering and rail layout never change.

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
// kept for completeness). Lifecycle/field/involvement (#84) and labels (#85)
// render real wording here; relationships (#86) and mentions (#87) are still a
// bare placeholder until their own ticket lands.
function eventLine(event: IssueEvent, actors: Actor[]): ReactNode {
  switch (event.type) {
    case 'opened':
      return 'opened this';
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
  const nodes = mergeTimeline(events, comments).filter(
    (n) => !(n.kind === 'event' && n.event.type === 'opened'),
  );
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

          const { event } = node;
          return (
            <li
              key={node.key}
              className={`timeline-node timeline-node-event${fresh}`}
            >
              {statusDot(event)}
              <p className="timeline-line">
                <ActorName actorId={event.actorId} actors={actors} />{' '}
                {eventLine(event, actors)}{' '}
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
