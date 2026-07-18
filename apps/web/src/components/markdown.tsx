import {
  createElement,
  Fragment,
  type ReactElement,
  type ReactNode,
} from 'react';

// Minimal, safe markdown -> React renderer (#36). It renders to React nodes and
// never uses dangerouslySetInnerHTML, so there is no HTML-injection surface: a
// `javascript:` link or a literal <script> in the body can never execute (a link's
// href scheme is allow-listed; everything else is inert text). Supports the common
// subset: headings, unordered lists, fenced/inline code, bold, italic, safe links.
// ponytail: a hand-rolled subset, not full CommonMark (no tables, nested lists, or
// blockquotes). Swap in `marked` + a sanitizer if the body ever needs the full set.

const SAFE_LINK = /^(https?:|mailto:)/i;

// Inline spans, scanned left-to-right: the first construct matching at the current
// position wins; anything else is literal text up to the next candidate marker.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const push = (node: ReactNode) =>
    nodes.push(<Fragment key={key++}>{node}</Fragment>);
  while (rest.length > 0) {
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    const code = /^`([^`]+)`/.exec(rest);
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    const italic = /^\*([^*]+)\*/.exec(rest);
    if (link) {
      const [match, label = '', href = ''] = link;
      // A disallowed scheme (e.g. javascript:) renders as inert text, not a link.
      push(SAFE_LINK.test(href) ? <a href={href}>{label}</a> : match);
      rest = rest.slice(match.length);
    } else if (code) {
      push(<code>{code[1]}</code>);
      rest = rest.slice(code[0].length);
    } else if (bold) {
      push(<strong>{bold[1]}</strong>);
      rest = rest.slice(bold[0].length);
    } else if (italic) {
      push(<em>{italic[1]}</em>);
      rest = rest.slice(italic[0].length);
    } else {
      // Consume plain text up to (but not including) the next candidate marker.
      const next = rest.slice(1).search(/[`*[]/);
      const take = next === -1 ? rest.length : next + 1;
      push(rest.slice(0, take));
      rest = rest.slice(take);
    }
  }
  return nodes;
}

function renderBlock(block: string, key: number): ReactElement | null {
  const trimmed = block.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Fenced code block: ``` ... ``` with an optional language tag on the first line.
  if (
    trimmed.startsWith('```') &&
    trimmed.endsWith('```') &&
    trimmed.length >= 6
  ) {
    const inner = trimmed.slice(3, -3).replace(/^\n/, '').replace(/\n$/, '');
    const lines = inner.split('\n');
    const code =
      lines.length > 1 && /^[a-zA-Z0-9]*$/.test(lines[0] ?? '')
        ? lines.slice(1).join('\n')
        : inner;
    return (
      <pre key={key}>
        <code>{code}</code>
      </pre>
    );
  }
  // Heading: render the real h1-h6 element for the `#` count, so the heading level
  // is exposed natively (kept accessible, not simplified).
  const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (heading && !trimmed.includes('\n')) {
    const [, hashes = '', text = ''] = heading;
    return createElement(
      `h${hashes.length}`,
      { key, className: 'md-heading' },
      renderInline(text),
    );
  }
  // Unordered list: every line is a `- ` / `* ` bullet.
  const lines = trimmed.split('\n');
  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    return (
      <ul key={key}>
        {lines.map((line, i) => (
          <li key={i}>{renderInline(line.replace(/^[-*]\s+/, ''))}</li>
        ))}
      </ul>
    );
  }
  // Paragraph: single newlines become hard line breaks.
  return (
    <p key={key}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? <br /> : null}
          {renderInline(line)}
        </Fragment>
      ))}
    </p>
  );
}

// A blank line separates blocks (CommonMark's paragraph rule); each block renders
// independently so redraw stays simple.
export function Markdown({ source }: { source: string }): ReactElement {
  const blocks = source.split(/\n{2,}/);
  return (
    <div className="markdown">
      {blocks.map((block, i) => renderBlock(block, i))}
    </div>
  );
}
