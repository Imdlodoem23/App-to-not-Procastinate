#!/usr/bin/env node
// Rejects loose colors in the desktop app and the extension: every color must come from
// packages/shared/src/design/tokens.css (CSS variables, Tailwind classes) or tokens.ts.
//
// Usage: node scripts/lint-colors.mjs [--root <dir>] [path ...]
//   --root <dir>  directory that default targets, paths and output are relative to
//                 (default: $LINT_COLORS_ROOT, else the repository root)
//   path ...      files or folders to scan instead of the default targets
//
// Flags:
// - hex colors (#rgb, #rgba, #rrggbb, #rrggbbaa) and rgb()/hsl()/hwb()/lab()/lch()/oklab()/
//   oklch()/color(<space> …) literals;
// - CSS named colors used as values: CSS declarations (CSS files, <style>, style="…", and CSS
//   inside JS strings and templates), color attributes (fill=red, <font color>, theme-color
//   <meta>), JS values after a color-ish key or assignment ({ color: a ? 'white' : 'black' },
//   ctx.fillStyle = 'red', el.style['color'] = …, setAttribute('fill', …), setProperty(…));
// - Tailwind's default palette classes and arbitrary values/properties with a named color
//   (bg-[red], shadow-[0_0_0_2px_red], [color:red]);
// - token classes and variables that fail 4.5:1 as text: text-red, text-neutral, text-accent…
//   and color: var(--red) (use text-red-text / text-fg-muted / text-accent-text).
//
// Not flagged: references that look like hex (url(#fade), href="#add", querySelector('#fab'),
// CSS id selectors, private #fields), 3–4 digit numbers in prose ('Logro #100') unless they sit
// in a color context, and values typed with `as`/`satisfies` ('green' as Accent). Props that
// take an accent name are called `accent` or `tone`, never `color`: a `color` prop or key is
// always treated as a real color (lucide icons, SVG, style objects).
//
// Comments are ignored (JSX text is not a comment: <p>https://…</p>). A line whose comment
// contains `// allow-color`, `/* allow-color */` or `<!-- allow-color -->` is skipped.
// Files under packages/shared/src/design are never checked.
//
// Exit code: 0 clean, 1 loose colors found, 2 usage error.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const JSX_EXTS = new Set(['.tsx', '.jsx']);
const STYLE_EXTS = new Set(['.css']);
const MARKUP_EXTS = new Set(['.html', '.htm', '.svg']);
const ALL_EXTS = new Set([...SCRIPT_EXTS, ...STYLE_EXTS, ...MARKUP_EXTS]);

const DEFAULT_TARGETS = [
  { path: 'apps/desktop/src', exts: ALL_EXTS },
  { path: 'apps/extension/src', exts: ALL_EXTS },
  { path: 'apps/extension/public', exts: new Set(['.html', '.htm', '.css']) },
];
const EXCLUDED = ['packages/shared/src/design'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.git']);
const ALLOW_MARKER = /\/\/\s*allow-color\b|\/\*\s*allow-color\s*\*\/|<!--\s*allow-color\s*-->/;

// CSS named colors (CSS Color 4). `transparent` and `currentColor` are fine.
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);
const TW_PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|' +
  'indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe';
const TW_COLOR_UTILITIES =
  'bg|text|border(?:-[xytrblse])?|outline|ring|ring-offset|fill|stroke|decoration|divide|caret|' +
  'accent|shadow|inset-shadow|drop-shadow|placeholder|from|via|to';

// Tokens that are not text colors (under 4.5:1 in a theme) and what text uses instead.
const NOT_TEXT = {
  red: 'red-text',
  neutral: 'fg-muted',
  accent: 'accent-text',
  'accent-top': 'accent-text',
  'accent-tint': 'accent-text',
  control: 'fg-muted',
  border: 'fg-muted',
};
const NOT_TEXT_NAMES = 'red|neutral|accent-top|accent-tint|accent|control|border';

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

