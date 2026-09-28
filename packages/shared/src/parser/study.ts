import { aliasKey } from '../catalog';
import { isWeakAliasKey, lookupAlias } from './aliases';
import { isTriggerAt, LIST_CONNECTORS, strongAliasStartsAt } from './targets';
import { nextNorm, type Token } from './text';
import {
  isDe,
  isFiller,
  OTHER_KNOWN,
  STUDY_COMPOUND_NOUNS,
  STUDY_NOUNS,
  STUDY_NOUNS_AFTER_HACER,
  STUDY_NOUN_ARTICLES,
  STUDY_NOUN_VERBS,
  STUDY_VERBS,
  TASK_TRIM_END,
  TASK_TRIM_START,
  TRIGGERS,
} from './vocabulary';

export interface StudyScan {
  /** Token range [start, end) of the task, when one was typed. */
  readonly task?: { readonly start: number; readonly end: number };
}

const NEGATIONS: ReadonlySet<string> = new Set([
  'no',
  'ni',
  'sin',
  'nunca',
  'jamas',
  'odio',
  // English; «t» is the end of «don't», «can't», «won't».
  't',
  'not',
  'never',
  'dont',
  'cant',
  'wont',
  'without',
  'hate',
  'stop',
  'quit',
  'skip',
  'nor',
  'neither',
]);
/**
 * «after studying», «done studying», «tired of studying», «instead of doing homework»:
 * right before the study verb (maybe through «of» or «with»), not a wish to study now.
 */
const DONE_BEFORE_EN: ReadonlySet<string> = new Set([
  'after',
  'before',
  'done',
  'finished',
  'tired',
  'sick',
  'bored',
  'instead',
  'avoid',
]);
/** «cuando acabe de estudiar», «harto de estudiar»: not a wish to study now. */
const DONE_BEFORE_DE: ReadonlySet<string> = new Set([
  'acabe',
  'acabo',
  'acabar',
  'termine',
  'termino',
  'terminar',
  'harto',
  'harta',
]);
/** A new clause starts after these: «no veo YouTube y estudio mates», «… and study math». */
const CLAUSE_JOINERS: ReadonlySet<string> = new Set(['y', 'e', 'pero', 'and', 'but']);
/** A task never starts with these right after a time: «estudio 1h y descanso». */
const CLAUSE_STARTERS: ReadonlySet<string> = new Set([...LIST_CONNECTORS, 'pero', 'but']);
/** «modo estudio», «study mode». */
const MODE_WORDS: ReadonlySet<string> = new Set(['estudio', 'estudiar', 'study']);
const NEGATION_LOOKBACK = 4;

/**
 * «no quiero estudiar», «no voy a hacer los deberes», «paso de estudiar», «deja de
 * estudiar», «olvídate de estudiar», «odio estudiar», «cero ganas de estudiar», «cuando
 * acabe de estudiar», «I don't want to study», «stop studying», «after studying», «tired
 * of studying».
 */
function isNegated(tokens: readonly Token[], i: number): boolean {
  const previous = tokens[i]?.breakBefore ? '' : (tokens[i - 1]?.norm ?? '');
  const linked =
    (previous === 'of' || previous === 'with') && !tokens[i - 1]?.breakBefore
      ? (tokens[i - 2]?.norm ?? '')
      : '';
  if (DONE_BEFORE_EN.has(previous) || DONE_BEFORE_EN.has(linked)) return true;
  for (let k = i - 1; k >= Math.max(0, i - NEGATION_LOOKBACK); k -= 1) {
    // Punctuation ends the clause: «no veo YouTube, estudio mates».
    if (tokens[k + 1]?.breakBefore) break;
    const word = tokens[k]?.norm ?? '';
    if (CLAUSE_JOINERS.has(word)) break;
    if (NEGATIONS.has(word)) return true;
    const next = nextNorm(tokens, k + 1);
    if (isDe(next) && (isTriggerAt(tokens, k) || DONE_BEFORE_DE.has(word))) return true;
    if (word === 'cero' && next === 'ganas') return true;
  }
  return false;
}

/** At most this many words before an English study noun: «world history essay». */
const MAX_MODIFIERS = 2;

/**
 * Where the study verb ends, where its task starts and the index of the phrase's last
 * token (the verb, or the noun of «hacer los deberes»).
 */
