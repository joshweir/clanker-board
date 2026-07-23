import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import ReactMarkdown, {
  type Components,
  type ExtraProps,
  type Options,
} from 'react-markdown';
import { rehypeInlineCodeProperty } from 'react-shiki/web';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import type { Mention } from '@clanker/mentions';
import { CodeBlock } from './code-block';
import {
  remarkMentions,
  resolveMention,
  type MentionableIssue,
} from './remark-mentions';

// GitHub-flavoured markdown -> React elements (#36). react-markdown never uses
// dangerouslySetInnerHTML: markdown becomes React nodes directly. We opt into raw
// HTML (rehype-raw) for GitHub parity (<details>, <sub>, <br>, ...), so a
// sanitizer is mandatory - rehype-sanitize runs immediately after, using GitHub's
// own allow-list (defaultSchema) plus the `language-*` class the code block needs
// to pick a highlighting grammar. The inline-code plugin runs *after* sanitize so
// the inline flag it adds is not stripped. Headings are plain text (no slug/autolink
// anchors) - this is a ticket body, not a navigable document.
//
// Mention links (#88) need three extra `data-mention-*` attributes on `<a>` -
// the remark plugin's resolved target (key/open/title), read back by
// `MentionAwareLink` below - so rehype-sanitize (kept, never loosened generally)
// gets exactly those three names added to its existing `a` allow-list. hast's own
// attribute convention is camelCase (see `dataFootnoteBackref` in the default
// schema above) - not the hyphenated HTML form.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      'dataMentionKey',
      'dataMentionOpen',
      'dataMentionTitle',
    ],
  },
};

type LinkProps = ComponentPropsWithoutRef<'a'> & ExtraProps;

// A resolved mention carries its target on the hast node's `data-mention-*`
// properties (see remark-mentions.ts); anything else (an ordinary markdown link,
// or a mention left unresolved as plain text upstream) renders as a plain
// anchor, untouched. Click opens the target's own page in a new tab, mirroring
// `IssueKeyLink` (#40). Closed target: muted + strikethrough.
function MentionAwareLink({ href, node, children, ...rest }: LinkProps) {
  const props = node?.properties ?? {};
  const key = props.dataMentionKey;
  if (typeof key !== 'string') {
    // Not a mention: this `a` override governs every link react-markdown
    // renders, so the rest of the anchor's props (e.g. `title`) must pass
    // through untouched (#88 review N1) rather than being dropped.
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  const open = props.dataMentionOpen === 'true';
  const title =
    typeof props.dataMentionTitle === 'string' ? props.dataMentionTitle : '';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className={open ? 'mention' : 'mention mention-closed'}
    >
      {children}
      {/* Decorative: the link already names the target via `children` (the
          typed text) - without `aria-hidden`, screen readers would announce
          this card's text too, inflating the link's accessible name (#88
          review N2). */}
      <span className="mention-card" role="tooltip" aria-hidden="true">
        <span
          className={open ? 'mention-dot' : 'mention-dot mention-dot-closed'}
        />
        {key} - {open ? 'Open' : 'Closed'}
        <span className="mention-card-title">{title}</span>
      </span>
    </a>
  );
}

const components: Components = { code: CodeBlock, a: MentionAwareLink };

export function Markdown({
  source,
  mentions,
}: {
  source: string;
  // Resolver input (#88): the current project's key + its already-loaded issue
  // set. Omitted (e.g. the body-editor composer preview), mentions stay plain
  // text - #KEY-N only ever links from a surface that has an issue set to
  // resolve against.
  mentions?: {
    projectKey: string;
    issues: readonly MentionableIssue[];
  };
}): ReactElement {
  const remarkPlugins: Options['remarkPlugins'] = mentions
    ? [
        remarkGfm,
        [
          remarkMentions,
          (mention: Mention) =>
            resolveMention(mention, mentions.projectKey, mentions.issues),
        ],
      ]
    : [remarkGfm];
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
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
