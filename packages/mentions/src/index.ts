/**
 * @clanker/mentions - the shared cross-reference grammar (#79/#80).
 *
 * Three forms, one source of truth: `#KEY-N` (hashed explicit key), bare
 * `KEY-N` (Jira-style, no hash), and `#N` (bare number, current-project
 * shorthand). Both the API (server-side event firing) and the web (client
 * link rendering) import this so "what is a mention" cannot drift between
 * them.
 *
 * This module is grammar/parse only - a deep module hiding the regex behind
 * one narrow function. It does NOT resolve a match to a real issue (does the
 * key belong to a real project? does the number exist?) - that is each
 * consumer's job: the API resolves against the DB, the web against the
 * in-memory issue set already loaded for the current project. That split is
 * what keeps prose look-alikes (`SOC-2`, `UTF-8`, `#99999`) safe: the grammar
 * happily matches them (they are shaped like a key/number), but they only
 * ever become a link once a consumer's resolution step confirms they refer
 * to something real (see index.spec.ts for the grammar+resolution boundary
 * this guarantees).
 *
 * No framework or markdown imports - plain string parsing only.
 */

export type Mention =
  | {
      readonly form: 'key';
      readonly keyPrefix: string;
      readonly number: number;
      readonly raw: string;
      readonly index: number;
    }
  | {
      readonly form: 'number';
      readonly number: number;
      readonly raw: string;
      readonly index: number;
    };

// #?KEY-N (optional hash, explicit key) or #N (bare number). The key-prefix
// shape mirrors the project-key grammar the API already validates on create
// (apps/api/src/routes/projects.ts KEY_PATTERN: /^[A-Z][A-Z0-9]{1,9}$/) -
// an uppercase letter, then uppercase letters/digits.
const MENTION_PATTERN = /#?([A-Z][A-Z0-9]*)-(\d+)|#(\d+)/g;

/** Parse every mention-shaped substring out of free text, in order. */
export function findMentions(text: string): Mention[] {
  // Reset lastIndex: a module-scope global-flag RegExp carries state across
  // calls, so a stale offset from a prior parse must never leak into this one.
  MENTION_PATTERN.lastIndex = 0;

  const mentions: Mention[] = [];
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATTERN.exec(text)) !== null) {
    const [raw, keyPrefix, keyNumber, bareNumber] = match;
    if (bareNumber !== undefined) {
      mentions.push({
        form: 'number',
        number: Number(bareNumber),
        raw,
        index: match.index,
      });
      continue;
    }
    // The alternation guarantees one branch matched: if it wasn't the bare-
    // number branch, the key branch did, so keyPrefix/keyNumber are set. The
    // guard below is belt-and-braces type narrowing, not expected to trigger.
    if (keyPrefix === undefined || keyNumber === undefined) continue;
    mentions.push({
      form: 'key',
      keyPrefix,
      number: Number(keyNumber),
      raw,
      index: match.index,
    });
  }
  return mentions;
}
