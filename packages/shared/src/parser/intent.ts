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
]);
const DESIRE_LOOKBACK = 4;

/**
 * «quiero ver YouTube», «voy a jugar», «ver Netflix 2h», «juego al Minecraft», «necesito el
 * WhatsApp», «tengo ganas de YouTube», «me apetece…»: the user wants to use something. Only
 * meaningful when the phrase has no block word.
 */
export function hasPositiveDesire(tokens: readonly Token[], hits: readonly TargetHit[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!DESIRE.has(normAt(tokens, i))) continue;
    for (let k = i + 1; k <= i + 3; k += 1) {
      const word = nextNorm(tokens, k);
      if (CONSUME.has(word)) return true;
      if (word !== 'a' && word !== 'me' && !isDe(word)) break;
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

/** «quítame el bloqueo», «cancela el límite». */
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
]);
const BLOCK_NOUNS: ReadonlySet<string> = new Set([
  'bloqueo',
  'bloqueos',
  'limite',
  'limites',
  'restriccion',
  'restricciones',
  'castigo',
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
]);
const NEGATIONS: ReadonlySet<string> = new Set(['no', 'nunca', 'jamas', 'tampoco']);
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
]);
const BLOCK_VERB_RE = /^(?:bloque|prohib|limit|restring)/;

/**
 * «desbloquea YouTube», «quítame el bloqueo de Insta», «no bloquees YouTube», «ya no quiero
 * bloquear TikTok»: the user wants a block lifted or not created. The parser never turns
 * these into a block (and the guardian cannot end one early anyway).
 */
export function hasUnblockIntent(tokens: readonly Token[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const word = normAt(tokens, i);
    if (word.startsWith('desbloque') || word === 'unblock') return true;
    if (UNBLOCK_VERBS.has(word)) {
      for (let k = i + 1; k <= i + 3; k += 1) {
        const next = nextNorm(tokens, k);
        if (BLOCK_NOUNS.has(next)) return true;
        if (!BLOCK_NOUN_SKIP.has(next)) break;
      }
    }
    if (NEGATIONS.has(word)) {
      for (let k = i + 1; k <= i + 4; k += 1) {
        const next = nextNorm(tokens, k);
        if (BLOCK_VERB_RE.test(next)) return true;
        if (!NEGATION_SKIP.has(next)) break;
      }
    }
  }
  return false;
}
