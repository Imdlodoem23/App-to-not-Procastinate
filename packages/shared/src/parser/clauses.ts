import {
  aliasEndsAt,
  followsTrigger,
  isTriggerAt,
  LIST_CONNECTORS,
  NEGATIVE_CONNECTORS,
} from './targets';
import { nextNorm, type Token } from './text';
import { isFiller } from './vocabulary';

/** Token range [start, end) of a time expression already read. */
export interface TimeSpan {
  readonly start: number;
  readonly end: number;
}

/** «x favor», «x fa»: «por favor». */
const POLITE_AFTER_X: ReadonlySet<string> = new Set(['fa', 'fav', 'favor', 'fi', 'fis']);
/** After these, «x» is «por»: «tiktok x hoy», «insta x q…», «youtube x la tarde». */
const POR_AFTER_X: ReadonlySet<string> = new Set([
  'hoy',
  'ahora',
  'q',
  'que',
  'k',
  'el',
  'la',
  'los',
  'las',
  'lo',
  'mi',
  'mis',
  'un',
  'una',
  'unos',
  'unas',
  'esta',
  'este',
  'estos',
  'estas',
  'aqui',
]);

/**
 * Qualifiers typed after a duration: «2h máx», «1 hora más o menos», «una hora entera»,
 * «2 hours max», «an hour or so», «1 hour straight».
 */
const AFTER_QUALIFIERS: ReadonlyArray<readonly string[]> = [
  ['mas', 'o', 'menos'],
  ['o', 'por', 'ahi'],
  ['o', 'asi'],
  ['como', 'maximo'],
  ['como', 'max'],
  ['como', 'mucho'],
  ['como', 'minimo'],
  ['maximo'],
  ['max'],
  ['minimo'],
  ['aprox'],
  ['aproximadamente'],
  ['entera'],
  ['enteras'],
  ['entero'],
  ['enteros'],
  ['seguida'],
  ['seguidas'],
  ['seguido'],
  ['seguidos'],
  ['more', 'or', 'less'],
  ['or', 'so'],
  ['or', 'something'],
  ['at', 'most'],
  ['at', 'least'],
  ['in', 'a', 'row'],
  ['in', 'total'],
  ['tops'],
  ['total'],
  ['maximum'],
  ['minimum'],
  ['straight'],
  ['ish'],
];

/**
 * Qualifiers typed before a duration: «máx. 2h», «como máximo 1 hora», «al menos 1h», «at
 * least 1h», «up to 2 hours».
 */
const BEFORE_QUALIFIERS: ReadonlyArray<readonly string[]> = [
  ['mas', 'o', 'menos'],
  ['por', 'lo', 'menos'],
  ['al', 'menos'],
  ['como', 'maximo'],
  ['como', 'max'],
  ['como', 'mucho'],
  ['como', 'minimo'],
  ['maximo'],
  ['max'],
  ['minimo'],
  ['at', 'most'],
  ['at', 'least'],
  ['up', 'to'],
  ['maximum'],
  ['minimum'],
];

/**
 * «máx» is HBO Max (and «x» is X), not «máximo» («por»), when it ends a longer alias («HBO
 * Max», «Twitter X») or when the words `tokens[first…last]` come right after a block word
 * or a list connector («sin max 2h», «ni x»).
 */
function isServiceSlot(tokens: readonly Token[], first: number, last = first): boolean {
  if (aliasEndsAt(tokens, last + 1, 2) || followsTrigger(tokens, first)) return true;
  const previous = tokens[first - 1];
  return !!previous && !tokens[first]?.breakBefore && LIST_CONNECTORS.has(previous.norm);
}

/** True when `tokens[start…]` spell `phrase`, all unread, with no punctuation inside. */
function phraseAt(
  tokens: readonly Token[],
  used: readonly boolean[],
  start: number,
  phrase: readonly string[],
): boolean {
  if (start < 0) return false;
  return phrase.every((word, n) => {
    const token = tokens[start + n];
    return !!token && !used[start + n] && token.norm === word && (n === 0 || !token.breakBefore);
  });
}

function markRange(used: boolean[], start: number, end: number): void {
  for (let k = start; k < end; k += 1) used[k] = true;
}

/**
 * Marks as read the words that only qualify a time expression or stand for «por», so they
 * are neither targets nor `unparsed`:
 * - «2h máx», «máx. 2h», «como máximo 1 hora», «1 hora más o menos», «1h o así», «una hora
 *   entera», «2 horas seguidas», «al menos 1h». «máx» stays HBO Max in «HBO Max 2h» and
 *   right after a block word or a list connector («sin max 2h», «ni max»).
 * - «x favor», «x fa»: «por favor».
 * - «tiktok x 1 hora», «insta x hoy», «youtube x q…»: «x» is «por», not X (Twitter), when it
 *   follows a word that is neither a block word nor a list connector. «no veo x 1h», «ni
 *   x» and «tiktok, x» are X.
 */
