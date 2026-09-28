import { aliasKey } from '../catalog';
import {
  fuzzyLookup,
  INTERJECTION_KEYS,
  isWeakAliasKey,
  lookupAlias,
  type TargetRef,
} from './aliases';
import { UNIT_WORDS } from './duration';
import { NUMBER_WORDS } from './numbers';
import { nextNorm, type Token } from './text';
import {
  CONSUME,
  DESIRE,
  DESIRE_BEFORE_TARGET,
  isDe,
  isFiller,
  OTHER_KNOWN,
  STUDY_NOUNS,
  STUDY_NOUNS_AFTER_HACER,
  STUDY_NOUN_VERBS,
  STUDY_VERBS,
  TRIGGER_BRIDGE,
  TRIGGERS,
  TRIGGERS_BEFORE_DE,
  TRIGGERS_BEFORE_T,
} from './vocabulary';

export type TargetHit = (TargetRef | { readonly kind: 'domain'; readonly id: string }) & {
  /** Token range [start, end). */
  readonly start: number;
  readonly end: number;
};

interface Candidate {
  readonly hit: TargetHit;
  readonly weak: boolean;
  /** Alias key of the typed words («x», «lol»), for the per-alias rules. */
  readonly key: string;
}

const MAX_NGRAM = 4;
/** Fuzzy hits on words this short need the same context as weak aliases. */
const MAX_WEAK_FUZZY_LENGTH = 5;
/** At most this many `TRIGGER_BRIDGE` words between a block word and a weak alias. */
const MAX_BRIDGE = 4;
export const LIST_CONNECTORS: ReadonlySet<string> = new Set([
  'y',
  'e',
  'o',
  'u',
  'ni',
  'and',
  'or',
  'nor',
]);
/** «ni» and «nor»: list connectors that are also block words. */
export const NEGATIVE_CONNECTORS: ReadonlySet<string> = new Set(['ni', 'nor']);
/** «o», «or»: a choice, never a list of targets to block together. */
export const CHOICE_CONNECTORS: ReadonlySet<string> = new Set(['o', 'or']);
/**
 * «vídeos de YouTube», «juegos en Steam», «jugar al LoL», «videos on YouTube», «games on
 * Steam»: the category only describes.
 */
const DESCRIPTOR_LINKS: ReadonlySet<string> = new Set([
  'de',
  'del',
  'en',
  'a',
  'al',
  'on',
  'of',
  'in',
  'at',
  'from',
]);
const DESCRIPTOR_FILLERS: ReadonlySet<string> = new Set(['el', 'la', 'los', 'las', 'the', 'my']);
/** Skipped when looking at what comes right before or after a target («ni el insta»). */
const ARTICLES: ReadonlySet<string> = new Set([
  'el',
  'la',
  'los',
  'las',
  'lo',
  'un',
  'una',
  'unos',
  'unas',
  'mi',
  'mis',
  'tu',
  'tus',
  'su',
  'sus',
  // Not «a»: in Spanish it is «to» («jugar a lol»).
  'the',
  'an',
  'my',
  'your',
  'his',
  'her',
  'our',
  'their',
  'any',
  'some',
  'all',
]);
/** «jugar al LoL», «no juego lol», «nada de lol», «play lol»: after these, «lol» is the game. */
const LOL_LEADS: ReadonlySet<string> = new Set([
  'al',
  'a',
  'de',
  'jugar',
  'juego',
  'juegas',
  'juegues',
  'juegue',
  'jugando',
  'play',
  'playing',
]);
/**
 * Everyday phrases whose words are also aliases: «no tengo vida social», «examen de
 * ciencias sociales». They are never targets.
 */
const NON_TARGET_PHRASES: ReadonlyArray<readonly string[]> = [
  ['vida', 'social'],
  ['ciencias', 'sociales'],
  ['trabajo', 'social'],
  ['educacion', 'social'],
  ['seguridad', 'social'],
  ['redes', 'neuronales'],
  ['social', 'life'],
  ['social', 'studies'],
  ['social', 'skills'],
  ['social', 'science'],
  ['social', 'sciences'],
  ['social', 'work'],
  ['social', 'worker'],
  ['social', 'security'],
  ['neural', 'networks'],
];

/**
 * True when `tokens[k]` says «block this» («no», «sin», «bloquea», «paso de», «block»,
 * «without», the «don» of «don't»…).
 */
export function isTriggerAt(tokens: readonly Token[], k: number): boolean {
  const word = tokens[k]?.norm ?? '';
  const next = nextNorm(tokens, k + 1);
  return (
    TRIGGERS.has(word) ||
    (TRIGGERS_BEFORE_DE.has(word) && isDe(next)) ||
    (TRIGGERS_BEFORE_T.has(word) && next === 't')
  );
}

