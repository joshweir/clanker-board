import { findMentions, type Mention } from '@clanker/mentions';

/**
 * Client-side mention link rendering (#88): a remark plugin that turns resolved
 * `#KEY-N` / `KEY-N` / `#N` references into inline links, plus the resolution
 * step that decides which matches are real. `@clanker/mentions` (#80) is
 * grammar-only (parse, not resolve) - this module is the web's resolver: the
 * in-memory project issue set every surface (board/list/detail) already loads.
 */

// Minimal mdast node shape for the text-node walk below - deliberately not the
// full `@types/mdast` package (nothing here needs more than `type`/`children`/
// `value`, and `@clanker/mentions` itself stays framework-agnostic).
export interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

// What a mention resolves to: enough to render the link and its hover card. A
// `null` resolver result leaves the matched text as plain prose - the
// must-resolve guard that keeps look-alikes (`SOC-2`, `UTF-8`, `#99999`, a
// foreign-project key) as prose, never a link.
export interface MentionTarget {
  href: string;
  key: string;
  title: string;
  open: boolean;
}

export type MentionResolver = (mention: Mention) => MentionTarget | null;

// remark plugin: walk mdast text nodes, split each on resolved mentions into
// `link` nodes. Never descends into `inlineCode`/`code` - a text-node walk skips
// backtick spans for free, unlike a raw-string regex which would need to special
// case them. The target travels as hast data attributes (`data-mention-*`) on
// the link, read back by `Markdown`'s `a` renderer.
export function remarkMentions(resolve: MentionResolver) {
  return (tree: MdNode): void => {
    walk(tree, resolve);
  };
}

function walk(node: MdNode, resolve: MentionResolver): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    // `link` is pushed unchanged like `inlineCode`/`code` (#88 review B1): a
    // resolved mention is a `link` node, so recursing into an *existing* link's
    // text would let a match get split out as a NESTED link. That breaks the
    // author's own link/autolink (an empty outer `<a>`, or a pasted URL's
    // visible text truncated and its middle segment repointed) - mentions only
    // ever come from plain-text runs, never from inside a link.
    if (
      child.type === 'inlineCode' ||
      child.type === 'code' ||
      child.type === 'link'
    ) {
      next.push(child);
      continue;
    }
    if (child.type === 'text') {
      next.push(...splitText(child, resolve));
      continue;
    }
    walk(child, resolve);
    next.push(child);
  }
  node.children = next;
}

function splitText(node: MdNode, resolve: MentionResolver): MdNode[] {
  const value = node.value ?? '';
  const mentions = findMentions(value);
  if (mentions.length === 0) return [node];

  const out: MdNode[] = [];
  let last = 0;
  for (const mention of mentions) {
    const target = resolve(mention);
    if (!target) continue; // unresolved -> leave inside the surrounding text run
    if (mention.index > last) {
      out.push({ type: 'text', value: value.slice(last, mention.index) });
    }
    out.push({
      type: 'link',
      url: target.href,
      children: [{ type: 'text', value: mention.raw }],
      data: {
        // hast's own attribute convention is camelCase (e.g. the default sanitize
        // schema's `dataFootnoteBackref` for GFM footnotes) - not the hyphenated
        // HTML form. `rehype-raw` round-trips the tree through an HTML
        // stringify+reparse (for GitHub raw-HTML parity), which re-derives
        // property names via that same convention - a hyphenated hProperties key
        // here would round-trip back re-cased and no longer match what
        // `markdown.tsx`'s sanitize schema/`a` renderer look for.
        hProperties: {
          dataMentionKey: target.key,
          dataMentionOpen: String(target.open),
          dataMentionTitle: target.title,
        },
      },
    });
    last = mention.index + mention.raw.length;
  }
  if (out.length === 0) return [node]; // every candidate was unresolved
  if (last < value.length) {
    out.push({ type: 'text', value: value.slice(last) });
  }
  return out;
}

// The in-memory shape `Markdown` needs from a project's already-loaded issue set
// (structurally compatible with `Issue` from `../api` - no import needed here,
// keeping this module decoupled from the API client).
export interface MentionableIssue {
  number: number;
  key: string;
  title: string;
  state: 'open' | 'closed';
}

// Resolve a parsed mention against the current project (#88's must-resolve +
// same-project guard): an explicit key from another project is a look-alike
// (`FOO-9`) and stays plain text; a bare `#N` has no key prefix at all, so it
// always means "this project" (mirrors the grammar's own doc comment).
export function resolveMention(
  mention: Mention,
  projectKey: string,
  issues: readonly MentionableIssue[],
): MentionTarget | null {
  if (mention.form === 'key' && mention.keyPrefix !== projectKey) {
    return null;
  }
  const issue = issues.find((candidate) => candidate.number === mention.number);
  if (!issue) return null;
  return {
    href: `/projects/${projectKey.toLowerCase()}/issues/${issue.number}`,
    key: issue.key,
    title: issue.title,
    open: issue.state !== 'closed',
  };
}