const HEX_RE = /(?<![\w&#$.\\-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const SHORT_DIGITS_RE = /^#\d{3,4}$/;
const FUNCTION_RE =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\bcolor\(\s*(?:srgb(?:-linear)?|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz(?:-d50|-d65)?|--[\w-]+)(?![\w-])/gi;
const TW_PALETTE_RE = new RegExp(
  `(?<![\\w-])(?:${TW_COLOR_UTILITIES})-(?:white|black|(?:${TW_PALETTE})-\\d{2,3})(?![\\w-])`,
  'g',
);
// Arbitrary values (bg-[…], shadow-[0_0_0_2px_red]) and properties ([color:red]). Arbitrary
// variants (data-[state=red]:…, supports-[…]:…) end in ':' and are not values.
const TW_ARBITRARY_VALUE_RE = /(?<=[a-z0-9])-\[([^\]\s]+)\](?!:)/dgi;
const TW_ARBITRARY_PROP_RE = /(?<![\w\]-])\[(-{0,2}[a-z][\w-]*:[^\]\s]+)\](?!:)/dgi;
const TW_TEXT_TOKEN_RE = new RegExp(`(?<![\\w-])text-(${NOT_TEXT_NAMES})(?![\\w-])`, 'g');
const VAR_NOT_TEXT_RE = new RegExp(`var\\(\\s*--(${NOT_TEXT_NAMES})\\s*[,)]`, 'g');
const CSSVAR_NOT_TEXT_RE = /\bcssVar\(\s*(["'`])(red|neutral|control|border)\1\s*\)/g;

// CSS declarations of color properties (CSS files, <style>, style="…", CSS in JS strings).
const CSS_PROPS =
  'color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|' +
  'border-image(?:-source)?|outline(?:-color)?|fill|stroke|stop-color|flood-color|lighting-color|' +
  'caret-color|accent-color|column-rule(?:-color)?|text-decoration(?:-color)?|' +
  'text-emphasis(?:-color)?|box-shadow|text-shadow|scrollbar-color|(?:backdrop-)?filter|' +
  'text-fill-color|text-stroke(?:-color)?|tap-highlight-color';
const CSS_DECL_RE = new RegExp(
  `(?<![\\w-])((?:-webkit-)?(?:${CSS_PROPS})|--[\\w-]+)\\s*:\\s*([^;{}"'<>]*)`,
  'dgi',
);
const TEXT_PROP_RE = /^(?:-webkit-)?(?:color|text-fill-color)$|^WebkitTextFillColor$/i;
const STYLE_ATTR_RE = /\bstyle\s*=\s*(["'])(.*?)\1/dgi;

// Markup attributes that take a color.
const ATTR_NAMES = 'color|bgcolor|fill|stroke|stop-color|flood-color|lighting-color';
const QUOTED_ATTR_RE = new RegExp(`(?<![\\w:-])(?:${ATTR_NAMES})\\s*=\\s*(["'])(.*?)\\1`, 'dgi');
const UNQUOTED_ATTR_RE = new RegExp(
  `(?<![\\w:-])(?:${ATTR_NAMES})\\s*=\\s*([^\\s"'\`=<>{}]+)`,
  'dgi',
);
const META_RE = /<meta\b[^>]*>/gi;

// Color-ish JS names: CSS properties (camelCase or kebab-case), SVG attributes, canvas styles.
const COLOR_KEY =
  '[\\w-]*(?:[Cc]olor|[Bb]ackground|[Bb]order(?:-?(?:[Tt]op|[Rr]ight|[Bb]ottom|[Ll]eft|[Bb]lock|[Ii]nline)(?:-?(?:[Ss]tart|[Ee]nd))?)?|' +
  '[Oo]utline|[Ff]ill|[Ss]troke|[Ss]hadow|[Ff]ilter|[Dd]ecoration)|fillStyle|strokeStyle|bgcolor|' +
  '(?:background|border|mask|listStyle)-?[Ii]mage';
const COLOR_KEY_RE = new RegExp(`^(?:${COLOR_KEY})$`);
// { color: … } and { 'background-color': … }
const KEY_PROP_RE = new RegExp(`(?<![\\w$-])(["']?)(${COLOR_KEY})\\1\\s*:(?!:)\\s*`, 'dg');
// fill="…", fill={…}, const color = …
const ASSIGN_RE = new RegExp(`(?<![\\w$.-])(${COLOR_KEY})\\s*=(?![=>])\\s*`, 'dg');
// ctx.fillStyle = …, el.style['color'] = …
const MEMBER_ASSIGN_RE = /(?:\.\s*([\w$]+)|\[\s*(["'`])([\w-]+)\2\s*\])\s*=(?![=>])\s*/dg;
const SET_PROPERTY_RE = /\.setProperty\(\s*(["'`])[^"'`]*\1\s*,\s*/dg;
const SET_ATTRIBUTE_RE = new RegExp(
  `\\.setAttribute(?:NS)?\\(\\s*(?:[^,()"'\`]*,\\s*)?(["'\`])(?:${ATTR_NAMES})\\1\\s*,\\s*`,
  'dgi',
);
const TYPED_AFTER_RE = /^\s*(?:as|satisfies)\s+(?!const\b)[\w$]/;

const isDataOrAria = (name) => /^(?:data|aria)-/i.test(name);

/** First named color in a CSS value (ignoring url(…), var(--…) and file names), with its offset. */
function namedColorIn(value) {
  for (const m of value.matchAll(/(?<![\w./-])-*[a-z][\w-]*(?![\w./])/gi)) {
    if (NAMED_COLORS.has(m[0].toLowerCase())) return { word: m[0], index: m.index };
  }
  return undefined;
}

const blankUrls = (value) => value.replace(/url\([^)]*\)/gi, (s) => ' '.repeat(s.length));

/**
 * Reads the JS expression that starts at `from` (after `key:` or `=`) up to the `,`, `;` or
 * closing bracket that ends it, and returns the string literals it may evaluate to. Strings
 * inside calls and index brackets (cssVar('red'), colors['red']) are arguments, not values.
 * `isType` is set when a top-level `|` shows a union type ({ color: 'red' | 'blue' }).
 */
function scanExpr(src, from) {
  const strings = [];
  const stack = []; // true: grouping, array, object (values count); false: call or index
  const keep = () => !stack.includes(false);
  const limit = Math.min(src.length, from + 400);
  let prev = '';
  let isType = false;
  let i = from;
  while (i < limit) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (keep()) strings.push({ start: i + 1, value: src.slice(i + 1, j), end: j + 1 });
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let part = j;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') {
          j += 2;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          if (keep()) strings.push({ start: part, value: src.slice(part, j), end: j });
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          part = j;
        } else j++;
      }
      if (keep()) strings.push({ start: part, value: src.slice(part, j), end: j + 1 });
      i = j + 1;
      prev = '`';
      continue;
    }
    if (c === '(' || c === '[') stack.push(!/[\w$)\]]/.test(prev));
    else if (c === '{') stack.push(true);
    else if (c === ')' || c === ']' || c === '}') {
      if (!stack.length) break;
      stack.pop();
    } else if (!stack.length && (c === ',' || c === ';')) break;
    else if (!stack.length && c === '|' && src[i + 1] !== '|' && src[i - 1] !== '|') isType = true;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return {
    strings: strings.filter((s) => !TYPED_AFTER_RE.test(src.slice(s.end, s.end + 40))),
    end: i,
    isType,
  };
}

/**
 * @typedef {{ kind: 'script' | 'style' | 'markup', text: string, masked: string,
 *   strings: string | null, strMask: Uint8Array | null }} Source
 */

/** Finds loose colors; returns Map<offset, message> (first message per offset wins). */
function detect(/** @type {Source} */ src) {
  const { kind, text, masked, strings, strMask } = src;
  // Where literal text lives: string contents for scripts, the masked source otherwise.
  const tv = strings ?? masked;
  const found = new Map();
  const add = (offset, message) => {
    if (!found.has(offset)) found.set(offset, message);
  };
  const inString = (offset) => strMask !== null && strMask[offset] === 1;

  const checkValue = (start, value, where, textProp = false) => {
    const cleaned = blankUrls(value);
    const named = namedColorIn(cleaned);
    if (named) add(start + named.index, `named color ${named.word} in ${where}`);
    for (const m of cleaned.matchAll(HEX_RE)) add(start + m.index, `hex color ${m[0]}`);
    if (textProp) {
      for (const m of cleaned.matchAll(VAR_NOT_TEXT_RE)) {
        add(
          start + m.index,
          `var(--${m[1]}) is not a text color (under 4.5:1): use var(--${NOT_TEXT[m[1]]})`,
        );
      }
    }
  };
  const checkCss = (view, offset = 0) => {
    for (const m of view.matchAll(CSS_DECL_RE)) {
      checkValue(offset + m.indices[2][0], m[2], m[1], TEXT_PROP_RE.test(m[1]));
    }
  };
  const checkExpr = (from, where) => {
    const expr = scanExpr(masked, from);
    if (expr.isType) return;
    for (const s of expr.strings) checkValue(s.start, s.value, where, TEXT_PROP_RE.test(where));
    if (where === 'color') {
      for (const m of masked.slice(from, expr.end).matchAll(CSSVAR_NOT_TEXT_RE)) {
        add(
          from + m.index,
          `cssVar('${m[2]}') is not a text color (under 4.5:1): use cssVar('${m[2] === 'red' ? 'redText' : 'fgMuted'}')`,
        );
      }
    }
  };

  // Hex: skip references (url(#id), href="#id", selectors) and prose numbers ('Logro #100').
  const isReference = (at, length) => {
    const before = masked.slice(Math.max(0, at - 120), at);
    if (/url\(\s*["']?$/i.test(before)) return true;
    if (/\b(?:xlink:)?href\s*=\s*\{?\s*["'`]?$/i.test(before)) return true;
    if (/\.(?:querySelector(?:All)?|closest|matches)\(\s*["'`][^"'`\n]*$/.test(before)) return true;
    for (let k = at + length; k < tv.length; k++) {
      const c = tv[k];
      if (c === '{') return true; // CSS selector: #fab { … }
      if (c === ';' || c === '}' || c === '<') return false;
    }
    return false;
  };
  for (const m of tv.matchAll(HEX_RE)) {
    const hex = m[0];
    if (SHORT_DIGITS_RE.test(hex)) {
      // #123 is a color in CSS, or as a whole JS string ('#123'); elsewhere it is a number.
      const q = text[m.index - 1];
      const whole = (q === '"' || q === "'" || q === '`') && text[m.index + hex.length] === q;
      if (kind === 'markup' || (kind === 'script' && !whole)) continue;
    }
    if (!isReference(m.index, hex.length)) add(m.index, `hex color ${hex}`);
  }
  for (const m of masked.matchAll(FUNCTION_RE)) add(m.index, `color function ${m[0]}…)`);

  // Tailwind.
  for (const m of tv.matchAll(TW_PALETTE_RE)) add(m.index, `Tailwind palette class ${m[0]}`);
  for (const re of [TW_ARBITRARY_VALUE_RE, TW_ARBITRARY_PROP_RE]) {
    for (const m of tv.matchAll(re)) {
      const value = m[1]
        .replace(/_/g, ' ')
        .replace(/(["'])(?:(?!\1).)*\1/g, (s) => ' '.repeat(s.length));
      checkValue(m.indices[1][0], value, m[0]);
    }
  }
  for (const m of tv.matchAll(TW_TEXT_TOKEN_RE)) {
    const token = m[1];
    const icons = ['red', 'neutral', 'accent'].includes(token)
      ? `; icons can use stroke-${token}`
      : '';
    add(
      m.index,
      `text-${token} is not a text color (under 4.5:1): use text-${NOT_TEXT[token]}${icons}`,
    );
  }

  // CSS declarations and style="…" attributes.
  for (const m of masked.matchAll(STYLE_ATTR_RE)) checkCss(m[2], m.indices[2][0]);
  if (kind === 'style') checkCss(masked);
  else if (kind === 'markup') checkCss(masked.replace(STYLE_ATTR_RE, (s) => ' '.repeat(s.length)));
  else checkCss(tv);

  if (kind === 'markup') {
    for (const m of masked.matchAll(QUOTED_ATTR_RE)) checkValue(m.indices[2][0], m[2], 'attribute');
    for (const m of masked.matchAll(UNQUOTED_ATTR_RE))
      checkValue(m.indices[1][0], m[1], 'attribute');
    for (const m of masked.matchAll(META_RE)) {
      if (!/\bname\s*=\s*["']?[\w-]*colou?r/i.test(m[0])) continue;
      const content = /\bcontent\s*=\s*(?:(["'])(.*?)\1|([^\s"'>]+))/d.exec(m[0]);
      if (!content) continue;
      const [start] = content.indices[2] ?? content.indices[3];
      checkValue(m.index + start, content[2] ?? content[3], 'theme color');
    }
  }

  if (kind === 'script') {
    for (const m of masked.matchAll(KEY_PROP_RE)) {
      if (inString(m.index) || isDataOrAria(m[2])) continue;
      checkExpr(m.index + m[0].length, m[2]);
    }
    for (const m of masked.matchAll(ASSIGN_RE)) {
      const name = m[1];
      // type TileColor = 'green' | 'blue' is a type, not a value.
      if (
        isDataOrAria(name) ||
        /\btype\s+$/.test(masked.slice(Math.max(0, m.index - 12), m.index))
      ) {
        continue;
      }
      const at = m.index + m[0].length;
      const q = masked[at];
      if (q === '"' || q === "'") {
        // fill="red" (JSX, or markup inside a string) or const fill = 'red'.
        const close = masked.indexOf(q, at + 1);
        const end = close === -1 ? masked.length : close;
        const value = masked.slice(at + 1, end);
        if (!value.includes('\n')) checkValue(at + 1, value, name, TEXT_PROP_RE.test(name));
      } else if (!inString(m.index)) {
        checkExpr(q === '{' ? at + 1 : at, name);
      }
    }
    for (const m of masked.matchAll(MEMBER_ASSIGN_RE)) {
      const name = m[1] ?? m[3];
      if (!COLOR_KEY_RE.test(name) || inString(m.index)) continue;
      checkExpr(m.index + m[0].length, name);
    }
    for (const re of [SET_PROPERTY_RE, SET_ATTRIBUTE_RE]) {
      for (const m of masked.matchAll(re)) {
        if (!inString(m.index)) checkExpr(m.index + m[0].length, 'attribute');
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Masking: comments become spaces (newlines kept) so offsets stay valid. Scripts also get a
// string mask (string, template and JSX text contents), the only place a color literal can be.
// ---------------------------------------------------------------------------------------------

function blank(chars, from, to) {
  for (let k = from; k < to && k < chars.length; k++) {
    if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
  }
}

const REGEX_AFTER_CHARS = new Set('([{,;:=!&|?+-*%<>~^'.split(''));
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'void',
  'yield',
  'await',
  'delete',
  'throw',
  'new',
]);

/**
 * Masks // and /* comments in JS/TS, skipping strings, template literals and regex literals,
 * and (with `jsx`) JSX text and attribute strings, where // and /* are just text.
 */
function maskScript(text, options = {}) {
  const { jsx = false, start = 0, end = text.length } = options;
  const chars = options.chars ?? text.split('');
  const strMask = options.strMask ?? new Uint8Array(text.length);
  const markString = (from, to) => {
    if (to > from) strMask.fill(1, from, Math.min(to, end));
  };

  const precedingWord = (i) => {
    let j = i;
    while (j > start && /[\w$]/.test(text[j - 1])) j--;
    return text.slice(j, i);
  };
  const skipSpace = (j) => {
    while (j < end && /\s/.test(text[j])) j++;
    return j;
  };
  const lineComment = (i) => {
    let j = i;
    while (j < end && text[j] !== '\n') j++;
    blank(chars, i, j);
    return j;
  };
  const blockComment = (i) => {
    const close = text.indexOf('*/', i + 2);
    const j = close === -1 || close + 2 > end ? end : close + 2;
    blank(chars, i, j);
    return j;
  };

  const quoted = (i, quote) => {
    let j = i + 1;
    while (j < end) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === quote || c === '\n') {
        markString(i + 1, j);
        return c === quote ? j + 1 : j;
      } else j++;
    }
    markString(i + 1, end);
    return end;
  };

  const regex = (i) => {
    let j = i + 1;
    let inClass = false;
    while (j < end) {
      const c = text[j];
      if (c === '\n') return i + 1; // not a regex after all: treat the slash as division
      if (c === '\\') j += 2;
      else if (c === '/' && !inClass) {
        j++;
        while (j < end && /[a-z]/i.test(text[j])) j++;
        return j;
      } else {
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        j++;
      }
    }
    return end;
  };

  // JSX: returns the index after the element or fragment at `i` (a '<'), or -1 if it is not one.
  const element = (i) => {
    let j = skipSpace(i + 1);
    if (text[j] === '>') return children(j + 1); // <>…</>
    if (!/[A-Za-z_$]/.test(text[j] ?? '')) return -1;
    while (j < end && /[\w$.:-]/.test(text[j])) j++;
    j = skipSpace(j);
    // Generic arrow functions in .tsx: <T,>(x) => …, <T extends U>(x) => …
    if (text[j] === ',' || /^extends\b/.test(text.slice(j, j + 8))) return -1;
    let attributes = 0;
    for (;;) {
      j = skipSpace(j);
      if (j >= end) return end;
      const c = text[j];
      if (c === '/' && text[j + 1] === '/') j = lineComment(j);
      else if (c === '/' && text[j + 1] === '*') j = blockComment(j);
      else if (c === '/' && text[j + 1] === '>') return j + 2;
      else if (c === '>') {
        if (attributes === 0 && text[j + 1] === '(') return -1; // <T>(x) => … in a type
        return children(j + 1);
      } else if (c === '{') {
        j = code(j + 1, true);
        attributes++;
      } else if (/[A-Za-z_$]/.test(c)) {
        while (j < end && /[\w$.:-]/.test(text[j])) j++;
        attributes++;
        j = skipSpace(j);
        if (text[j] !== '=') continue; // boolean attribute
        j = skipSpace(j + 1);
        const v = text[j];
        if (v === '"' || v === "'") {
          const close = text.indexOf(v, j + 1);
          const k = close === -1 || close >= end ? end : close;
          markString(j + 1, k);
          j = k + 1;
        } else if (v === '{') j = code(j + 1, true);
        else if (v === '<') {
          const k = element(j);
          if (k === -1) return -1;
          j = k;
        } else return -1;
      } else return -1;
    }
  };

  // JSX children up to and including the closing tag.
  const children = (i) => {
    let j = i;
    let from = i;
    while (j < end) {
      const c = text[j];
      if (c === '{') {
        markString(from, j);
        j = code(j + 1, true);
        from = j;
      } else if (c === '<') {
        markString(from, j);
        if (text[skipSpace(j + 1)] === '/') {
          const close = text.indexOf('>', j);
          return close === -1 || close >= end ? end : close + 1;
        }
        const k = element(j);
        j = k === -1 ? j + 1 : k;
        from = j;
      } else j++;
    }
    markString(from, end);
    return end;
  };

  // Scans code from i; with untilBrace, stops after the `}` that closes a `${` or JSX `{`.
  const code = (i, untilBrace) => {
    let depth = 0;
    let prev = '';
    let prevEnd = i;
    const exprStart = () =>
      prev === '' || REGEX_AFTER_CHARS.has(prev) || REGEX_AFTER_WORDS.has(precedingWord(prevEnd));
    while (i < end) {
      const c = text[i];
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        i = lineComment(i);
      } else if (c === '/' && next === '*') {
        i = blockComment(i);
      } else if (c === '"' || c === "'") {
        i = quoted(i, c);
        prev = c;
        prevEnd = i;
      } else if (c === '`') {
        i = template(i + 1);
        prev = '`';
        prevEnd = i;
      } else if (c === '/' && exprStart()) {
        i = regex(i);
        prev = '/';
        prevEnd = i;
      } else if (jsx && c === '<' && exprStart()) {
        const after = element(i);
        // -1: a comparison or a generic (<T,>), not JSX.
        i = after === -1 ? i + 1 : after;
        prev = after === -1 ? c : ')';
        prevEnd = i;
      } else {
        if (untilBrace && c === '{') depth++;
        if (untilBrace && c === '}') {
          if (depth === 0) return i + 1;
          depth--;
        }
        if (!/\s/.test(c)) {
          prev = c;
          prevEnd = i + 1;
        }
        i++;
      }
    }
    return i;
  };

  const template = (i) => {
    let j = i;
    let from = i;
    while (j < end) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') {
        markString(from, j);
        return j + 1;
      } else if (c === '$' && text[j + 1] === '{') {
        markString(from, j);
        j = code(j + 2, true);
        from = j;
      } else j++;
    }
    markString(from, end);
    return end;
  };

  code(start, false);
  return { chars, strMask };
}

/** Masks /* comments in CSS, skipping strings. */
function maskStyle(text, chars = text.split(''), start = 0, end = text.length) {
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < end && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const j = close === -1 || close + 2 > end ? end : close + 2;
      blank(chars, i, j);
      i = j;
    } else i++;
  }
  return chars;
}

/** Masks <!-- --> comments, plus comments inside <style> and <script> elements. */
function maskMarkup(text) {
  const chars = text.split('');
  for (const m of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    blank(chars, m.index, m.index + m[0].length);
  }
  const masked = chars.join('');
  for (const m of masked.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
    const from = m.index + m[1].length;
    maskStyle(text, chars, from, from + m[2].length);
  }
  for (const m of masked.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const from = m.index + m[1].length;
    maskScript(text, { chars, start: from, end: from + m[2].length });
  }
  return chars;
}

function kindOf(file) {
  const ext = extname(file).toLowerCase();
  if (SCRIPT_EXTS.has(ext)) return 'script';
  if (STYLE_EXTS.has(ext)) return 'style';
  return 'markup';
}

/** @typedef {{ line: number, column: number, message: string }} Finding */

/** @returns {Finding[]} */
function lintText(text, kind, jsx = false) {
  let chars;
  let strMask = null;
  if (kind === 'script') ({ chars, strMask } = maskScript(text, { jsx }));
  else chars = kind === 'style' ? maskStyle(text) : maskMarkup(text);
  const masked = chars.join('');
  // String contents only; code becomes ';' so CSS values and selectors end at string edges.
  const strings =
    strMask &&
    Array.from(text, (ch, k) => (strMask[k] === 1 || ch === '\n' || ch === '\r' ? ch : ';')).join(
      '',
    );
  const found = detect({ kind, text, masked, strings, strMask });

  // Allow markers count only inside comments: a string that says '// allow-color' does not.
  const comments = Array.from(text, (ch, k) => (ch === '\n' || chars[k] !== ch ? ch : ' ')).join(
    '',
  );
  const commentLines = comments.split('\n');
  const lineStarts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  /** @type {Finding[]} */
  const findings = [];
  for (const [offset, message] of [...found].sort((a, b) => a[0] - b[0])) {
    const line = lineOf(offset);
    if (ALLOW_MARKER.test(commentLines[line] ?? '')) continue;
    findings.push({ line: line + 1, column: offset - lineStarts[line] + 1, message });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const toPosix = (p) => p.split(sep).join('/');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function isExcluded(root, file) {
  const rel = toPosix(relative(root, file));
  return EXCLUDED.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

function collect(root, path, exts, out) {
  if (isExcluded(root, path)) return;
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
      collect(root, resolve(path, entry.name), exts, out);
    }
  } else if (stats.isFile() && exts.has(extname(path).toLowerCase())) {
    out.push(path);
  }
}

function parseArgs(argv) {
  let root = process.env.LINT_COLORS_ROOT || REPO_ROOT;
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error('--root needs a directory');
      root = value;
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  return { root: resolve(root), paths };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`lint-colors: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (args.help) {
    console.log('Usage: node scripts/lint-colors.mjs [--root <dir>] [path ...]');
    return 0;
  }
  const { root, paths } = args;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`lint-colors: root ${root} is not a directory`);
    return 2;
  }

  const targets = paths.length
    ? paths.map((p) => ({ path: p, exts: ALL_EXTS, explicit: true }))
    : DEFAULT_TARGETS;
  const files = [];
  for (const target of targets) {
    const abs = isAbsolute(target.path) ? target.path : resolve(root, target.path);
    if (!existsSync(abs)) {
      if (target.explicit) {
        console.error(`lint-colors: ${target.path} does not exist`);
        return 2;
      }
      continue;
    }
    collect(root, abs, target.exts, files);
  }

  // Same order and separators on every OS.
  const entries = files
    .map((file) => ({ file, rel: toPosix(relative(root, file)) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let count = 0;
  for (const { file, rel } of entries) {
    const jsx = JSX_EXTS.has(extname(file).toLowerCase());
    const findings = lintText(readFileSync(file, 'utf8'), kindOf(file), jsx);
    for (const f of findings) console.log(`${rel}:${f.line}:${f.column}: ${f.message}`);
    count += findings.length;
  }

  if (count > 0) {
    console.log(
      `\nlint-colors: ${plural(count, 'loose color')} in ${plural(files.length, 'file')}. ` +
        'Use the tokens from @centrate/shared/design/tokens.css (var(--…), Tailwind classes) or ' +
        'tokens.ts; name accent props `accent` or `tone`, never `color`; mark a deliberate ' +
        "exception with '// allow-color'.",
    );
    return 1;
  }
  console.log(`lint-colors: no loose colors in ${plural(files.length, 'file')}.`);
  return 0;
}

process.exitCode = main();
