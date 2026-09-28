import { lookupAlias } from './aliases';
import type { TargetHit } from './targets';
import { nextNorm, normAt, type Token } from './text';
import { CONSUME, DESIRE, DESIRE_BEFORE_TARGET, isDe } from './vocabulary';

/** Words skipped between a use verb and its target: «ver el YouTube», «ganas de YouTube». */
const DESIRE_SKIP: ReadonlySet<string> = new Set([
  'a',
  'al',
  'el',
  'la',
  'los',
  'las',
  'lo',
  'un',
  'una',
  'unos',
  'unas',
  'en',
  'de',
  'del',
  'd',
  'mi',
  'mis',
  'tu',
  'me',
  'te',
  'un',
  'poco',
  'rato',
  'ratito',
  'que',
  'q',
  'k',
  'con',
  'to',
  'the',
  'an',
  'my',
  'your',
  'some',
  'on',
  'at',
  'in',
  'into',
  'onto',
  'of',
  'bit',
  'little',
  'more',
  'with',
]);
const DESIRE_LOOKBACK = 4;
/** Words between a wish and a use verb: «voy a ver», «want to watch», «can I play». */
const DESIRE_BRIDGE: ReadonlySet<string> = new Set([
  'a',
  'me',
  'to',
  'i',
  'u',
  'you',
  'just',
  'some',
  'really',
]);

/**
 * «quiero ver YouTube», «voy a jugar», «ver Netflix 2h», «juego al Minecraft», «necesito el
 * WhatsApp», «tengo ganas de YouTube», «me apetece…», «I want to watch YouTube», «let me
 * play Fortnite», «watch Netflix 2h», «I need WhatsApp»: the user wants to use something.
 * Only meaningful when the phrase has no block word.
 */
export function hasPositiveDesire(tokens: readonly Token[], hits: readonly TargetHit[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!DESIRE.has(normAt(tokens, i))) continue;
    for (let k = i + 1; k <= i + 3; k += 1) {
      const word = nextNorm(tokens, k);
      if (CONSUME.has(word)) return true;
      if (!DESIRE_BRIDGE.has(word) && !isDe(word)) break;
    }
  }
  for (const hit of hits) {
    for (let k = hit.start - 1; k >= Math.max(0, hit.start - DESIRE_LOOKBACK); k -= 1) {
      if (tokens[k + 1]?.breakBefore) break;
      const word = normAt(tokens, k);
      if (CONSUME.has(word) || DESIRE_BEFORE_TARGET.has(word)) return true;
      if (!DESIRE_SKIP.has(word)) break;
    }
  }
  return false;
}

/** «quítame el bloqueo», «cancela el límite», «remove the block», «end my block». */
const UNBLOCK_VERBS: ReadonlySet<string> = new Set([
  'quita',
  'quitame',
  'quitar',
  'quitarme',
  'quitale',
  'quitalo',
  'quitala',
  'cancela',
  'cancelame',
  'cancelar',
  'termina',
  'terminame',
  'terminar',
  'acaba',
  'acabar',
  'elimina',
  'eliminame',
  'eliminar',
  'borra',
  'borrame',
  'borrar',
  'levanta',
  'levantame',
  'levantar',
  'anula',
  'anulame',
  'anular',
  'finaliza',
  'finalizar',
  'remove',
  'cancel',
  'end',
  'stop',
  'lift',
  'delete',
  'drop',
  'undo',
  'kill',
  'disable',
  'pause',
  'turn',
]);
const BLOCK_NOUNS: ReadonlySet<string> = new Set([
  'bloqueo',
  'bloqueos',
  'limite',
  'limites',
  'restriccion',
  'restricciones',
  'castigo',
  'block',
  'blocks',
  'blocking',
  'limit',
  'limits',
  'restriction',
  'restrictions',
  'ban',
  'bans',
  'lock',
  'punishment',
]);
const BLOCK_NOUN_SKIP: ReadonlySet<string> = new Set([
  'el',
  'la',
  'los',
  'las',
  'este',
  'ese',
  'esta',
  'mi',
  'mis',
  'tu',
  'un',
  'una',
  'ya',
  'the',
  'this',
  'that',
  'my',
  'your',
  'a',
  'an',
  'current',
  'off',
  'all',
  'these',
  'those',
]);
/**
 * Negations before a block verb. «t» is the end of «don't», «won't», «can't»; «stop» and
 * «quit» negate too («stop blocking YouTube»).
 */
