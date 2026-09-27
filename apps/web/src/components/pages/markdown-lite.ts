/**
 * Markdown-lite: turns untrusted Markdown (GitHub release notes, CHANGELOG.md) into a small
 * tree of blocks and inline tokens that Markdown.astro renders with Astro's escaping. Nothing
 * here produces HTML, so no markup from the source can reach the page:
 *
 * - raw HTML tags and comments are dropped (their text stays);
 * - links keep only http(s), mailto, site-relative (/…) and fragment (#…) targets, anything
 *   else (javascript:, data:, repo-relative paths) becomes plain text;
 * - images become their alt text.
 *
 * Supported: ATX headings, paragraphs, bullet and numbered lists (nested), task list markers,
 * block quotes, fenced and indented code, GFM tables, rules, **bold**, `code`, [links](…),
 * <autolinks> and bare URLs. Italic and strikethrough keep their text without the style: the
 * site loads no italic face. Link reference definitions ([x]: url) are skipped.
 *
 * Headings are clamped for a page where each release is an <h2>: #, ## and ### become <h3>,
 * deeper levels <h4>.
 */
import type { InlineToken } from '../../content/copy';

export type { InlineToken };

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | { readonly kind: 'heading'; readonly level: 3 | 4; readonly inline: InlineToken[] }
  | { readonly kind: 'paragraph'; readonly inline: InlineToken[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: MdListItem[];
    }
  | { readonly kind: 'quote'; readonly blocks: MdBlock[] }
  | { readonly kind: 'code'; readonly text: string }
  | {
      readonly kind: 'table';
      readonly align: MdAlign[];
      readonly head: InlineToken[][];
      readonly rows: InlineToken[][][];
    }
  | { readonly kind: 'rule' };

export interface MdListItem {
  readonly inline: InlineToken[];
  /** Nested lists and extra paragraphs of the item. */
  readonly blocks: MdBlock[];
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/**
 * A link target that is safe to put in href, or null. Only absolute http(s) and mailto URLs,
 * site-relative paths and fragments pass; the result is normalized by the URL parser.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '' || /[\s<>"'`]/.test(href)) return null;
  if (href.startsWith('#')) return href;
  if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) return href;
  if (/^(https?|mailto):/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
        return url.href;
      }
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

const INLINE_MD = new RegExp(
  [
    /\\([!-/:-@[-`{-~])/.source, // 1: backslash escape
    /(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)/.source, // 2, 3: code span
    /!\[([^\]]*)\]\([^)]*\)/.source, // 4: image (alt text only)
    // 5, 6: link (the target may hold one level of balanced parentheses)
    /\[((?:[^\]\\]|\\.)+)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/
      .source,
    /<((?:https?|mailto):[^\s<>]+)>/.source, // 7: autolink
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 8: strong
    /(?<![\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/u.source, // 9: strong
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 10: strikethrough (text only)
    /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source, // 11: emphasis (text only)
    /(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/u.source, // 12: emphasis
    /(?<![\w/])(https?:\/\/[^\s<>]*[^\s<>.,:;!?"'()[\]*_~])/.source, // 13: bare URL
    /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/.source, // 14: raw HTML tag, dropped
  ].join('|'),
  'gu',
);

/** HTML elements that break a line: when dropped, a space keeps the words apart. */
const BLOCK_TAGS = new Set([
  'br',
  'p',
  'div',
  'details',
  'summary',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'blockquote',
]);

function pushText(tokens: InlineToken[], text: string): void {
  if (text === '') return;
  const last = tokens.at(-1);
  if (last?.kind === 'text') {
    tokens[tokens.length - 1] = { kind: 'text', text: last.text + text };
  } else {
    tokens.push({ kind: 'text', text });
  }
}

/** The visible text of inline Markdown, without any markup (for link and bold labels). */
export function inlineText(source: string): string {
  return parseInline(source)
    .map((token) => token.text)
    .join('');
}

/** Parses one paragraph, list item or table cell into inline tokens. */
export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const text = source.replace(/<!--[\s\S]*?-->/g, '');
  let last = 0;
  for (const match of text.matchAll(INLINE_MD)) {
    const index = match.index ?? 0;
    pushText(tokens, text.slice(last, index));
    last = index + match[0].length;
    const [
      ,
      escaped,
      ,
      code,
      imageAlt,
      linkText,
      linkHref,
      autolink,
      strongA,
      strongB,
      strike,
      emA,
      emB,
      bareUrl,
      tag,
    ] = match;

    if (escaped !== undefined) pushText(tokens, escaped);
    else if (code !== undefined) {
      // CommonMark: one leading and trailing space is stripped when both are there.
      const inner = /^ .* $/s.test(code) && code.trim() !== '' ? code.slice(1, -1) : code;
      tokens.push({ kind: 'code', text: inner.replace(/\n/g, ' ') });
    } else if (imageAlt !== undefined) pushText(tokens, inlineText(imageAlt));
    else if (linkText !== undefined) {
      const label = inlineText(linkText);
      const href = safeHref(linkHref ?? '');
      if (href && label.trim() !== '') tokens.push({ kind: 'link', text: label, href });
      else pushText(tokens, label);
    } else if (autolink !== undefined || bareUrl !== undefined) {
      const url = (autolink ?? bareUrl) as string;
      const href = safeHref(url);
      const label = url.replace(/^mailto:/i, '');
      if (href) tokens.push({ kind: 'link', text: label, href });
      else pushText(tokens, url);
    } else if (strongA !== undefined || strongB !== undefined) {
      const label = inlineText((strongA ?? strongB) as string);
      if (label !== '') tokens.push({ kind: 'strong', text: label });
    } else if (strike !== undefined || emA !== undefined || emB !== undefined) {
      // Italic and strikethrough: the words stay, the style goes (and nested links too).
      for (const inner of parseInline((strike ?? emA ?? emB) as string)) {
        if (inner.kind === 'text') pushText(tokens, inner.text);
        else tokens.push(inner);
      }
    } else if (tag !== undefined && BLOCK_TAGS.has(tag.toLowerCase())) {
      // A dropped block tag still separates the words on each side of it.
      pushText(tokens, ' ');
    }
    // Any other raw HTML tag is dropped.
  }
  pushText(tokens, text.slice(last));

  // Hard line breaks and runs of spaces collapse into single spaces, like in HTML, and the
  // edges are trimmed.
  const lastIndex = tokens.length - 1;
  return tokens
    .map((token, index) => {
      if (token.kind !== 'text') return token;
      let value = token.text.replace(/\s+/g, ' ');
      if (index === 0) value = value.trimStart();
      if (index === lastIndex) value = value.trimEnd();
      return { ...token, text: value };
    })
    .filter((token) => token.text !== '');
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S+/;
const TABLE_DIVIDER = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const TASK_MARKER = /^\[[ xX]\][ \t]+/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  // Split on pipes that are not escaped.
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const head = lines[i];
  const divider = lines[i + 1];
  if (head === undefined || divider === undefined) return false;
  if (!head.includes('|') || !TABLE_DIVIDER.test(divider) || !divider.includes('-')) return false;
  return splitRow(head).length === splitRow(divider).length;
}

/** Lines that start a block of their own, so they end a paragraph. */
function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? '';
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, i)
  );
}