/** «nada de x»: block words that govern a weak alias only through «de». */
const DE_ONLY_ANCHORS: ReadonlySet<string> = new Set(['nada']);

/**
 * True when `tokens[k]` is a block word that makes a weak alias right after it a target:
 * «no x», «sin max», «nada de x», but not «nada x hoy» (there «x» is «por»).
 */
export function anchorsWeakAt(tokens: readonly Token[], k: number): boolean {
  if (!isTriggerAt(tokens, k)) return false;
  const next = nextNorm(tokens, k + 1);
  return !DE_ONLY_ANCHORS.has(tokens[k]?.norm ?? '') || isDe(next) || next === 'del';
}

/**
 * True when a block word comes right before `tokens[k]`, maybe through a few bridge words
 * («no veo x», «no me dejes entrar en…»). Punctuation stops the search. `isTrigger`
 * defaults to `anchorsWeakAt`.
 */
export function followsTrigger(
  tokens: readonly Token[],
  k: number,
  isTrigger: (j: number) => boolean = (j) => anchorsWeakAt(tokens, j),
): boolean {
  let bridged = 0;
  for (let j = k - 1; j >= 0; j -= 1) {
    if (tokens[j + 1]?.breakBefore) return false;
    if (isTrigger(j)) return true;
    if (!TRIGGER_BRIDGE.has(tokens[j]?.norm ?? '') || bridged >= MAX_BRIDGE) return false;
    bridged += 1;
  }
  return false;
}

/** The target that `tokens[start, start + n)` names exactly, with no punctuation inside. */
function aliasSpan(tokens: readonly Token[], start: number, n: number): TargetRef | undefined {
  if (start < 0 || start + n > tokens.length) return undefined;
  const slice = tokens.slice(start, start + n);
  if (slice.some((token, k) => (k > 0 && token.breakBefore) || token.type === 'domain')) {
    return undefined;
  }
  return lookupAlias(slice.map((token) => token.text).join(' '));
}

/**
 * True when a catalog or parser alias of at least `minWords` words, or a typed domain,
 * ends right before `tokens[end]`.
 */
export function aliasEndsAt(tokens: readonly Token[], end: number, minWords = 1): boolean {
  if (minWords <= 1 && tokens[end - 1]?.type === 'domain') return true;
  for (let n = minWords; n <= MAX_NGRAM; n += 1) if (aliasSpan(tokens, end - n, n)) return true;
  return false;
}

/** True when a strong alias (not a common word such as «x» or «video») starts at `start`. */
export function strongAliasStartsAt(tokens: readonly Token[], start: number): boolean {
  for (let n = MAX_NGRAM; n >= 1; n -= 1) {
    if (!aliasSpan(tokens, start, n)) continue;
    const text = tokens
      .slice(start, start + n)
      .map((token) => token.text)
      .join(' ');
    return !isWeakAliasKey(aliasKey(text));
  }
  return false;
}

function isKnownWord(word: string): boolean {
  return (
    isFiller(word) ||
    TRIGGERS.has(word) ||
    TRIGGERS_BEFORE_DE.has(word) ||
    TRIGGERS_BEFORE_T.has(word) ||
    OTHER_KNOWN.has(word) ||
    NUMBER_WORDS.has(word) ||
    UNIT_WORDS.has(word) ||
    STUDY_VERBS.has(word) ||
    STUDY_NOUNS.has(word) ||
    STUDY_NOUNS_AFTER_HACER.has(word) ||
    STUDY_NOUN_VERBS.has(word) ||
    DESIRE.has(word) ||
    DESIRE_BEFORE_TARGET.has(word) ||
    CONSUME.has(word)
  );
}

function usable(
  tokens: readonly Token[],
  free: readonly boolean[],
  k: number,
  first: boolean,
): boolean {
  const token = tokens[k];
  if (!token || !free[k]) return false;
  if (!first && token.breakBefore) return false;
  switch (token.type) {
    case 'domain':
      return false;
    case 'plus':
      // A «+» continues an alias («Disney+») but never starts one.
      return !first;
    case 'num':
      return !/[.,:]/.test(token.norm);
    default:
      return true;
  }
}

