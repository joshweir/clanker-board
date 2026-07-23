import { describe, expect, test } from 'vitest';
import { findMentions, type Mention } from '@clanker/mentions';
import {
  remarkMentions,
  resolveMention,
  type MdNode,
  type MentionableIssue,
} from './remark-mentions';

// Pure-unit (#88): the mdast text-node walk + resolution, with no react-markdown/
// DOM involved - `markdown.spec.tsx` covers the rendered link + new-tab target.

describe('resolveMention', () => {
  const issues: MentionableIssue[] = [
    { number: 1, key: 'DEMO-1', title: 'Open one', state: 'open' },
    { number: 2, key: 'DEMO-2', title: 'Closed one', state: 'closed' },
  ];

  // Accepts `undefined` too, so a test can assert "never resolves" without a
  // non-null assertion - if the grammar somehow found nothing, this just says
  // so truthfully (null) rather than the test needing to force it.
  function resolve(mention: Mention | undefined, projectKey: string) {
    if (!mention) return null;
    return resolveMention(mention, projectKey, issues);
  }

  test('resolves a hashed key in the current project', () => {
    const [mention] = findMentions('#DEMO-1');
    expect(resolve(mention, 'DEMO')).toEqual({
      href: '/projects/demo/issues/1',
      key: 'DEMO-1',
      title: 'Open one',
      open: true,
    });
  });

  test('resolves a bare number against the current project only', () => {
    const [mention] = findMentions('#2');
    expect(resolve(mention, 'DEMO')).toEqual({
      href: '/projects/demo/issues/2',
      key: 'DEMO-2',
      title: 'Closed one',
      open: false,
    });
  });

  test('a foreign-project key never resolves (same-project guard)', () => {
    const [mention] = findMentions('FOO-1');
    expect(resolve(mention, 'DEMO')).toBeNull();
  });

  test('an unknown issue number never resolves (must-resolve guard)', () => {
    const [mention] = findMentions('#99999');
    expect(resolve(mention, 'DEMO')).toBeNull();
  });
});

describe('remarkMentions - mdast text-node walk', () => {
  const resolve = (raw: string) =>
    raw === '#DEMO-1'
      ? {
          href: '/projects/demo/issues/1',
          key: 'DEMO-1',
          title: 't',
          open: true,
        }
      : null;

  function paragraph(text: string): MdNode {
    return { type: 'root', children: [{ type: 'text', value: text }] };
  }

  test('splits a resolved mention out of a text node into a link', () => {
    const tree = paragraph('see #DEMO-1 please');
    remarkMentions((m) => resolve(m.raw))(tree);
    expect(tree.children).toEqual([
      { type: 'text', value: 'see ' },
      {
        type: 'link',
        url: '/projects/demo/issues/1',
        children: [{ type: 'text', value: '#DEMO-1' }],
        data: {
          hProperties: {
            dataMentionKey: 'DEMO-1',
            dataMentionOpen: 'true',
            dataMentionTitle: 't',
          },
        },
      },
      { type: 'text', value: ' please' },
    ]);
  });

  test('an unresolved look-alike stays a single plain text node', () => {
    const tree = paragraph('per SOC-2 requirements');
    remarkMentions((m) => resolve(m.raw))(tree);
    expect(tree.children).toEqual([
      { type: 'text', value: 'per SOC-2 requirements' },
    ]);
  });

  test('never descends into inlineCode - a mention-shaped code span stays code', () => {
    const tree: MdNode = {
      type: 'root',
      children: [{ type: 'inlineCode', value: '#DEMO-1' }],
    };
    remarkMentions((m) => resolve(m.raw))(tree);
    expect(tree.children).toEqual([{ type: 'inlineCode', value: '#DEMO-1' }]);
  });

  test('never descends into a fenced code block', () => {
    const tree: MdNode = {
      type: 'root',
      children: [{ type: 'code', value: '#DEMO-1' }],
    };
    remarkMentions((m) => resolve(m.raw))(tree);
    expect(tree.children).toEqual([{ type: 'code', value: '#DEMO-1' }]);
  });

  test('walks into nested children (e.g. a list item)', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        {
          type: 'listItem',
          children: [{ type: 'text', value: '#DEMO-1 done' }],
        },
      ],
    };
    remarkMentions((m) => resolve(m.raw))(tree);
    expect(tree.children?.[0]?.children).toEqual([
      {
        type: 'link',
        url: '/projects/demo/issues/1',
        children: [{ type: 'text', value: '#DEMO-1' }],
        data: {
          hProperties: {
            dataMentionKey: 'DEMO-1',
            dataMentionOpen: 'true',
            dataMentionTitle: 't',
          },
        },
      },
      { type: 'text', value: ' done' },
    ]);
  });
});
