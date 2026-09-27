import { isTriggerAt, LIST_CONNECTORS, strongAliasStartsAt } from './targets';
import { nextNorm, type Token } from './text';
import {
  isDe,
  STUDY_NOUNS,
  STUDY_NOUNS_AFTER_HACER,
  STUDY_NOUN_ARTICLES,
  STUDY_NOUN_VERBS,
  STUDY_VERBS,
  TASK_TRIM_END,
  TASK_TRIM_START,
} from './vocabulary';

export interface StudyScan {
  /** Token range [start, end) of the task, when one was typed. */
  readonly task?: { readonly start: number; readonly end: number };
}

const NEGATIONS: ReadonlySet<string> = new Set(['no', 'ni', 'sin', 'nunca', 'jamas', 'odio']);
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
/** A new clause starts after these: «no veo YouTube y estudio mates». */
const CLAUSE_JOINERS: ReadonlySet<string> = new Set(['y', 'e', 'pero']);
/** A task never starts with these right after a time: «estudio 1h y descanso». */
const CLAUSE_STARTERS: ReadonlySet<string> = new Set([...LIST_CONNECTORS, 'pero']);
/** «modo estudio», «study mode». */
const MODE_WORDS: ReadonlySet<string> = new Set(['estudio', 'estudiar', 'study']);
const NEGATION_LOOKBACK = 4;

/**
 * «no quiero estudiar», «no voy a hacer los deberes», «paso de estudiar», «deja de
 * estudiar», «olvídate de estudiar», «odio estudiar», «cero ganas de estudiar», «cuando
 * acabe de estudiar».
 */
function isNegated(tokens: readonly Token[], i: number): boolean {
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
    if (STUDY_NOUN_ARTICLES.has(tokens[k]?.norm ?? '') && !tokens[k]?.breakBefore) k += 1;
    const noun = tokens[k];
    const isNoun = !!noun && (STUDY_NOUNS.has(noun.norm) || STUDY_NOUNS_AFTER_HACER.has(noun.norm));
    if (noun && !noun.breakBefore && isNoun) return { verbEnd: k, taskStart: k, last: k };
  }
  return null;
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

    const run: number[] = [];
    let afterTime = false;
    for (let k = verb.taskStart; k < tokens.length; k += 1) {
      const token = tokens[k];
      if (!token || excluded[k]) break;
      if (k > i && token.breakBefore) break;
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