function exactAt(tokens: readonly Token[], free: readonly boolean[], i: number): Candidate | null {
  for (let n = Math.min(MAX_NGRAM, tokens.length - i); n >= 1; n -= 1) {
    let ok = true;
    for (let k = i; k < i + n && ok; k += 1) ok = usable(tokens, free, k, k === i);
    if (!ok) continue;
    const slice = tokens.slice(i, i + n);
    if (n > 1) {
      const first = slice[0]?.norm ?? '';
      const last = slice[n - 1]?.norm ?? '';
      if (LIST_CONNECTORS.has(first) || LIST_CONNECTORS.has(last)) continue;
    }
    const text = slice.map((token) => token.text).join(' ');
    const ref = lookupAlias(text);
    if (ref) {
      const key = aliasKey(text);
      return { hit: { ...ref, start: i, end: i + n }, weak: isWeakAliasKey(key), key };
    }
  }
  return null;
}

function fuzzyWord(tokens: readonly Token[], free: readonly boolean[], k: number): boolean {
  const token = tokens[k];
  return !!token && !!free[k] && token.type === 'word' && !isKnownWord(token.norm);
}

function fuzzyAt(tokens: readonly Token[], free: readonly boolean[], i: number): Candidate | null {
  if (!fuzzyWord(tokens, free, i)) return null;
  const first = tokens[i]?.norm ?? '';
  const second = tokens[i + 1];
  const candidate = (key: string, end: number, ref: TargetRef): Candidate => ({
    hit: { ...ref, start: i, end },
    weak: key.length <= MAX_WEAK_FUZZY_LENGTH,
    key,
  });
  if (second && !second.breakBefore && fuzzyWord(tokens, free, i + 1)) {
    const key = first + second.norm;
    const ref = fuzzyLookup(key);
    if (ref) return candidate(key, i + 2, ref);
  }
  const ref = fuzzyLookup(first);
  return ref ? candidate(first, i + 1, ref) : null;
}

/** Category aliases that are verbs: «no juego lol» is the game, not the category too. */
const VERB_CATEGORY_WORDS: ReadonlySet<string> = new Set(['jugar', 'juego', 'comprar', 'chatear']);

/**
 * A category word followed by «de/en/a» and a service only describes that service; a
 * category verb («juego», «comprar») needs no link word («no juego lol»).
 */
function isDescriptor(
  tokens: readonly Token[],
  hit: TargetHit,
  next: TargetHit | undefined,
): boolean {
  if (hit.kind !== 'category' || next?.kind !== 'service') return false;
  let link = hit.end - hit.start === 1 && VERB_CATEGORY_WORDS.has(tokens[hit.start]?.norm ?? '');
  for (let k = hit.end; k < next.start; k += 1) {
    const token = tokens[k];
    if (!token || token.breakBefore) return false;
    if (DESCRIPTOR_LINKS.has(token.norm)) link = true;
    else if (!DESCRIPTOR_FILLERS.has(token.norm)) return false;
  }
  return link;
}

/** Tokens covered by `NON_TARGET_PHRASES`. */
function nonTargetMask(tokens: readonly Token[]): boolean[] {
  const mask = tokens.map(() => false);
  for (let i = 0; i < tokens.length; i += 1) {
    for (const phrase of NON_TARGET_PHRASES) {
      const matches = phrase.every(
        (word, n) => tokens[i + n]?.norm === word && (n === 0 || !tokens[i + n]?.breakBefore),
      );
      if (matches) for (let n = 0; n < phrase.length; n += 1) mask[i + n] = true;
    }
  }
  return mask;
}

/**
 * Whether a weak alias is in a place where it can only be a target. It must sit:
 * - right after a block word, maybe through bridge words («no veo x», «sin el mine»);
 * - right after a list connector that follows a target («twitch y kick»), or before one
 *   that precedes a target («lol y fortnite»);
 * - right after another target, or after a comma that follows one («tiktok, x»).
 * Interjection-like aliases («lol», «ea», «wa», «abc») need a block word or a word
 * connector; «lol» also counts after «al», «a», «jugar»… but not through bridge words
 * («no sé lol»).
 */
