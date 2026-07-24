import type { Actor } from '../api';

// Single source of truth for attributing UI to an actor (#18, #81): a human
// renders bare (no auth yet to distinguish "you" from anyone else), while an
// agent gets a small neutral ringed glyph ahead of its name, shown verbatim -
// so a glance at any author/comment/timeline entry tells a person from a bot.
export function ActorName({
  actorId,
  actors,
}: {
  actorId: number;
  actors: Actor[];
}) {
  const actor = actors.find((a) => a.id === actorId);
  if (!actor) {
    return <span className="actor-name">Unknown</span>;
  }
  if (actor.kind === 'agent') {
    return (
      <span className="actor-name">
        <span className="actor-kind-badge" aria-hidden="true">
          🤖
        </span>
        {actor.name}
      </span>
    );
  }
  return <span className="actor-name">{actor.name}</span>;
}
