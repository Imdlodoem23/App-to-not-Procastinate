import type { IsoWeekday } from '../domain';
import { lookupAlias } from './aliases';
import { matchDuration } from './duration';
import { aliasEndsAt } from './targets';
import { nextNorm, type Token } from './text';

/**
 * Daily limits in natural language: «YouTube máximo 30 minutos al día», «limita Instagram a
 * 1 h al día», «redes sociales 1 hora al día entre semana», «limit YouTube to 30 min a
 * day», «social media 1 hour a day on weekdays». A daily limit needs a duration tied to a
 * «per day» marker; «YouTube 30 min» is still a block.
 */

/**
 * Token range [start, end) of a daily allowance: the duration and its «per day» words, or
 * only the duration when the targets sit in between («30 min de YouTube al día»); then
 * `marker` is the range of the «per day» words.
 */
export interface DailyMatch {
  readonly start: number;
  readonly end: number;
  readonly minutes: number;
  readonly marker?: { readonly start: number; readonly end: number };
}

/** Token range [start, end) of a days phrase («entre semana», «on weekends»). */
export interface DaysMatch {
  readonly start: number;
  readonly end: number;
  /** Sorted, unique. */
  readonly days: IsoWeekday[];
}

type Phrase = readonly string[];

/**
 * «per day» after a duration: «30 min al día», «1 h diaria», «45 min cada día», «30 min a
 * day», «1h per day», «an hour daily», «30 min/día».
 */
const PER_DAY_AFTER: readonly Phrase[] = [
  ['todos', 'los', 'dias'],
  ['por', 'cada', 'dia'],
  ['al', 'dia'],
  ['por', 'dia'],
  ['x', 'dia'],
  ['cada', 'dia'],
  ['a', 'diario'],
  ['diario'],
  ['diarios'],
  ['diaria'],
  ['diarias'],
  ['diariamente'],
  ['every', 'single', 'day'],
  ['per', 'day'],
  ['a', 'day'],
  ['each', 'day'],
  ['every', 'day'],
  ['everyday'],
  ['daily'],
];

/**
 * «per day» before a duration: «límite diario de 30 min», «al día, máximo 1 h», «daily
 * limit of 30 min», «every day 1 hour».
 */
const PER_DAY_BEFORE: readonly Phrase[] = [
  ['limite', 'diario'],
  ['maximo', 'diario'],
  ['tope', 'diario'],
  ['todos', 'los', 'dias'],
  ['al', 'dia'],
  ['por', 'dia'],
  ['cada', 'dia'],
  ['a', 'diario'],
  ['diariamente'],
  ['daily', 'limit'],
  ['daily', 'max'],
  ['daily', 'maximum'],
  ['daily', 'cap'],
  ['daily', 'allowance'],
  ['per', 'day'],
  ['each', 'day'],
  ['every', 'day'],
  ['everyday'],
  ['daily'],
];

/** Words after «al día» that make it something else: «al día siguiente». */
const NOT_PER_DAY_AFTER: ReadonlySet<string> = new Set([
  'siguiente',
  'sig',
  'entero',
  'completo',
  'antes',
  'despues',
  'or',
  'off',
  'ago',
  'later',
  'before',
  'after',
  'earlier',
  'long',
]);

/**
 * Qualifiers allowed inside a daily allowance: «30 min como máximo al día», «límite diario
 * de hasta 1 h», «1h max per day», «daily limit of up to 30 min». Qualifiers around it are
 * read by `markQualifiers`.
 */
const INNER_QUALIFIERS: readonly Phrase[] = [
  ['como', 'maximo'],
  ['como', 'max'],
  ['como', 'mucho'],
  ['en', 'total'],
  ['maximo'],
  ['max'],
  ['hasta'],
  ['at', 'most'],
  ['up', 'to'],
  ['in', 'total'],
  ['maximum'],
  ['tops'],
  ['total'],
];

/** «límite diario de 30 min», «daily limit of 30 min». */
const LINKS: ReadonlySet<string> = new Set(['de', 'of', 'del']);

/**
 * Words that introduce the targets between a duration and its «per day»: «45 min de
 * TikTok cada día», «1 h en Instagram al día», «30 min of YouTube a day».
 */
const GAP_LINKS: ReadonlySet<string> = new Set([
  'de',
  'del',
  'd',
  'en',
  'con',
  'para',
  'of',
  'on',
  'for',
  'with',
  'in',
]);
/** At most this many words between the duration and its «per day» (link included). */
const MAX_GAP = 6;