const NEGATIONS: ReadonlySet<string> = new Set([
  'no',
  'nunca',
  'jamas',
  'tampoco',
  't',
  'not',
  'never',
  'dont',
  'wont',
  'cant',
  'stop',
  'quit',
]);
/** Words between a negation and a block verb: «no me bloquees», «ya no quiero bloquear». */
const NEGATION_SKIP: ReadonlySet<string> = new Set([
  'me',
  'te',
  'le',
  'les',
  'lo',
  'la',
  'los',
  'las',
  'nos',
  'ya',
  'mas',
  'quiero',
  'quieres',
  'kiero',
  'kieres',
  'quisiera',
  'necesito',
  'necesitas',
  'hace',
  'falta',
  'hay',
  'que',
  'q',
  'k',
  'a',
  'vas',
  'vayas',
  'vaya',
  'puedes',
  'tienes',
  'tengo',
  't',
  'me',
  'you',
  'it',
  'them',
  'i',
  'u',
  'want',
  'wanna',
  'need',
  'to',
  'anymore',
  'more',
  'please',
  'have',
  'going',
  'gonna',
  'do',
  'be',
  'ever',
  'just',
  'any',
  'longer',
  'really',
]);
const BLOCK_VERB_RE = /^(?:bloque|prohib|limit|restring)/;
/** English block verbs: «don't block», «stop blocking», «never ban». */
const EN_BLOCK_VERBS: ReadonlySet<string> = new Set([
  'block',
  'blocks',
  'blocking',
  'blocked',
  'ban',
  'banning',
  'banned',
  'restrict',
  'restricting',
  'lock',
  'locking',
]);
/** «I don't want YouTube blocked»: a participle a few words after a negation. */
const BLOCKED_PARTICIPLES: ReadonlySet<string> = new Set([
  'blocked',
  'banned',
  'locked',
  'restricted',
]);
const PARTICIPLE_LOOKAHEAD = 5;

function isBlockVerb(word: string): boolean {
  return BLOCK_VERB_RE.test(word) || EN_BLOCK_VERBS.has(word);
}

/** A word that may sit between «remove» and «block»: «the», «my», «the YouTube block». */
function skipsToBlockNoun(token: Token | undefined): boolean {
  if (!token || token.breakBefore) return false;
  if (BLOCK_NOUN_SKIP.has(token.norm)) return true;
  return token.type === 'word' && lookupAlias(token.text) !== undefined;
}

/**
 * «desbloquea YouTube», «quítame el bloqueo de Insta», «no bloquees YouTube», «ya no quiero
 * bloquear TikTok», «unblock YouTube», «remove the block», «don't block TikTok», «stop
 * blocking YouTube», «I don't want YouTube blocked»: the user wants a block lifted or not
 * created. The parser never turns these into a block (and the guardian cannot end one
 * early anyway).
 */
export function hasUnblockIntent(tokens: readonly Token[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const word = normAt(tokens, i);
    if (/^(?:desbloque|unblock|unlock|unban)/.test(word)) return true;
    if (UNBLOCK_VERBS.has(word)) {
      for (let k = i + 1; k <= i + 3; k += 1) {
        const next = nextNorm(tokens, k);
        if (BLOCK_NOUNS.has(next)) return true;
        if (!skipsToBlockNoun(tokens[k])) break;
      }
    }
    if (NEGATIONS.has(word)) {
      for (let k = i + 1; k <= i + 4; k += 1) {
        const next = nextNorm(tokens, k);
        if (isBlockVerb(next)) return true;
        if (!NEGATION_SKIP.has(next)) break;
      }
      for (let k = i + 1; k <= i + PARTICIPLE_LOOKAHEAD; k += 1) {
        const next = nextNorm(tokens, k);
        if (next === '') break;
        if (BLOCKED_PARTICIPLES.has(next)) return true;
      }
    }
  }
  return false;
}
