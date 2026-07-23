import { describe, expect, test } from 'vitest';
import { findMentions, type Mention } from './index';

// The shared grammar (#79/#80): three forms - `#KEY-N`, bare `KEY-N`, `#N` -
// parsed the same way everywhere so "what is a mention" cannot drift between
// the API (server firing) and the web (link rendering). Grammar/parse only:
// resolving a match against real project keys/issue numbers is each
// consumer's job, not this module's (see the "grammar+resolution boundary"
// group below for why that split keeps look-alikes safe).

describe('findMentions - the three forms', () => {
  test('#KEY-N - hashed explicit key', () => {
    expect(findMentions('see #DEMO-1 for details')).toEqual<Mention[]>([
      { form: 'key', keyPrefix: 'DEMO', number: 1, raw: '#DEMO-1', index: 4 },
    ]);
  });

  test('KEY-N - bare Jira-style key, no hash', () => {
    expect(findMentions('fixed by DEMO-2')).toEqual<Mention[]>([
      { form: 'key', keyPrefix: 'DEMO', number: 2, raw: 'DEMO-2', index: 9 },
    ]);
  });

  test('#N - bare number, current-project shorthand', () => {
    expect(findMentions('closes #3 today')).toEqual<Mention[]>([
      { form: 'number', number: 3, raw: '#3', index: 7 },
    ]);
  });

  test('a key prefix may mix letters and digits after the first letter', () => {
    expect(findMentions('AB12-7')).toEqual<Mention[]>([
      { form: 'key', keyPrefix: 'AB12', number: 7, raw: 'AB12-7', index: 0 },
    ]);
  });

  test('multiple mentions in one string, each with its own index', () => {
    expect(findMentions('#DEMO-1 relates to DEMO-2 and #3')).toEqual<Mention[]>(
      [
        { form: 'key', keyPrefix: 'DEMO', number: 1, raw: '#DEMO-1', index: 0 },
        { form: 'key', keyPrefix: 'DEMO', number: 2, raw: 'DEMO-2', index: 19 },
        { form: 'number', number: 3, raw: '#3', index: 30 },
      ],
    );
  });

  test('plain prose with no mention shape matches nothing', () => {
    expect(findMentions('nothing to see here, just words')).toEqual([]);
  });

  test('is a pure function - repeat calls do not carry state across strings', () => {
    // Guards against a stale `lastIndex` on a shared global-flag RegExp - a
    // classic footgun when the pattern lives at module scope.
    expect(findMentions('#DEMO-1')).toEqual(findMentions('#DEMO-1'));
    findMentions('#DEMO-1 #DEMO-2 #DEMO-3');
    expect(findMentions('#DEMO-9')).toEqual<Mention[]>([
      { form: 'key', keyPrefix: 'DEMO', number: 9, raw: '#DEMO-9', index: 0 },
    ]);
  });
});

// Grammar+resolution boundary (#79 testing decisions): the grammar alone
// cannot tell "SOC-2" (compliance jargon) from "DEMO-2" (a real key) - both
// are shaped like `KEY-N`. That is by design: resolution (does this project
// key exist? does this issue number exist?) is deliberately left to each
// consumer. What the grammar guarantees is that these look-alikes are only
// ever *candidates* - never a match that skips resolution - so a consumer
// that resolves against real data never turns them into false links. This
// tiny stub resolver stands in for what the API (DB query) and web (in-memory
// issue set) each do for real.
describe('findMentions - grammar+resolution boundary (look-alikes)', () => {
  const KNOWN_PROJECT = 'DEMO';
  const KNOWN_ISSUE_NUMBERS = new Set([1, 2, 3]);

  function resolves(mention: Mention): boolean {
    if (mention.form === 'number')
      return KNOWN_ISSUE_NUMBERS.has(mention.number);
    return (
      mention.keyPrefix === KNOWN_PROJECT &&
      KNOWN_ISSUE_NUMBERS.has(mention.number)
    );
  }

  test('SOC-2 is grammar-shaped like a key but never resolves', () => {
    const [mention] = findMentions('per SOC-2 requirements');
    expect(mention).toMatchObject({ form: 'key', keyPrefix: 'SOC', number: 2 });
    expect(resolves(mention!)).toBe(false);
  });

  test('UTF-8 is grammar-shaped like a key but never resolves', () => {
    const [mention] = findMentions('encoded as UTF-8');
    expect(mention).toMatchObject({ form: 'key', keyPrefix: 'UTF', number: 8 });
    expect(resolves(mention!)).toBe(false);
  });

  test('#99999 is grammar-shaped like a bare number but never resolves', () => {
    const [mention] = findMentions('see #99999 for the ticket');
    expect(mention).toMatchObject({ form: 'number', number: 99999 });
    expect(resolves(mention!)).toBe(false);
  });

  test('an unknown key prefix (foreign/unrecognized project) never resolves', () => {
    const [mention] = findMentions('tracked in FOO-9 upstream');
    expect(mention).toMatchObject({ form: 'key', keyPrefix: 'FOO', number: 9 });
    expect(resolves(mention!)).toBe(false);
  });
});