/** Length of `phrase` when `tokens[k…]` spell it with no punctuation inside, else 0. */
function phraseLength(tokens: readonly Token[], k: number, phrase: Phrase): number {
  for (let n = 0; n < phrase.length; n += 1) {
    const token = tokens[k + n];
    if (!token || token.norm !== phrase[n] || (n > 0 && token.breakBefore)) return 0;
  }
  return phrase.length;
}

function longestPhrase(tokens: readonly Token[], k: number, phrases: readonly Phrase[]): number {
  let best = 0;
  for (const phrase of phrases) best = Math.max(best, phraseLength(tokens, k, phrase));
  return best;
}

/**
 * True when `tokens[k]` continues the expression: no punctuation before it, or only a «/»
 * («30 min/día», «1h/day»).
 */
function continues(text: string, tokens: readonly Token[], k: number): boolean {
  const token = tokens[k];
  const previous = tokens[k - 1];
  if (!token || !previous) return false;
  return !token.breakBefore || text.slice(previous.end, token.start).trim() === '/';
}

/**
 * Index after the qualifiers at `tokens[k]` (at most two, with no punctuation before
 * them), or `k`. «max» that ends an alias («HBO Max») is not a qualifier.
 */
function skipQualifiers(tokens: readonly Token[], k: number): number {
  let j = k;
  for (let round = 0; round < 2; round += 1) {
    if (tokens[j]?.breakBefore) break;
    const n = longestPhrase(tokens, j, INNER_QUALIFIERS);
    if (n === 0) break;
    if (tokens[j + n - 1]?.norm === 'max' && aliasEndsAt(tokens, j + n, 2)) break;
    j += n;
  }
  return j;
}

/** Index after a «per day» marker that starts at `tokens[k]`, or -1. */
function perDayAfter(text: string, tokens: readonly Token[], k: number): number {
  if (!continues(text, tokens, k)) return -1;
  // «30 min/día»: the slash makes `dia` a break, which the phrase check would refuse.
  const n =
    tokens[k]?.breakBefore === true
      ? ['dia', 'day'].includes(tokens[k]?.norm ?? '')
        ? 1
        : 0
      : longestPhrase(tokens, k, PER_DAY_AFTER);
  if (n === 0) return -1;
  return NOT_PER_DAY_AFTER.has(nextNorm(tokens, k + n)) ? -1 : k + n;
}

/**
 * A «per day» a few words after `tokens[gap]` (the link word), with no punctuation in
 * between: «de TikTok cada día», «of YouTube and Reddit a day», «de YouTube como máximo al
 * día». Its range includes the qualifiers before it.
 */
function gapMarker(
  text: string,
  tokens: readonly Token[],
  gap: number,
): { start: number; end: number } | null {
  for (let k = gap + 2; k < gap + MAX_GAP && k < tokens.length; k += 1) {
    const q = skipQualifiers(tokens, k);
    const end = perDayAfter(text, tokens, q);
    if (end > 0 && (q === k || !tokens[k]?.breakBefore)) return { start: k, end };
    if (tokens[k]?.breakBefore) return null;
  }
  return null;
}

/**
 * A daily allowance starting at `tokens[i]`:
 * - a duration and then «per day», maybe with qualifiers in between: «30 minutos al día»,
 *   «1 h diaria», «30 min como máximo al día», «hasta 1 hora cada día», «30 min a day»,
 *   «an hour per day», «1h max daily», «30 min/día»;
 * - a duration, its targets and then «per day»: «45 min de TikTok cada día», «30 min of
 *   YouTube a day» (see `DailyMatch.marker`);
 * - «per day» and then a duration: «límite diario de 30 min», «al día máximo 1 h», «daily
 *   limit of 30 min», «every day 1 hour». Punctuation in between stops it («al día, 1 h»).
 * Qualifiers before or after it («máximo 30 min al día», «30 min al día como mucho») are
 * left to `markQualifiers`, except «hasta», which would otherwise read as an end time.
 */
