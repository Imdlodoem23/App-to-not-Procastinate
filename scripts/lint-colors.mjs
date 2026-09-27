#!/usr/bin/env node
// Rejects loose colors in the desktop app and the extension: every color must come from
// packages/shared/src/design/tokens.css (CSS variables, Tailwind classes) or tokens.ts.
//
// Usage: node scripts/lint-colors.mjs [--root <dir>] [path ...]
//   --root <dir>  directory that default targets, paths and output are relative to
//                 (default: $LINT_COLORS_ROOT, else the repository root)
//   path ...      files or folders to scan instead of the default targets
//
// Flags hex colors (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba()/hsl()/hsla() (and hwb, lab,
// lch, oklab, oklch) literals, CSS named colors used as values of color properties, style props
// and color attributes, and Tailwind's default palette classes. Comments are ignored. A line
// containing `// allow-color`, `/* allow-color */` or `<!-- allow-color -->` is skipped.
// Files under packages/shared/src/design are never checked.
//
// Exit code: 0 clean, 1 loose colors found, 2 usage error.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
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

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

const HEX_RE = /(?<![\w&#$.\\-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const FUNCTION_RE = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const TW_PALETTE_RE = new RegExp(
  `(?<![\\w-])(?:${TW_COLOR_UTILITIES})-(?:white|black|(?:${TW_PALETTE})-\\d{2,3})(?![\\w-])`,
  'g',
);
const TW_ARBITRARY_RE = /-\[(?:color:)?([a-z]+)\]/gi;
// CSS declarations of color properties (CSS files, <style>, style="…" attributes).
const CSS_DECL_RE =
  /(?<![\w-])((?:-webkit-)?(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|fill|stroke|stop-color|flood-color|lighting-color|caret-color|accent-color|column-rule(?:-color)?|text-decoration(?:-color)?|text-emphasis(?:-color)?|box-shadow|text-shadow|scrollbar-color)|--[\w-]+)\s*:\s*([^;{}"'<>]*)/gi;
const STYLE_ATTR_RE = /\bstyle\s*=\s*(["'])(.*?)\1/gi;
// Markup and JSX attributes that take a color.
const COLOR_ATTR_RE =
  /(?<![\w-])(?:color|bgcolor|fill|stroke|stop-color|flood-color|lighting-color|stopColor|floodColor|lightingColor|backgroundColor)\s*=\s*\{?\s*(["'`])(.*?)\1/g;
// Object properties with a color-ish key and a string value: { backgroundColor: 'white' }.
const STYLE_PROP_RE =
  /(?<![\w$-])["']?([\w-]*(?:color|Color|background|Background|border|Border|outline|Outline|fill|Fill|stroke|Stroke|shadow|Shadow))["']?\s*:\s*(["'`])(.*?)\2/g;
const STYLE_ASSIGN_RE = /\.style\.\w+\s*=\s*(["'`])(.*?)\1/g;
const SET_PROPERTY_RE = /\.setProperty\(\s*(["'])[^"']*\1\s*,\s*(["'`])(.*?)\2/g;

/** First named color in a CSS value, ignoring url(…) and var(--…) names. */
function namedColorIn(value) {
  const cleaned = value.replace(/url\([^)]*\)/gi, ' ');
  for (const word of cleaned.match(/-*[a-z][\w-]*/gi) ?? []) {
    if (NAMED_COLORS.has(word.toLowerCase())) return word;
  }
  return undefined;
}

/** @typedef {{ line: number, column: number, message: string }} Finding */

/** @returns {Finding[]} */
function findInLine(line, lineNumber, kind) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (index, message) => findings.push({ line: lineNumber, column: index + 1, message });

  for (const m of line.matchAll(HEX_RE)) add(m.index, `hex color ${m[0]}`);
  for (const m of line.matchAll(FUNCTION_RE)) add(m.index, `color function ${m[0]}…)`);
  for (const m of line.matchAll(TW_PALETTE_RE)) add(m.index, `Tailwind palette class ${m[0]}`);
  for (const m of line.matchAll(TW_ARBITRARY_RE)) {
    if (NAMED_COLORS.has(m[1].toLowerCase())) add(m.index, `named color ${m[1]} in ${m[0]}`);
  }

  const checkCss = (text, offset) => {
    for (const m of text.matchAll(CSS_DECL_RE)) {
      const named = namedColorIn(m[2]);
      if (named) add(offset + m.index, `named color ${named} in ${m[1]}`);
    }
  };
  const checkValue = (index, what, value) => {
    const named = namedColorIn(value);
    if (named) add(index, `named color ${named} in ${what}`);
  };

  if (kind === 'style') checkCss(line, 0);
  for (const m of line.matchAll(STYLE_ATTR_RE)) checkCss(m[2], m.index + m[0].indexOf(m[2]));
  if (kind === 'markup') checkCss(line.replace(STYLE_ATTR_RE, (s) => ' '.repeat(s.length)), 0);
  if (kind !== 'style') {
    for (const m of line.matchAll(COLOR_ATTR_RE)) checkValue(m.index, 'color attribute', m[2]);
  }
  if (kind === 'script') {
    for (const m of line.matchAll(STYLE_PROP_RE)) {
      // `color: 'red' | 'blue'` is a string-literal type, not a value.
      if (!/^\s*\|/.test(line.slice(m.index + m[0].length))) checkValue(m.index, m[1], m[3]);
    }
    for (const m of line.matchAll(STYLE_ASSIGN_RE)) checkValue(m.index, 'style assignment', m[2]);
    for (const m of line.matchAll(SET_PROPERTY_RE)) checkValue(m.index, 'setProperty', m[3]);
  }

  // One report per position.
  const seen = new Set();
  return findings.filter((f) => !seen.has(f.column) && seen.add(f.column));
}

// ---------------------------------------------------------------------------------------------
// Comment masking: comments become spaces (newlines kept) so line/column numbers stay valid.
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

/** Masks // and /* comments in JS/TS, skipping strings, template literals and regex literals. */
function maskScript(text, chars = text.split(''), start = 0, end = text.length) {
  const precedingWord = (i) => {
    let j = i;
    while (j > start && /[\w$]/.test(text[j - 1])) j--;
    return text.slice(j, i);
  };

  const quoted = (i, quote) => {
    let j = i + 1;
    while (j < end) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === quote) return j + 1;
      else if (c === '\n') return j;
      else j++;
    }
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

  // Scans code from i; with untilBrace, stops after the `}` that closes a template `${`.
  const code = (i, untilBrace) => {
    let depth = 0;
    let prev = '';
    let prevEnd = i;
    while (i < end) {
      const c = text[i];
      const next = text[i + 1];
      if (c === '/' && next === '/') {
        let j = i;
        while (j < end && text[j] !== '\n') j++;
        blank(chars, i, j);
        i = j;
      } else if (c === '/' && next === '*') {
        const close = text.indexOf('*/', i + 2);
        const j = close === -1 || close + 2 > end ? end : close + 2;
        blank(chars, i, j);
        i = j;
      } else if (c === '"' || c === "'") {
        i = quoted(i, c);
        prev = c;
        prevEnd = i;
      } else if (c === '`') {
        i = template(i + 1);
        prev = '`';
        prevEnd = i;
      } else if (
        c === '/' &&
        (prev === '' ||
          REGEX_AFTER_CHARS.has(prev) ||
          REGEX_AFTER_WORDS.has(precedingWord(prevEnd)))
      ) {
        i = regex(i);
        prev = '/';
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
    while (j < end) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') return j + 1;
      else if (c === '$' && text[j + 1] === '{') j = code(j + 2, true);
      else j++;
    }
    return end;
  };

  code(start, false);
  return chars;
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
  for (const m of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) blank(chars, m.index, m.index + m[0].length);
  const masked = chars.join('');
  for (const m of masked.matchAll(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi)) {
    const from = m.index + m[1].length;
    maskStyle(text, chars, from, from + m[2].length);
  }
  for (const m of masked.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const from = m.index + m[1].length;
    maskScript(text, chars, from, from + m[2].length);
  }
  return chars;
}

function kindOf(file) {
  const ext = extname(file).toLowerCase();
  if (SCRIPT_EXTS.has(ext)) return 'script';
  if (STYLE_EXTS.has(ext)) return 'style';
  return 'markup';
}

/** @returns {Finding[]} */
function lintText(text, kind) {
  const masked = (
    kind === 'script' ? maskScript(text) : kind === 'style' ? maskStyle(text) : maskMarkup(text)
  ).join('');
  const rawLines = text.split('\n');
  const lines = masked.split('\n');
  return lines.flatMap((line, i) =>
    ALLOW_MARKER.test(rawLines[i] ?? '') ? [] : findInLine(line.replace(/\r$/, ''), i + 1, kind),
  );
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const toPosix = (p) => p.split(sep).join('/');

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

  let count = 0;
  for (const file of files.sort()) {
    const findings = lintText(readFileSync(file, 'utf8'), kindOf(file));
    for (const f of findings) {
      console.log(`${toPosix(relative(root, file))}:${f.line}:${f.column}: ${f.message}`);
    }
    count += findings.length;
  }

  if (count > 0) {
    console.log(
      `\nlint-colors: ${count} loose color${count === 1 ? '' : 's'} in ${files.length} files. ` +
        'Use the tokens from @centrate/shared/design/tokens.css (var(--…), Tailwind classes) or ' +
        "tokens.ts; mark a deliberate exception with '// allow-color'.",
    );
    return 1;
  }
  console.log(`lint-colors: no loose colors in ${files.length} files.`);
  return 0;
}

process.exitCode = main();
