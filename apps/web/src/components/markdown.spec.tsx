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
