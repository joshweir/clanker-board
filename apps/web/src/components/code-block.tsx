import { useState, type ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'react-markdown';
import { ShikiHighlighter } from 'react-shiki/web';
import { shikiEngine } from '../lib/shiki';

// `inline` is injected onto inline <code> nodes by react-shiki's
// rehypeInlineCodeProperty plugin (parent-tag based, so single-line fenced blocks
// are still treated as blocks). react-markdown forwards it here as a prop.
type CodeProps = ComponentPropsWithoutRef<'code'> &
  ExtraProps & { inline?: boolean };

// Single `code` renderer for react-markdown: inline spans get GitHub's tinted
// pill; fenced blocks get Shiki syntax highlighting (dual github light/dark theme)
// plus a copy button pinned top-right. `node` is react-markdown's hast node - not
// a DOM attribute, so it is destructured out before spreading onto the element.
export function CodeBlock({
  inline,
  className,
  children,
  node: _node,
  ...rest
}: CodeProps) {
  if (inline) {
    return (
      <code className="md-inline-code" {...rest}>
        {children}
      </code>
    );
  }
  // react-markdown hands a fenced block's content through as plain-string
  // children; anything else has no code text to copy or highlight.
  const code = (typeof children === 'string' ? children : '').replace(
    /\n$/,
    '',
  );
  const language = /language-([\w-]+)/.exec(className ?? '')?.[1] ?? 'text';
  return (
    <div className="md-code-block">
      <CopyButton text={code} />
      <ShikiHighlighter
        language={language}
        theme={{ light: 'github-light', dark: 'github-dark' }}
        defaultColor="light-dark()"
        engine={shikiEngine}
        showLanguage={false}
      >
        {code}
      </ShikiHighlighter>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="md-copy-btn"
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