export function matchDaily(text: string, tokens: readonly Token[], i: number): DailyMatch | null {
  // Duration first, maybe after «hasta» («hasta 1 hora al día»).
  const lead = tokens[i]?.norm === 'hasta' ? i + 1 : i;
  const duration = matchDuration(tokens, lead);
  if (duration && (lead === i || !tokens[lead]?.breakBefore)) {
    const k = skipQualifiers(tokens, duration.end);
    const end = perDayAfter(text, tokens, k);
    if (end > 0 && (k === duration.end || !tokens[k]?.breakBefore)) {
      return { start: i, end, minutes: duration.minutes };
    }
    const marker = GAP_LINKS.has(nextNorm(tokens, duration.end))
      ? gapMarker(text, tokens, duration.end)
      : null;
    if (marker) return { start: i, end: duration.end, minutes: duration.minutes, marker };
  }
  // «per day» first.
  const n = longestPhrase(tokens, i, PER_DAY_BEFORE);
  if (n === 0) return null;
  let k = i + n;
  if (NOT_PER_DAY_AFTER.has(nextNorm(tokens, k))) return null;
  if (LINKS.has(nextNorm(tokens, k))) k += 1;
  const q = skipQualifiers(tokens, k);
  if (tokens[k]?.breakBefore || (q > k && tokens[q]?.breakBefore)) return null;
  const after = matchDuration(tokens, q);
  if (!after) return null;
  // «daily limit of 30 min per day»: one marker is enough, the second one is read too.
  const k2 = skipQualifiers(tokens, after.end);
  const again = perDayAfter(text, tokens, k2);
  const end = again > 0 && (k2 === after.end || !tokens[k2]?.breakBefore) ? again : after.end;
  return { start: i, end, minutes: after.minutes };
}

// ---------------------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------------------

const WEEKDAYS_PHRASES: readonly Phrase[] = [
  ['dias', 'entre', 'semana'],
  ['entre', 'semana'],
  ['dias', 'laborables'],
  ['dias', 'laborales'],
  ['laborables'],
  ['dias', 'de', 'cole'],
  ['dias', 'de', 'clase'],
  ['weekdays'],
  ['weekday'],
  ['week', 'days'],
  ['workdays'],
  ['work', 'days'],
  ['working', 'days'],
  ['school', 'days'],
  ['durante', 'la', 'semana'],
  ['during', 'the', 'week'],
];
const WEEKEND_PHRASES: readonly Phrase[] = [
  ['fines', 'de', 'semana'],
  ['fin', 'de', 'semana'],
  ['findes'],
  ['finde'],
  ['weekends'],
  ['weekend'],
  ['week', 'ends'],
];

/** Full weekday names, Spanish and English, singular and plural. */
const DAY_NAMES: ReadonlyMap<string, IsoWeekday> = new Map([
  ['lunes', 1],
  ['martes', 2],
  ['miercoles', 3],
  ['jueves', 4],
  ['viernes', 5],
  ['sabado', 6],
  ['sabados', 6],
  ['domingo', 7],
  ['domingos', 7],
  ['monday', 1],
  ['mondays', 1],
  ['tuesday', 2],
  ['tuesdays', 2],
  ['wednesday', 3],
  ['wednesdays', 3],
  ['thursday', 4],
  ['thursdays', 4],
  ['friday', 5],
  ['fridays', 5],
  ['saturday', 6],
  ['saturdays', 6],
  ['sunday', 7],
  ['sundays', 7],
]);
/**
 * Short names, only inside a range or a list of days («lun-vie», «mon-fri», «sat and
 * sun»): alone, «mar», «sun» or «wed» are other words.
 */
const SHORT_DAY_NAMES: ReadonlyMap<string, IsoWeekday> = new Map([
  ['lun', 1],
  ['mar', 2],
  ['mie', 3],
  ['jue', 4],
  ['vie', 5],
  ['sab', 6],
  ['dom', 7],
  ['mon', 1],
  ['tue', 2],
  ['tues', 2],
  ['wed', 3],
  ['thu', 4],
  ['thur', 4],
  ['thurs', 4],
  ['fri', 5],
  ['sat', 6],
  ['sun', 7],
]);

