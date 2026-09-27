import { aliasEndsAt, followsTrigger, isTriggerAt, LIST_CONNECTORS } from './targets';
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

/** Qualifiers typed after a duration: «2h máx», «1 hora más o menos», «una hora entera». */
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
];

/** Qualifiers typed before a duration: «máx. 2h», «como máximo 1 hora», «al menos 1h». */
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

/** «bloquea todo menos WhatsApp», «sin redes excepto WhatsApp», «salvo», «quitando». */
const EXCEPTION_MARKERS: ReadonlySet<string> = new Set([
  'menos',
  'excepto',
  'exceptuando',
  'salvo',
  'quitando',
]);
/** «pero déjame WhatsApp», «pero deja el WhatsApp». */
const LEAVE_AFTER_PERO: ReadonlySet<string> = new Set([
  'deja',
  'dejame',
  'dejeme',
  'dejes',
  'dejas',
  'dejanos',
]);
/** «estudiar 1h y después YouTube», «sin redes 1h, luego ya veremos». */
const LATER: ReadonlySet<string> = new Set(['luego', 'despues']);

/**
 * Tokens that must never become targets or a study task, as a mask over `tokens`. They
 * stay unread, so they end up in `unparsed` and the result is never complete:
 * - an exception, from its marker to punctuation or the next block word other than «ni»:
 *   «bloquea todo menos WhatsApp», «sin redes excepto WhatsApp 1h», «pero déjame WhatsApp».
 * - a later plan, from «(y) luego/después» to punctuation, when something came before it:
 *   «estudiar 1h y después YouTube». A phrase that starts with «después de cenar…» is
 *   left alone.
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
    if (EXCEPTION_MARKERS.has(word)) {
      start = k;
    } else if (word === 'pero' && LEAVE_AFTER_PERO.has(nextNorm(tokens, k + 1))) {
      start = k;
    } else if (LATER.has(word) && content) {
      later = true;
      const previous = tokens[k - 1];
      const joined =
        previous && !token.breakBefore && !used[k - 1] && ['y', 'e'].includes(previous.norm);
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
      if (!later && j > k && isTriggerAt(tokens, j) && tokens[j]?.norm !== 'ni') break;
      excluded[j] = true;
    }
    k = j - 1;
  }
  return excluded;
}