function parseBlocks(lines: readonly string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (isBlank(line) || LINK_DEFINITION.test(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(marker)) {
        body.push(lines[i] as string);
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (
        i < lines.length &&
        (isBlank(lines[i] as string) || indentOf(lines[i] as string) >= 4)
      ) {
        body.push((lines[i] as string).slice(4));
        i += 1;
      }
      blocks.push({ kind: 'code', text: body.join('\n').replace(/\n+$/, '') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const depth = (heading[1] as string).length;
      const inline = parseInline(heading[2] ?? '');
      if (inline.length > 0) blocks.push({ kind: 'heading', level: depth <= 3 ? 3 : 4, inline });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i] as string)) {
        const quoted = QUOTE.exec(lines[i] as string);
        // Lazy continuation: a plain line right after a quoted one still belongs to it.
        if (!quoted && startsBlock(lines, i)) break;
        body.push(quoted ? (quoted[1] as string) : (lines[i] as string));
        i += 1;
      }
      const inner = parseBlocks(body);
      if (inner.length > 0) blocks.push({ kind: 'quote', blocks: inner });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const align = splitRow(lines[i + 1] as string).map((cell): MdAlign => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return null;
      });
      const width = align.length;
      const fit = (cells: string[]): InlineToken[][] =>
        Array.from({ length: width }, (_, c) => parseInline(cells[c] ?? ''));
      const head = fit(splitRow(lines[i] as string));
      const rows: InlineToken[][][] = [];
      i += 2;
      while (
        i < lines.length &&
        !isBlank(lines[i] as string) &&
        (lines[i] as string).includes('|')
      ) {
        rows.push(fit(splitRow(lines[i] as string)));
        i += 1;
      }
      blocks.push({ kind: 'table', align, head, rows });
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const body: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i] as string) && !startsBlock(lines, i)) {
      body.push((lines[i] as string).trim());
      i += 1;
    }
    const inline = parseInline(body.join('\n'));
    if (inline.length > 0) blocks.push({ kind: 'paragraph', inline });
  }

  return blocks;
}

/** A list starting at line `start`, with its nested lists, until it ends. */
function parseList(lines: readonly string[], start: number): { block: MdBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start] as string) as RegExpExecArray;
  const baseIndent = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const startNumber = ordered ? Number.parseInt(first[2] as string, 10) : 1;

  const items: { text: string[]; nested: string[] }[] = [];
  let i = start;
  let lastWasBlank = false;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (isBlank(line)) {
      lastWasBlank = true;
      i += 1;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    const indent = indentOf(line);
    const current = items.at(-1);

    if (item && indent < baseIndent + 2) {
      // A sibling item, unless the list type changes.
      if (/\d/.test(item[2] as string) !== ordered || indent < baseIndent) break;
      items.push({ text: [(item[3] ?? '').replace(TASK_MARKER, '')], nested: [] });
      lastWasBlank = false;
      i += 1;
      continue;
    }

    if (current && indent >= baseIndent + 2) {
      // Indented content: a nested list or more text of the current item.
      if (current.nested.length > 0 || item || lastWasBlank) {
        if (lastWasBlank && current.nested.length > 0) current.nested.push('');
        current.nested.push(line.slice(Math.min(indent, baseIndent + 2)));
      } else {
        current.text.push(line.trim());
      }
      lastWasBlank = false;
      i += 1;
      continue;
    }

    // Lazy continuation of the item's first paragraph.
    if (current && !lastWasBlank && current.nested.length === 0 && !startsBlock(lines, i)) {
      current.text.push(line.trim());
      i += 1;
      continue;
    }

    break;
  }

  return {
    block: {
      kind: 'list',
      ordered,
      start: startNumber,
      items: items.map((item) => ({
        inline: parseInline(item.text.join('\n')),
        blocks: parseBlocks(item.nested),
      })),
    },
    next: i,
  };
}

/** Parses a Markdown document into blocks. Never throws; unknown syntax stays as text. */
export function parseMarkdown(source: string): MdBlock[] {
  const text = source
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\t/g, '    ');
  return parseBlocks(text.split('\n'));
}