function studyVerbAt(
  tokens: readonly Token[],
  i: number,
): { verbEnd: number; taskStart: number; last: number } | null {
  const word = tokens[i]?.norm ?? '';
  const next = nextNorm(tokens, i + 1);
  if ((word === 'modo' && MODE_WORDS.has(next)) || (word === 'study' && next === 'mode')) {
    return { verbEnd: i + 2, taskStart: i + 2, last: i + 1 };
  }
  if (STUDY_VERBS.has(word)) return { verbEnd: i + 1, taskStart: i + 1, last: i };
  if (STUDY_NOUNS.has(word)) return { verbEnd: i, taskStart: i, last: i };
  if (STUDY_NOUN_VERBS.has(word)) {
    let k = i + 1;
    // «hacer los deberes», «do my homework», «work on my essay».
    for (let n = 0; n < 2; n += 1) {
      if (STUDY_NOUN_ARTICLES.has(tokens[k]?.norm ?? '') && !tokens[k]?.breakBefore) k += 1;
    }
    const noun = tokens[k];
    const isNoun = !!noun && (STUDY_NOUNS.has(noun.norm) || STUDY_NOUNS_AFTER_HACER.has(noun.norm));
    if (noun && !noun.breakBefore && isNoun) return { verbEnd: k, taskStart: k, last: k };
    // «do my math homework», «write my history essay».
    for (let m = k; m < k + MAX_MODIFIERS; m += 1) {
      const modifier = tokens[m];
      if (!modifier || modifier.breakBefore || !isModifier(modifier)) break;
      const compound = tokens[m + 1];
      if (compound && !compound.breakBefore && STUDY_COMPOUND_NOUNS.has(compound.norm)) {
        return { verbEnd: k, taskStart: k, last: m + 1 };
      }
    }
  }
  return null;
}

/**
 * A plain word that can describe an English study noun («math», «history»): not filler, a
 * block word, a time word, a number or a catalog name («YouTube homework» is two things).
 */
function isModifier(token: Token | undefined): boolean {
  if (!token || token.type !== 'word') return false;
  const word = token.norm;
  if (isFiller(word) || TRIGGERS.has(word) || OTHER_KNOWN.has(word)) return false;
  return lookupAlias(token.text) === undefined || isWeakAliasKey(aliasKey(token.text));
}

/**
 * Words before a standalone English study noun that describe it: «math» in «math homework
 * 1h». Returns the index of the first one (or `i` when there is none).
 */
function modifiersBefore(
  tokens: readonly Token[],
  used: readonly boolean[],
  excluded: readonly boolean[],
  i: number,
): number {
  let start = i;
  while (
    start > 0 &&
    i - start < MAX_MODIFIERS &&
    !tokens[start]?.breakBefore &&
    !used[start - 1] &&
    !excluded[start - 1] &&
    isModifier(tokens[start - 1]) &&
    !isTriggerAt(tokens, start - 1)
  ) {
    start -= 1;
  }
  return start;
}

/**
 * Finds a study intent («estudiar mates», «voy a estudiar historia», «hacer deberes de
 * inglés», «hacer el trabajo de historia», «repasar física», «modo estudio», «estudio»)
 * among the tokens not yet `used` nor `excluded`, and marks it. The task runs from the
 * verb to a block word, punctuation, an excluded token («y después…»), a connector before
 * a catalog alias («mates y YouTube») or the next already-read token (a duration read
 * earlier ends it; one before any task word is skipped: «estudiar 1 h de historia», unless
 * a connector follows it: «estudio 1h y descanso»). Filler at either end is trimmed
 * («estudiar ya», «2 horas seguidas»). Returns null when there is no study intent or it is
 * negated.
 */
export function scanStudy(
  tokens: readonly Token[],
  used: boolean[],
  excluded: readonly boolean[] = [],
): StudyScan | null {
  for (let i = 0; i < tokens.length; i += 1) {
    if (used[i] || excluded[i]) continue;
    const verb = studyVerbAt(tokens, i);
    if (!verb) continue;
    if (isNegated(tokens, i)) {
      // Skip the whole phrase, so «deberes» in «no voy a hacer los deberes» is not read alone.
      i = verb.last;
      continue;
    }
    for (let k = i; k < verb.verbEnd; k += 1) used[k] = true;

    const word = tokens[i]?.norm ?? '';
    const taskStart =
      verb.verbEnd === i && STUDY_COMPOUND_NOUNS.has(word)
        ? modifiersBefore(tokens, used, excluded, i)
        : verb.taskStart;
    const run: number[] = [];
    let afterTime = false;
    for (let k = taskStart; k < tokens.length; k += 1) {
      const token = tokens[k];
      if (!token || excluded[k]) break;
      if (k > Math.min(i, taskStart) && token.breakBefore) break;
      if (used[k]) {
        if (run.length > 0) break;
        afterTime = true;
        continue;
      }
      if (isTriggerAt(tokens, k)) break;
      if (run.length === 0 && afterTime && CLAUSE_STARTERS.has(token.norm)) break;
      if (LIST_CONNECTORS.has(token.norm) && strongAliasStartsAt(tokens, k + 1)) break;
      run.push(k);
    }
    let first = 0;
    let last = run.length - 1;
    while (first <= last && TASK_TRIM_START.has(tokens[run[first] ?? -1]?.norm ?? '')) first += 1;
    while (last >= first && TASK_TRIM_END.has(tokens[run[last] ?? -1]?.norm ?? '')) last -= 1;
    const start = run[first];
    const end = run[last];
    if (start === undefined || end === undefined || first > last) return {};
    for (let k = start; k <= end; k += 1) used[k] = true;
    return { task: { start, end: end + 1 } };
  }
  return null;
}
