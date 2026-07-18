// Pure search helpers (#39), shared by the search route and unit-tested directly.

// An all-digit query is a jump-to-issue intent: parse it into a positive issue
// number so the UI can pin a "Jump to #N" row (resolved against get-by-number).
// Anything non-numeric is a normal text query; so are 0 and values past the safe
// integer range. Leading zeros still resolve ("007" -> jump to #7), which is
// harmless - the jump row only appears if that number is a real issue.
export function jumpNumber(query: string): number | null {
  const trimmed = query.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// One run of snippet text, flagged as a highlighted match or plain surrounding text.
export interface SnippetSegment {
  text: string;
  mark: boolean;
}

// Split a server FTS snippet into segments. The API wraps matched terms in
// <mark>…</mark>; every other run is plain issue/comment text. Rendering the plain
// runs as React text nodes (escaped) means raw user content can never inject markup -
// only these two literal delimiters are ever treated as structure.
export function snippetSegments(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let mark = false;
  for (const part of snippet.split(/(<mark>|<\/mark>)/)) {
    if (part === '<mark>') {
      mark = true;
    } else if (part === '</mark>') {
      mark = false;
    } else if (part.length > 0) {
      segments.push({ text: part, mark });
    }
  }
  return segments;
}