export function markQualifiers(
  tokens: readonly Token[],
  used: boolean[],
  times: readonly TimeSpan[],
): void {
  const timeStarts = new Set(times.map((time) => time.start));
  for (const time of times) {
    let j = time.end;
    for (let round = 0; round < 2; round += 1) {
      if (tokens[j]?.breakBefore) break;
      const phrase = AFTER_QUALIFIERS.find((words) => phraseAt(tokens, used, j, words));
      if (!phrase) break;
      markRange(used, j, j + phrase.length);
      j += phrase.length;
    }
    // The time may follow a period: «máx. 2h».
    for (const phrase of BEFORE_QUALIFIERS) {
      const start = time.start - phrase.length;
      if (!phraseAt(tokens, used, start, phrase)) continue;
      const max = phrase.indexOf('max');
      if (max >= 0 && isServiceSlot(tokens, start, start + max)) continue;
      markRange(used, start, time.start);
      break;
    }
  }

  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (!token || used[k] || token.type !== 'word' || token.norm !== 'x') continue;
    const next = tokens[k + 1];
    const nextWord = next && !next.breakBefore ? next.norm : '';
    if (POLITE_AFTER_X.has(nextWord) && !used[k + 1]) {
      markRange(used, k, k + 2);
      continue;
    }
    // A phrase-initial «x 1h» stays unread; «tiktok, x 1h» is a list, so «x» is X.
    if (k === 0 || token.breakBefore || isServiceSlot(tokens, k)) continue;
    if (POR_AFTER_X.has(nextWord) || (timeStarts.has(k + 1) && !next?.breakBefore)) used[k] = true;
  }
}

/**
 * «bloquea todo menos WhatsApp», «sin redes excepto WhatsApp», «salvo», «quitando», «block
 * everything except WhatsApp», «excluding», «besides».
 */
const EXCEPTION_MARKERS: ReadonlySet<string> = new Set([
  'menos',
  'excepto',
  'exceptuando',
  'salvo',
  'quitando',
  'except',
  'excluding',
  'besides',
]);
/** Two-word English markers: «apart from WhatsApp», «other than WhatsApp». */
const EXCEPTION_PAIRS: ReadonlyMap<string, string> = new Map([
  ['apart', 'from'],
  ['other', 'than'],
]);
/** «but not WhatsApp», «but let me use WhatsApp», «but leave WhatsApp», «but keep…». */
const LEAVE_AFTER_BUT: ReadonlySet<string> = new Set(['not', 'let', 'leave', 'keep', 'allow']);
/** «everything but WhatsApp», «all but WhatsApp». */
const ALL_BEFORE_BUT: ReadonlySet<string> = new Set(['all', 'everything', 'anything']);
/** «pero déjame WhatsApp», «pero deja el WhatsApp». */
const LEAVE_AFTER_PERO: ReadonlySet<string> = new Set([
  'deja',
  'dejame',
  'dejeme',
  'dejes',
  'dejas',
  'dejanos',
]);
/**
 * «estudiar 1h y después YouTube», «sin redes 1h, luego ya veremos», «study 1h and then
 * YouTube», «block Instagram and later TikTok».
 */
const LATER: ReadonlySet<string> = new Set([
  'luego',
  'despues',
  'then',
  'later',
  'afterwards',
  'after',
]);
/** «y», «e», «and» before a later plan: part of it. */
const LATER_JOINERS: ReadonlySet<string> = new Set(['y', 'e', 'and']);

/**
 * Where an exception marker at `tokens[k]` ends («menos», «pero déjame», «but not», «apart
 * from», «everything but», «…, not WhatsApp»), or -1 when there is none. `content` says
 * whether something meaningful came before it.
 */
function exceptionMarkerEnd(tokens: readonly Token[], k: number, content: boolean): number {
  const token = tokens[k];
  if (!token) return -1;
  const word = token.norm;
  const next = nextNorm(tokens, k + 1);
  if (EXCEPTION_MARKERS.has(word)) return next === 'for' && word === 'except' ? k + 2 : k + 1;
  if (word === 'pero' && LEAVE_AFTER_PERO.has(next)) return k + 1;
  if (EXCEPTION_PAIRS.get(word) === next) return k + 2;
  if (word === 'but') {
    if (LEAVE_AFTER_BUT.has(next)) return k + 2;
    const previous = tokens[k - 1];
    if (previous && !token.breakBefore && ALL_BEFORE_BUT.has(previous.norm)) return k + 1;
  }
  // «block social media, not WhatsApp».
  if (word === 'not' && token.breakBefore && content) return k + 1;
  return -1;
}

/**
 * Tokens that must never become targets or a study task, as a mask over `tokens`. They
 * stay unread, so they end up in `unparsed` and the result is never complete:
 * - an exception, from its marker to punctuation or the next block word other than «ni» or
 *   «nor»: «bloquea todo menos WhatsApp», «sin redes excepto WhatsApp 1h», «pero déjame
 *   WhatsApp», «block everything except WhatsApp», «no social media but not WhatsApp».
 * - a later plan, from «(y) luego/después», «(and) then/later/after» to punctuation, when
 *   something came before it: «estudiar 1h y después YouTube», «study 1h and then YouTube».
 *   A phrase that starts with «después de cenar…» or «after dinner…» is left alone.
 * Words already read (times, qualifiers) end both.
 */
export function findExcluded(tokens: readonly Token[], used: readonly boolean[]): boolean[] {
  const excluded = tokens.map(() => false);
  let content = false;
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (!token) break;
    if (used[k]) {
      content = true;
      continue;
    }
    const word = token.norm;
    let start = -1;
    let later = false;
    const markerEnd = exceptionMarkerEnd(tokens, k, content);
    if (markerEnd > k) {
      start = k;
    } else if (LATER.has(word) && content) {
      later = true;
      const previous = tokens[k - 1];
      const joined =
        previous && !token.breakBefore && !used[k - 1] && LATER_JOINERS.has(previous.norm);
      start = joined ? k - 1 : k;
    }
    if (start < 0) {
      if (!isFiller(word)) content = true;
      continue;
    }
    let j = start;
    for (; j < tokens.length; j += 1) {
      if (j > start && tokens[j]?.breakBefore) break;
      if (used[j]) break;
      const trigger = isTriggerAt(tokens, j) && !NEGATIVE_CONNECTORS.has(tokens[j]?.norm ?? '');
      if (!later && j >= markerEnd && trigger) break;
      excluded[j] = true;
    }
    k = j - 1;
  }
  return excluded;
}
