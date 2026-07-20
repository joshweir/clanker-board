import { describe, expect, test } from 'vitest';
import { formatOpened } from './relative-time';

describe('formatOpened', () => {
  const now = new Date('2026-07-21T12:00:00Z');

  test('same-day, under an hour -> minutes ago', () => {
    expect(formatOpened('2026-07-21T11:55:00Z', now)).toBe('5 minutes ago');
  });

  test('same-day, hours -> hours ago', () => {
    expect(formatOpened('2026-07-21T09:00:00Z', now)).toBe('3 hours ago');
  });

  test('earlier this year -> "on <day month>", no year', () => {
    expect(formatOpened('2026-07-19T09:00:00Z', now)).toBe('on 19 Jul');
  });

  test('a prior year -> "on <day month year>"', () => {
    expect(formatOpened('2025-07-22T09:00:00Z', now)).toBe('on 22 Jul 2025');
  });
});