/** Words before a days phrase: «solo entre semana», «los fines de semana», «on weekdays». */
const DAYS_LEADS: ReadonlySet<string> = new Set([
  'solo',
  'solamente',
  'unicamente',
  'en',
  'durante',
  'los',
  'las',
  'el',
  'la',
  'todos',
  'cada',
  'only',
  'just',
  'on',
  'at',
  'during',
  'over',
  'the',
  'every',
  'each',
  'all',
]);
const MAX_DAYS_LEADS = 3;
/** «de lunes a viernes», «from Monday to Friday». */
const RANGE_FROM: ReadonlySet<string> = new Set(['de', 'desde', 'from']);
const RANGE_TO: ReadonlySet<string> = new Set([
  'a',
  'al',
  'hasta',
  'to',
  'through',
  'thru',
  'till',
  'until',
]);
/** Joins days in a list: «lunes y miércoles», «Monday and Wednesday». */
const DAY_JOINERS: ReadonlySet<string> = new Set(['y', 'e', 'and']);
/** Articles allowed before a day inside a list or a range: «el lunes y el martes». */
const DAY_ARTICLES: ReadonlySet<string> = new Set(['el', 'los', 'la', 'las', 'on', 'the']);

const range = (from: number, to: number): IsoWeekday[] =>
  Array.from({ length: to - from + 1 }, (_, n) => (from + n) as IsoWeekday);

function dayAt(tokens: readonly Token[], k: number, short: boolean): IsoWeekday | undefined {
  const token = tokens[k];
  if (!token || token.type !== 'word') return undefined;
  return DAY_NAMES.get(token.norm) ?? (short ? SHORT_DAY_NAMES.get(token.norm) : undefined);
}

/** Days from `from` to `to`, wrapping past Sunday («viernes a lunes»). */
function dayRange(from: IsoWeekday, to: IsoWeekday): IsoWeekday[] {
  const days: IsoWeekday[] = [];
  for (let day: number = from; ; day = (day % 7) + 1) {
    days.push(day as IsoWeekday);
    if (day === to) return days;
  }
}

interface DayItem {
  readonly end: number;
  readonly days: IsoWeekday[];
  /** A range or a full name: an item that stands on its own. */
  readonly strong: boolean;
}

/** One day or one range of days at `tokens[k]` («lunes», «lunes a viernes», «mon-fri»). */
function dayItem(text: string, tokens: readonly Token[], k: number): DayItem | null {
  let start = k;
  if (RANGE_FROM.has(tokens[start]?.norm ?? '') && dayAt(tokens, start + 1, true)) start += 1;
  const first = dayAt(tokens, start, true);
  if (first === undefined) return null;
  const joiner = tokens[start + 1];
  const hyphen =
    !!joiner &&
    !joiner.breakBefore &&
    text.slice(tokens[start]?.end ?? 0, joiner.start).trim() === '-';
  let to = -1;
  if (hyphen) to = start + 1;
  else if (RANGE_TO.has(nextNorm(tokens, start + 1))) {
    to = start + 2;
    if (DAY_ARTICLES.has(nextNorm(tokens, to))) to += 1;
  }
  const last = to > 0 && !tokens[to]?.breakBefore ? dayAt(tokens, to, true) : undefined;
  if (last !== undefined) return { end: to + 1, days: dayRange(first, last), strong: true };
  // «de lunes» without «a viernes» is not a range.
  if (start > k) return null;
  return { end: start + 1, days: [first], strong: DAY_NAMES.has(tokens[start]?.norm ?? '') };
}

/**
 * The days at `tokens[k]` («entre semana», «fines de semana», «lunes, miércoles y viernes»,
 * «de lunes a viernes», «weekdays», «Monday to Friday», «mon-fri»), leading words not
 * included.
 */
function daysCore(
  text: string,
  tokens: readonly Token[],
  k: number,
): { end: number; days: IsoWeekday[] } | null {
  const weekdays = longestPhrase(tokens, k, WEEKDAYS_PHRASES);
  if (weekdays > 0) return { end: k + weekdays, days: range(1, 5) };
  const weekend = longestPhrase(tokens, k, WEEKEND_PHRASES);
  if (weekend > 0) return { end: k + weekend, days: [6, 7] };
  const items: DayItem[] = [];
  let j = k;
  for (;;) {
    const item = dayItem(text, tokens, j);
    if (!item) break;
    items.push(item);
    // Next item: after a comma, «y» or «and», maybe with an article («y el viernes»).
    let next = item.end;
    const separator = tokens[next];
    if (!separator) break;
    if (separator.breakBefore) {
      if (text.slice(tokens[next - 1]?.end ?? 0, separator.start).trim() !== ',') break;
      if (DAY_JOINERS.has(separator.norm)) next += 1;
    } else if (DAY_JOINERS.has(separator.norm)) {
      next += 1;
    } else {
      break;
    }
    if (next > item.end && tokens[next]?.breakBefore) break;
    if (DAY_ARTICLES.has(tokens[next]?.norm ?? '') && dayAt(tokens, next + 1, true)) next += 1;
    const from = RANGE_FROM.has(tokens[next]?.norm ?? '') && dayAt(tokens, next + 1, true);
    if (dayAt(tokens, next, true) === undefined && !from) break;
    j = next;
  }
  if (items.length === 0) return null;
  // A lone short name («mar», «sun») is some other word.
  if (items.length === 1 && !items[0]?.strong) return null;
  const days = new Set<IsoWeekday>();
  for (const item of items) for (const day of item.days) days.add(day);
  const end = items[items.length - 1]?.end ?? k;
  return { end, days: [...days].sort((a, b) => a - b) };
}

