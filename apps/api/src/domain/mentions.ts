import { findMentions } from '@clanker/mentions';
import type { Db, Tx } from '../db/client';
import { findIssue } from '../db/queries';

/**
 * Server-side mention resolution (#79/#87): the API has no markdown dep, so
 * firing stays markdown-free - a lightweight code-span stripper (drop fenced
 * ``` blocks + inline backtick spans by regex) ahead of the shared
 * `@clanker/mentions` grammar (#80), then resolve each candidate against the
 * SOURCE issue's own project via the DB to decide which targets a `mentioned`
 * event should fire on.
 */

// Strip fenced ``` blocks and inline `backtick` spans before parsing (mirrors
// the web's remark text-node walk, which skips them structurally instead - the
// API has no markdown AST to walk, so a regex pass does the same job here).
export function stripCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

// Resolve every mention-shaped candidate in `text` against `projectId`
// (the SOURCE issue's own project) into the de-duped set of TARGET issue ids -
// Set semantics give the "one per source" de-dupe for free. A bare `#N` is
// always current-project shorthand; an explicit `KEY-N` only resolves when its
// key matches THIS project (anything else is a foreign-project look-alike,
// dropped without a lookup - never resolved against a different real
// project). A candidate whose number does not exist in this project is
// dropped (unresolved), and a candidate that names `sourceIssueId` itself is
// dropped (no self-mention).
export function resolveMentions(
  db: Db | Tx,
  projectId: number,
  projectKey: string,
  sourceIssueId: number,
  text: string,
): Set<number> {
  const targets = new Set<number>();
  for (const mention of findMentions(stripCodeSpans(text))) {
    if (mention.form === 'key' && mention.keyPrefix !== projectKey) continue;
    const target = findIssue(db, projectId, mention.number);
    if (!target || target.id === sourceIssueId) continue;
    targets.add(target.id);
  }
  return targets;
}

// The fire-timing rule (#87 "content-version diff, no event-history query"):
// on a PATCH, only the targets newly referenced by `newText` but not already
// referenced by `oldText` fire - editing a body to add a mention fires once
// for the new target; removing a mention retracts nothing (it just does not
// appear in `after`, so no event needed - there is no "retract" event type).
export function newlyMentionedTargets(
  db: Db | Tx,
  projectId: number,
  projectKey: string,
  sourceIssueId: number,
  oldText: string,
  newText: string,
): Set<number> {
  const before = resolveMentions(
    db,
    projectId,
    projectKey,
    sourceIssueId,
    oldText,
  );
  const after = resolveMentions(
    db,
    projectId,
    projectKey,
    sourceIssueId,
    newText,
  );
  const fresh = new Set<number>();
  for (const targetId of after) {
    if (!before.has(targetId)) fresh.add(targetId);
  }
  return fresh;
}
