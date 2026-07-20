import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { rehypeInlineCodeProperty } from 'react-shiki/web';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block';

// GitHub-flavoured markdown -> React elements (#36). react-markdown never uses
// dangerouslySetInnerHTML: markdown becomes React nodes directly. We opt into raw
// HTML (rehype-raw) for GitHub parity (<details>, <sub>, <br>, ...), so a
// sanitizer is mandatory - rehype-sanitize runs immediately after, using GitHub's
// own allow-list (defaultSchema) plus the `language-*` class the code block needs
// to pick a highlighting grammar. The inline-code plugin runs *after* sanitize so
// the inline flag it adds is not stripped. Headings are plain text (no slug/autolink
// anchors) - this is a ticket body, not a navigable document.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
  },
};

const components: Components = { code: CodeBlock };

export function Markdown({ source }: { source: string }): ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          rehypeInlineCodeProperty,
        ]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