/**
 * Finds days phrases among the tokens not yet `used`, marks them and returns them in text
 * order: «entre semana», «los fines de semana», «el finde», «de lunes a viernes», «solo los
 * lunes y los miércoles», «on weekdays», «at weekends», «Monday to Friday», «mon-fri».
 */
export function scanDays(text: string, tokens: readonly Token[], used: boolean[]): DaysMatch[] {
  const found: DaysMatch[] = [];
  const free = (k: number): boolean => k < tokens.length && !used[k];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!free(i)) continue;
    // Leading words, then the days themselves.
    let match: DaysMatch | null = null;
    for (let lead = 0; lead <= MAX_DAYS_LEADS && free(i + lead); lead += 1) {
      const k = i + lead;
      if (lead > 0 && tokens[k]?.breakBefore) break;
      const core = daysCore(text, tokens, k);
      if (core) {
        let clear = true;
        for (let m = k; m < core.end && clear; m += 1) clear = free(m);
        if (clear) match = { start: i, end: core.end, days: core.days };
        break;
      }
      if (!DAYS_LEADS.has(tokens[k]?.norm ?? '')) break;
    }
    if (!match) continue;
    for (let m = match.start; m < match.end; m += 1) used[m] = true;
    found.push(match);
    i = match.end - 1;
  }
  return found;
}

// ---------------------------------------------------------------------------------------
// Limit words
// ---------------------------------------------------------------------------------------

/**
 * Words that ask for a limit, read only when the phrase is a daily limit: «limita
 * Instagram a 1 h al día», «ponme un límite de…», «limit YouTube to 30 min a day», «cap
 * TikTok at 45 min a day». «no más de» is read by the block words and qualifiers.
 */
const LIMIT_WORDS: ReadonlySet<string> = new Set([
  'limita',
  'limitame',
  'limitar',
  'limitarme',
  'limitalo',
  'limitala',
  'limitalos',
  'limitalas',
  'limitemos',
  'limite',
  'limites',
  'limitado',
  'limitada',
  'limitados',
  'limitadas',
  'tope',
  'maximo',
  'maxima',
  'pon',
  'ponme',
  'ponle',
  'ponles',
  'establece',
  'permite',
  'permiteme',
  'deja',
  'dejame',
  'limit',
  'limits',
  'limited',
  'limiting',
  'cap',
  'capped',
  'max',
  'maximum',
  'allow',
  'allowed',
  'set',
  'give',
  'only',
  // «no more than 30 min a day», «less than 1 h a day».
  'than',
]);

/** Limit verbs, which anchor a weak alias after them like a block word: «limita X a…». */
const LIMIT_VERBS: ReadonlySet<string> = new Set([
  'limita',
  'limitame',
  'limitar',
  'limitarme',
  'limitalo',
  'limitala',
  'limitalos',
  'limitalas',
  'limitemos',
  'limit',
  'limits',
  'cap',
]);

/**
 * Marks the unread limit words as read and returns the limit verbs among them, as a mask
 * over `tokens` (for `scanTargets`' `anchors`). With `skipAliases`, words that are also
 * aliases («max», HBO Max) are left for the target scan.
 */
export function markLimitWords(
  tokens: readonly Token[],
  used: boolean[],
  excluded: readonly boolean[],
  skipAliases: boolean,
): boolean[] {
  return tokens.map((token, k) => {
    if (used[k] || excluded[k] || token.type !== 'word' || !LIMIT_WORDS.has(token.norm)) {
      return false;
    }
    if (skipAliases && lookupAlias(token.text) !== undefined) return false;
    used[k] = true;
    return LIMIT_VERBS.has(token.norm);
  });
}