function isAnchored(
  tokens: readonly Token[],
  candidate: Candidate,
  triggers: readonly boolean[],
  trustedEnd: (k: number) => boolean,
  trustedStart: (k: number) => boolean,
): boolean {
  const { start, end } = candidate.hit;
  const lol = candidate.key === 'lol';
  const interjection = INTERJECTION_KEYS.has(candidate.key);

  // Forward: «lol y fortnite», «steam, epic» (not for interjections).
  const after = tokens[end];
  if (after && !after.breakBefore && LIST_CONNECTORS.has(after.norm)) {
    let m = end + 1;
    while (tokens[m] && !tokens[m]?.breakBefore && ARTICLES.has(tokens[m]?.norm ?? '')) m += 1;
    if (tokens[m] && !tokens[m]?.breakBefore && trustedStart(m)) return true;
  } else if (after?.breakBefore && !interjection && trustedStart(end)) {
    return true;
  }

  // Backward, skipping articles.
  let k = start - 1;
  while (k >= 0 && !tokens[k + 1]?.breakBefore && !triggers[k]) {
    if (!ARTICLES.has(tokens[k]?.norm ?? '')) break;
    k -= 1;
  }
  if (k < 0) return false;
  if (tokens[k + 1]?.breakBefore) return !interjection && trustedEnd(k + 1);
  if (triggers[k]) return true;
  const word = tokens[k]?.norm ?? '';
  if (LIST_CONNECTORS.has(word)) return !tokens[k]?.breakBefore && trustedEnd(k);
  if (lol) return LOL_LEADS.has(word);
  if (trustedEnd(k + 1)) return !interjection;
  return followsTrigger(tokens, start, (j) => !!triggers[j]);
}

export interface TargetScan {
  /** Accepted targets in text order (duplicates included). */
  readonly hits: TargetHit[];
  /** The phrase has a block word («no», «sin», «bloquea»…) outside `excluded`. */
  readonly hasTrigger: boolean;
}

/**
 * Finds block words and targets among the tokens not yet `used` nor `excluded`, marking
 * what it consumes. `preset` are targets found by earlier passes (e.g. «20 minutos» read
 * as the newspaper). Weak aliases («x», «max», «lol», «video»…) count only where they can
 * only be a target (see `isAnchored`); having a block word somewhere else in the phrase is
 * not enough.
 */
export function scanTargets(
  tokens: readonly Token[],
  used: boolean[],
  preset: readonly TargetHit[],
  excluded: readonly boolean[] = [],
): TargetScan {
  const nonTarget = nonTargetMask(tokens);

  // Block words that can anchor a weak alias (see `anchorsWeakAt`).
  const triggers: boolean[] = tokens.map(() => false);
  let hasTrigger = false;
  for (let k = 0; k < tokens.length; k += 1) {
    if (!used[k] && !excluded[k] && isTriggerAt(tokens, k)) {
      used[k] = true;
      triggers[k] = anchorsWeakAt(tokens, k);
      hasTrigger = true;
    }
  }

  const candidates: Candidate[] = preset.map((hit) => ({ hit, weak: false, key: '' }));
  // Tokens a new candidate may use.
  const open = tokens.map((_, k) => !used[k] && !excluded[k] && !nonTarget[k]);
  const mark = (candidate: Candidate, value: boolean): void => {
    for (let k = candidate.hit.start; k < candidate.hit.end; k += 1) {
      used[k] = value;
      open[k] = false;
    }
  };
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (!token || !open[i]) {
      i += 1;
      continue;
    }
    const candidate: Candidate | null =
      token.type === 'domain'
        ? { hit: { kind: 'domain', id: token.norm, start: i, end: i + 1 }, weak: false, key: '' }
        : exactAt(tokens, open, i);
    if (candidate) {
      candidates.push(candidate);
      mark(candidate, true);
      i = candidate.hit.end;
    } else {
      i += 1;
    }
  }
  for (let i = 0; i < tokens.length;) {
    const candidate = fuzzyAt(tokens, open, i);
    if (candidate) {
      candidates.push(candidate);
      mark(candidate, true);
      i = candidate.hit.end;
    } else {
      i += 1;
    }
  }
  candidates.sort((a, b) => a.hit.start - b.hit.start);

  // Weak candidates are trusted one by one, as their neighbours get trusted.
  const trusted = candidates.map((candidate) => !candidate.weak);
  const trustedEnd = (k: number): boolean =>
    candidates.some((candidate, index) => trusted[index] && candidate.hit.end === k);
  const trustedStart = (k: number): boolean =>
    candidates.some((candidate, index) => trusted[index] && candidate.hit.start === k);
  for (let changed = true; changed;) {
    changed = false;
    candidates.forEach((candidate, index) => {
      if (trusted[index]) return;
      if (isAnchored(tokens, candidate, triggers, trustedEnd, trustedStart)) {
        trusted[index] = true;
        changed = true;
      }
    });
  }

  const kept: TargetHit[] = [];
  candidates.forEach((candidate, index) => {
    if (trusted[index]) kept.push(candidate.hit);
    else mark(candidate, false);
  });
  const hits = kept.filter((hit, index) => !isDescriptor(tokens, hit, kept[index + 1]));
  return { hits, hasTrigger };
}
