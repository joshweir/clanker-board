import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Markdown } from './markdown';

describe('Markdown', () => {
  test('renders bold, italic, and inline code as semantic elements', () => {
    const { container } = render(
      <Markdown source="**bold** and *italic* and `code`" />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    // Inline code gets the tinted pill class, distinct from block code.
    const inline = container.querySelector('code.md-inline-code');
    expect(inline?.textContent).toBe('code');
  });

  test('neutralises a javascript: url but keeps a safe link', () => {
    const { container } = render(
      <Markdown source="[ok](https://example.com) and [bad](javascript:alert(1))" />,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toContain('https://example.com');
    // No anchor may carry an executable scheme - react-markdown's urlTransform
    // strips it, so the href is emptied rather than run.
    expect(hrefs.some((h) => h?.toLowerCase().includes('javascript:'))).toBe(
      false,
    );
  });

  test('keeps an ordinary link title attribute (#88 review N1)', () => {
    const { container } = render(
      <Markdown source='[text](https://example.com "a title")' />,
    );
    expect(container.querySelector('a')?.getAttribute('title')).toBe('a title');
  });

  test('renders headings with an accessible level', () => {
    render(<Markdown source="## Section" />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Section' }),
    ).toBeDefined();
  });

  test('renders an unordered list', () => {
    const { container } = render(<Markdown source={'- one\n- two'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  test('renders a fenced code block with a copy button', async () => {
    const { container } = render(
      <Markdown source={'```ts\nconst x = 1\n```'} />,
    );
    expect(container.querySelector('.md-code-block')).not.toBeNull();
    expect(container.querySelector('.md-copy-btn')).not.toBeNull();
    // Shiki highlights asynchronously; the tokenised code appears once it resolves.
    await waitFor(() =>
      expect(container.querySelector('pre')?.textContent).toContain(
        'const x = 1',
      ),
    );
  });

  test('renders a GFM table', () => {
    const { container } = render(
      <Markdown source={'| a | b |\n| - | - |\n| 1 | 2 |'} />,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(container.querySelectorAll('th')).toHaveLength(2);
  });

  test('renders GFM task lists and strikethrough', () => {
    const { container } = render(
      <Markdown source={'- [x] done\n- [ ] todo\n\n~~gone~~'} />,
    );
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      2,
    );
    expect(container.querySelector('del')?.textContent).toBe('gone');
  });

  test('never renders a raw <script> from the body', () => {
    const { container } = render(
      <Markdown source={'<script>alert(1)</script> text'} />,
    );
    expect(container.querySelector('script')).toBeNull();
  });
});

// Mention links (#88): #KEY-N / KEY-N / #N resolved against the in-memory project
// issue set, through the real react-markdown + rehype-sanitize pipeline (never
// loosened generally - only `data-mention-*` + rehype-sanitize's existing `a`
// allow-list survive).
describe('Markdown - mention links', () => {
  const mentions = {
    projectKey: 'DEMO',
    issues: [
      {
        number: 1,
        key: 'DEMO-1',
        title: 'First issue',
        state: 'open' as const,
      },
      {
        number: 2,
        key: 'DEMO-2',
        title: 'Second issue',
        state: 'closed' as const,
      },
    ],
  };

  test('renders all three forms as links to the target issue', () => {
    const { container } = render(
      <Markdown
        source="hashed #DEMO-1, bare DEMO-1, and #2 by number"
        mentions={mentions}
      />,
    );
    const links = [...container.querySelectorAll('a.mention')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/projects/demo/issues/1',
      '/projects/demo/issues/1',
      '/projects/demo/issues/2',
    ]);
    // Author's typed text is preserved verbatim, not normalised.
    expect(links.map((a) => a.firstChild?.textContent)).toEqual([
      '#DEMO-1',
      'DEMO-1',
      '#2',
    ]);
  });

  test('opens the target standalone page in a new tab (mirrors IssueKeyLink)', () => {
    const { container } = render(
      <Markdown source="see #DEMO-1" mentions={mentions} />,
    );
    const link = container.querySelector('a.mention');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener');
  });

  test('a closed target is muted + strikethrough', () => {
    const { container } = render(
      <Markdown source="closes #2" mentions={mentions} />,
    );
    expect(container.querySelector('a.mention.mention-closed')).not.toBeNull();
    expect(
      container.querySelector('a.mention:not(.mention-closed)'),
    ).toBeNull();
  });

  test('the hover card shows the key and title', () => {
    const { container } = render(
      <Markdown source="see #DEMO-1" mentions={mentions} />,
    );
    const card = container.querySelector('.mention-card');
    expect(card?.textContent).toContain('DEMO-1');
    expect(card?.textContent).toContain('Open');
    expect(container.querySelector('.mention-card-title')?.textContent).toBe(
      'First issue',
    );
  });

  test('look-alikes stay plain text: unknown key/number, foreign project', () => {
    const { container } = render(
      <Markdown
        source="SOC-2 and UTF-8 and #99999 and FOO-9 are not mentions"
        mentions={mentions}
      />,
    );
    expect(container.querySelectorAll('a.mention')).toHaveLength(0);
    expect(container.textContent).toContain(
      'SOC-2 and UTF-8 and #99999 and FOO-9 are not mentions',
    );
  });

  test('a mention-shaped code span stays plain text, not a link', () => {
    const { container } = render(
      <Markdown source="fixed in `#DEMO-1` earlier" mentions={mentions} />,
    );
    expect(container.querySelectorAll('a.mention')).toHaveLength(0);
    expect(container.querySelector('code')?.textContent).toBe('#DEMO-1');
  });

  test('without a mentions prop, mention-shaped text stays plain (no resolver)', () => {
    const { container } = render(<Markdown source="see #DEMO-1" />);
    expect(container.querySelectorAll('a.mention')).toHaveLength(0);
    expect(container.textContent).toContain('see #DEMO-1');
  });
});
