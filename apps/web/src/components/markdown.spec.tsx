import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { Markdown } from './markdown'

describe('Markdown', () => {
  test('renders bold, italic, and inline code as semantic elements', () => {
    const { container } = render(<Markdown source="**bold** and *italic* and `code`" />)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('em')?.textContent).toBe('italic')
    expect(container.querySelector('code')?.textContent).toBe('code')
  })

  test('renders a safe link but never a javascript: url', () => {
    const { container } = render(
      <Markdown source="[ok](https://example.com) and [bad](javascript:alert(1))" />,
    )
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com')
    // The unsafe link is inert text, so there is exactly one anchor and the raw
    // javascript: source is shown verbatim.
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.textContent).toContain('[bad](javascript:alert(1))')
  })

  test('renders headings with an accessible level', () => {
    render(<Markdown source="## Section" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeDefined()
  })

  test('renders an unordered list', () => {
    const { container } = render(<Markdown source={'- one\n- two'} />)
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  test('renders a fenced code block, stripping the language tag', () => {
    const { container } = render(<Markdown source={'```ts\nconst x = 1\n```'} />)
    const pre = container.querySelector('pre code')
    expect(pre?.textContent).toBe('const x = 1')
  })
})
