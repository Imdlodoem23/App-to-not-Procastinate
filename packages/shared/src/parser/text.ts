import {
  findCategoryByAlias,
  findServiceByAlias,
  findServiceByDomain,
  normalizeDomain,
} from '../catalog';
import { lookupAlias } from './aliases';

/** Lowercase with accents removed: «Bloquéame» → «bloqueame», «mañana» → «manana». */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * - `word`: letters, optionally followed by digits («youtube», «y8»).
 * - `num`: starts with a digit («2», «1,5», «18:00», «1h30», «90min», «20minutos»).
 * - `domain`: a host or URL the user typed («marca.com», «https://x.com/home»).
 * - `plus`: a lone «+» («Disney+», «youtube + tiktok»).
 */
export type TokenType = 'word' | 'num' | 'domain' | 'plus';

export interface Token {
  /** Original text, as typed. */
  readonly text: string;
  /** Folded text (see `fold`); for `domain` tokens, the normalized domain. */
  readonly norm: string;
  readonly start: number;
  readonly end: number;
  readonly type: TokenType;
  /** Punctuation («,», «.», «(»…) separates this token from the previous one. */
  readonly breakBefore: boolean;
}

// Labels may end with «-» here to keep the regex linear; normalizeDomain validates them.
const DOMAIN_SRC = String.raw`(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}[\p{L}\p{N}-]*(?::\d{1,5})?(?:[/?#][^\s,;«»"'()]*)?`;
const NUM_SRC = String.raw`\d+(?:[:.,]\d+)?[\p{L}\p{N}\p{M}]*`;
const WORD_SRC = String.raw`[\p{L}\p{M}][\p{L}\p{N}\p{M}]*`;
const TOKEN_RE = new RegExp(`(${DOMAIN_SRC})|(${NUM_SRC})|(${WORD_SRC})|(\\+)`, 'giu');
const PLAIN_RE = new RegExp(`(${NUM_SRC})|(${WORD_SRC})|(\\+)`, 'giu');
const BREAK_RE = /[,;.:!?¿¡()[\]{}/\\|…]/;
/** A word with digits glued to it: «youtube1h», «tiktok30min». */
const GLUED_RE = /^(\p{L}[\p{L}\p{M}]*)(\d[\p{L}\p{N}\p{M}]*)$/u;
/**
 * Compact durations that may be glued to an alias («1h», «30min», «1h30», «2horas»,
 * «1hour»).
 */
const GLUED_DURATION_RE = new RegExp(
  String.raw`^(?:\d{1,4}(?:h|hr|hrs|hs|horas?|oras?|hours?|m|min|mins|minutos?|minutes?)` +
    String.raw`|\d{1,3}h\d{1,2}(?:m|min|mins|minutos?|minutes?)?)$`,
);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Top-level domains accepted without a scheme or «www.». Anything else that merely looks
 * like a domain («youtube.hasta», a missing space after a period) is read as words.
 */
const COMMON_TLDS: ReadonlySet<string> = new Set(
  (
    'com net org edu gov mil int info biz io co tv me gg app dev ai xyz online site web blog ' +
    'shop store news live club fm es cat eus gal eu uk us fr de it pt nl be ch at ie pl se no ' +
    'dk fi ru ua cn jp kr in br ar mx cl pe ve uy ec bo py cr do gt hn ni pa sv pr cu ca au ' +
    'nz za ly to cc ws la gl'
  ).split(' '),
);

function acceptDomain(raw: string): string | null {
  const domain = normalizeDomain(raw);
  if (domain === null) return null;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  const accepted =
    SCHEME_RE.test(raw) ||
    domain.startsWith('www.') ||
    COMMON_TLDS.has(tld) ||
    findServiceByDomain(domain) !== undefined;
  return accepted ? domain : null;
}

function typeOf(match: RegExpMatchArray, numGroup: number, wordGroup: number): TokenType {
  if (match[numGroup] !== undefined) return 'num';
  if (match[wordGroup] !== undefined) return 'word';
  return 'plus';
}

/**
 * «youtube1h» → [«youtube», «1h»]: a word made of an alias and a compact duration typed
 * without a space. Other words with digits («y8», «fc26») stay whole.
 */
function splitGlued(raw: string): [string, string] | null {
  const match = GLUED_RE.exec(raw);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  if (!GLUED_DURATION_RE.test(fold(match[2])) || lookupAlias(match[1]) === undefined) return null;
  return [match[1], match[2]];
}

/** Splits `text` into tokens with offsets into the original string. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let previousEnd = 0;
  const push = (raw: string, start: number, type: TokenType, norm?: string): void => {
    const breakBefore = tokens.length > 0 && BREAK_RE.test(text.slice(previousEnd, start));
    const end = start + raw.length;
    tokens.push({ text: raw, norm: norm ?? fold(raw), start, end, type, breakBefore });
    previousEnd = end;
  };
  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    if (match[1] === undefined) {
      const type = typeOf(match, 2, 3);
      const glued = type === 'word' ? splitGlued(raw) : null;
      if (glued) {
        push(glued[0], start, 'word');
        push(glued[1], start + glued[0].length, 'num');
      } else {
        push(raw, start, type);
      }
      continue;
    }
    const domain = acceptDomain(raw);
    if (domain !== null) {
      push(raw, start, 'domain', domain);
    } else if (findCategoryByAlias(raw) !== undefined || findServiceByAlias(raw) !== undefined) {
      // Dotted aliases such as «RR.SS.».
      push(raw, start, 'word');
    } else {
      for (const part of raw.matchAll(PLAIN_RE)) {
        push(part[0], start + (part.index ?? 0), typeOf(part, 1, 2));
      }
    }
  }
  return tokens;
}

/** Folded text of `tokens[k]`, or '' when out of range. */
export function normAt(tokens: readonly Token[], k: number): string {
  return tokens[k]?.norm ?? '';
}

/**
 * Folded text of `tokens[k]` when it continues the current expression, or '' when it is
 * out of range or punctuation separates it from the previous token.
 */
export function nextNorm(tokens: readonly Token[], k: number): string {
  const token = tokens[k];
  return token && !token.breakBefore ? token.norm : '';
}
