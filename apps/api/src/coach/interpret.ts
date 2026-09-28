/**
 * «Preguntar al coach» for phrases the local parser did not understand (owner: COACH).
 * docs/API.md §10.1.
 *
 * The model returns a structured intent whose services and categories can only be catalog ids
 * (an enum in the output schema). The server then writes the canonical phrase itself, with
 * words the local parser is known to read as exactly those ids, and keeps it only if
 * `parseIntent` reads it back to the same intent with nothing left over. The desktop parses
 * `canonicalText` again in the user's zone and always shows the confirmation card, so nothing
 * the model says ever reaches a block directly.
 */
import type { CategoryId } from '@centrate/shared/catalog';
import { CATEGORIES, SERVICES, isValidDomain, normalizeDomain } from '@centrate/shared/catalog';
import type { InterpretResponse } from '@centrate/shared/cloud-api';
import { parseIntent } from '@centrate/shared/parser';
import type { InterpretOutput } from './schemas';
import { oneLine, outputText, userData } from './text';

/** Durations the app accepts for a block or a study session (advanced form limits). */
export const INTERPRET_MIN_MINUTES = 5;
export const INTERPRET_MAX_MINUTES = 1440;
const MAX_TARGETS = 10;
const TASK_MAX = 60;
const CLARIFICATION_MAX = 200;

export const GENERIC_CLARIFICATION =
  'No he podido entender la frase. Prueba con algo como «no veo YouTube durante 1 hora» o «estudiar mates 45 minutos».';

/**
 * A `Date` whose local getters (`getHours()`…) read the wall-clock time of `timeZone` at
 * instant `at`. The shared parser works in local time and the server runs in UTC, so the
 * phrase is checked against the user's own clock.
 */
export function wallClock(at: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return new Date(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
    at.getMilliseconds(),
  );
}

/** «lunes, 28/09/2026, 16:05» in the user's zone, for the prompt. */
export function localTimeLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

export function interpretUserMessage(text: string, at: Date, timeZone: string): string {
  return [
    `Fecha y hora local de la persona: ${localTimeLabel(at, timeZone)}.`,
    userData([['frase', text]]),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Words the parser reads as exactly one catalog id
// ---------------------------------------------------------------------------------------

const PROBE_NOW = new Date(2026, 0, 5, 10, 0, 0);

function readsAs(word: string, check: (r: ReturnType<typeof parseIntent>) => boolean): boolean {
  if (!word || /[<>]/.test(word)) return false;
  const r = parseIntent(`bloquear ${word} durante 30 minutos`, { now: PROBE_NOW });
  return r.kind === 'block' && r.unparsed.length === 0 && r.domains.length === 0 && check(r);
}

interface Vocabulary {
  services: ReadonlyMap<string, string>;
  categories: ReadonlyMap<CategoryId, string>;
}

let vocabulary: Vocabulary | null = null;

/** Built once, on first use (a few hundred local parses). */
export function phraseVocabulary(): Vocabulary {
  if (vocabulary) return vocabulary;
  const services = new Map<string, string>();
  for (const s of SERVICES) {
    const word = [s.name.toLowerCase(), ...s.aliases].find((w) =>
      readsAs(
        w,
        (r) => r.categoryIds.length === 0 && r.serviceIds.length === 1 && r.serviceIds[0] === s.id,
      ),
    );
    if (word) services.set(s.id, word);
  }
  const categories = new Map<CategoryId, string>();
  for (const c of CATEGORIES) {
    const word = [c.name.toLowerCase(), ...c.aliases].find((w) =>
      readsAs(
        w,
        (r) => r.serviceIds.length === 0 && r.categoryIds.length === 1 && r.categoryIds[0] === c.id,
      ),
    );
    if (word) categories.set(c.id, word);
  }
  vocabulary = { services, categories };
  return vocabulary;
}

// ---------------------------------------------------------------------------------------
// Canonical phrase
// ---------------------------------------------------------------------------------------

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const sameSet = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} y ${words[words.length - 1]}`;
}

const clampMinutes = (minutes: number): number =>
  Math.min(INTERPRET_MAX_MINUTES, Math.max(INTERPRET_MIN_MINUTES, Math.round(minutes)));

function timePhrase(intent: InterpretOutput): string | null {
  if (intent.durationMinutes !== null && Number.isFinite(intent.durationMinutes)) {
    return `durante ${clampMinutes(intent.durationMinutes)} minutos`;
  }
  const m = intent.untilTime === null ? null : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(intent.untilTime);
  if (m) return `hasta ${intent.untilTomorrow ? 'mañana a las' : 'las'} ${m[1]}:${m[2]}`;
  return null;
}

interface Planned {
  kind: 'block' | 'study';
  text: string;
  serviceIds: string[];
  categoryIds: CategoryId[];
  domains: string[];
}

/** Writes the phrase for the model's intent, or null when it cannot be expressed safely. */
export function canonicalPhrase(intent: InterpretOutput, userText: string): Planned | null {
  if (intent.kind === 'unclear') return null;
  const vocab = phraseVocabulary();
  const time = timePhrase(intent);
  if (intent.kind === 'study') {
    const task = oneLine(intent.task ?? '')
      .replace(/[^\p{L}\p{N} '’-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TASK_MAX)
      .trim();
    const text = ['estudiar', task, time].filter(Boolean).join(' ');
    return { kind: 'study', text, serviceIds: [], categoryIds: [], domains: [] };
  }

  const serviceIds = unique(intent.serviceIds).filter((id) => vocab.services.has(id));
  const categoryIds = unique(intent.categoryIds).filter((id) => vocab.categories.has(id));
  // Only domains the person typed: the model may never add a site of its own.
  const typed = userText.toLowerCase();
  const domains = unique(
    intent.domains
      .map((d) => normalizeDomain(d))
      .filter((d): d is string => d !== null && isValidDomain(d) && typed.includes(d)),
  );
  const words = [
    ...serviceIds.map((id) => vocab.services.get(id) ?? ''),
    ...categoryIds.map((id) => vocab.categories.get(id) ?? ''),
    ...domains,
  ];
  if (words.length === 0 || words.length > MAX_TARGETS) return null;
  const text = ['bloquear', listWords(words), time].filter(Boolean).join(' ');
  return { kind: 'block', text, serviceIds, categoryIds, domains };
}

/**
 * The answer for the app: the canonical phrase when the local parser reads it back to the
 * same intent (checked on the user's wall clock), else a Spanish clarification.
 */
export function interpretAnswer(
  intent: InterpretOutput,
  userText: string,
  wallNow: Date,
): InterpretResponse {
  const clarification = (): InterpretResponse => {
    const own =
      intent.kind === 'unclear' ? outputText(intent.clarification ?? '', CLARIFICATION_MAX) : '';
    return { canonicalText: null, clarification: own || GENERIC_CLARIFICATION };
  };
  const planned = canonicalPhrase(intent, userText);
  if (!planned) return clarification();
  const r = parseIntent(planned.text, { now: wallNow });
  const sameTargets =
    sameSet(r.serviceIds, planned.serviceIds) &&
    sameSet(r.categoryIds, planned.categoryIds) &&
    sameSet(r.domains, planned.domains);
  const minutesOk =
    r.durationMinutes === undefined ||
    (r.durationMinutes >= INTERPRET_MIN_MINUTES && r.durationMinutes <= INTERPRET_MAX_MINUTES);
  if (r.kind !== planned.kind || r.unparsed.length > 0 || !sameTargets || !minutesOk) {
    return clarification();
  }
  return { canonicalText: planned.text, clarification: null };
}
