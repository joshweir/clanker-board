import { describe, expect, test } from 'vitest'
import { jumpNumber, snippetSegments } from './search'

describe('jumpNumber', () => {
  test('parses an all-digit query into a positive issue number', () => {
    expect(jumpNumber('42')).toBe(42)
    expect(jumpNumber('  7 ')).toBe(7)
  })

  test('is null for any non-all-digit query', () => {
    expect(jumpNumber('login')).toBeNull()
    expect(jumpNumber('12a')).toBeNull()
    expect(jumpNumber('DEMO-3')).toBeNull()
    expect(jumpNumber('')).toBeNull()
    expect(jumpNumber('  ')).toBeNull()
  })

  test('is null for zero (no issue number is 0)', () => {
    expect(jumpNumber('0')).toBeNull()
    expect(jumpNumber('00')).toBeNull()
  })
})

describe('snippetSegments', () => {
  test('splits highlighted runs from plain text', () => {
    expect(snippetSegments('fix the <mark>login</mark> flow')).toEqual([
      { text: 'fix the ', mark: false },
      { text: 'login', mark: true },
      { text: ' flow', mark: false }
    ])
  })

  test('treats only the literal delimiters as structure (raw text stays escaped text)', () => {
    // A body containing angle brackets is returned as plain, unmarked text - it can
    // never become markup because the renderer emits it as a React text node.
    expect(snippetSegments('a <b> c')).toEqual([
      { text: 'a <b> c', mark: false }
    ])
  })

  test('handles a snippet with no highlight', () => {
    expect(snippetSegments('plain')).toEqual([{ text: 'plain', mark: false }])
  })
})
