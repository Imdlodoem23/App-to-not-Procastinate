import { parseAmount } from './numbers';
import { nextNorm, normAt, type Token } from './text';

const HOUR_UNITS: ReadonlySet<string> = new Set([
  'h',
  'hr',
  'hrs',
  'hs',
  'hora',
  'horas',
  'horita',
  'horitas',
  // Texting spelling: «1 ora».
  'ora',
  'oras',
]);
const MINUTE_UNITS: ReadonlySet<string> = new Set([
  'm',
  'min',
  'mins',
  'minuto',
  'minutos',
  'minutito',
  'minutitos',
]);
const DAY_UNITS: ReadonlySet<string> = new Set(['dia', 'dias']);
const WEEK_UNITS: ReadonlySet<string> = new Set(['semana', 'semanas']);

/** Every duration unit word, for callers that skip known words. */
export const UNIT_WORDS: ReadonlySet<string> = new Set([
  ...HOUR_UNITS,
  ...MINUTE_UNITS,
  ...DAY_UNITS,
  ...WEEK_UNITS,
]);

/** Minutes in one `unit`, or undefined when `unit` is not a duration unit. */
function unitMinutes(unit: string): number | undefined {
  if (HOUR_UNITS.has(unit)) return 60;
  if (MINUTE_UNITS.has(unit)) return 1;
  if (DAY_UNITS.has(unit)) return 24 * 60;
  if (WEEK_UNITS.has(unit)) return 7 * 24 * 60;
  return undefined;
}

export function isMinuteUnit(word: string): boolean {
  return MINUTE_UNITS.has(word);
}

/** True for «h», «horas», «días»…: units a trailing minute count cannot belong to. */
export function isLongUnit(word: string): boolean {
  const minutes = unitMinutes(word);
  return minutes !== undefined && minutes >= 60;
}

const isSingularHour = (word: string): boolean =>
  word === 'hora' || word === 'horita' || word === 'ora';

/** Words that may precede a duration: «durante 45 minutos», «en una hora», «unos 20 min». */
const PREFIXES: ReadonlySet<string> = new Set([
  'durante',
  'por',
  'en',
  'unos',
  'unas',
  'un',
  'una',
  'como',
  'aprox',
  'aproximadamente',
  'la',
  'el',
  'las',
  'los',
  'proxima',
  'proximo',
  'siguiente',
  'proximas',
  'proximos',
  'siguientes',
]);
const MAX_PREFIXES = 4;
/** «la próxima hora», «el siguiente cuarto de hora»: a bare «hora» after them is one hour. */
const SINGULAR_NEXT: ReadonlySet<string> = new Set(['proxima', 'proximo', 'siguiente']);
/** «las 2 próximas horas»: between the amount and the unit. */
const PLURAL_NEXT: ReadonlySet<string> = new Set(['proximas', 'proximos', 'siguientes']);

const COMPACT_RE =
  /^(\d{1,4}(?:[.,]\d{1,2})?)(h|hr|hrs|hs|horas?|horitas?|oras?|m|min|mins|minutos?|d|dias?)$/;
const COMPACT_HOURS_MINUTES_RE = /^(\d{1,3})h(\d{1,2})(?:m|min|mins|minutos?)?$/;
const COMPACT_MINUTES_RE = /^(\d{1,2})(?:m|min|mins|minutos?)$/;
const CLOCK_WITH_UNIT_RE = /^(\d{1,2}):(\d{2})(?:h|hs|hrs|horas?)$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

export interface DurationMatch {
  /** Token range [start, end), prefixes included. */
  readonly start: number;
  readonly end: number;
  readonly minutes: number;
}

interface Core {
  readonly end: number;
  readonly minutes: number;
}

/** «y media», «y cuarto», «y tres cuartos» after an hour. */
function fractionAfterY(tokens: readonly Token[], j: number): Core | null {
  if (nextNorm(tokens, j) !== 'y') return null;
  const word = nextNorm(tokens, j + 1);
  if (word === 'media') return { end: j + 2, minutes: 30 };
  if (word === 'cuarto') return { end: j + 2, minutes: 15 };
  if (word === 'tres' && nextNorm(tokens, j + 2) === 'cuartos') return { end: j + 3, minutes: 45 };
  return null;
}

/** Minutes after an hour amount: «y media», «y 20», «30min», «y cuarenta minutos». */
function minutesAfterHours(tokens: readonly Token[], j: number): Core | null {
  const fraction = fractionAfterY(tokens, j);
  if (fraction) return fraction;
  let p = j;
  if (nextNorm(tokens, p) === 'y') p += 1;
  const token = tokens[p];
  if (!token || token.breakBefore) return null;
  if (token.type === 'num') {
    const compact = COMPACT_MINUTES_RE.exec(token.norm);
    if (compact) {
      const minutes = Number(compact[1]);
      return minutes < 60 ? { end: p + 1, minutes } : null;
    }
  }
  const amount = parseAmount(tokens, p);
  if (!amount || !Number.isInteger(amount.value) || amount.value < 1 || amount.value > 59) {
    return null;
  }
  const unit = nextNorm(tokens, amount.end);
  if (MINUTE_UNITS.has(unit)) return { end: amount.end + 1, minutes: amount.value };
  if (unitMinutes(unit) !== undefined) return null;
  // A bare count («una hora y 20», «1h 30»). «y un poco» is not one minute.
  return amount.value >= 2 ? { end: amount.end, minutes: amount.value } : null;
}

function withHourMinutes(tokens: readonly Token[], end: number, minutes: number): Core {
  const extra = minutesAfterHours(tokens, end);
  return extra ? { end: extra.end, minutes: minutes + extra.minutes } : { end, minutes };
}

function compactCore(
  token: Token,
  tokens: readonly Token[],
  k: number,
  durante: boolean,
): Core | null {
  const norm = token.norm;
  const hoursMinutes = COMPACT_HOURS_MINUTES_RE.exec(norm);
  if (hoursMinutes) {
    const minutes = Number(hoursMinutes[2]);
    if (minutes >= 60) return null;
    let end = k + 1;
    if (MINUTE_UNITS.has(nextNorm(tokens, end))) end += 1;
    return { end, minutes: Number(hoursMinutes[1]) * 60 + minutes };
  }
  const clock = CLOCK_WITH_UNIT_RE.exec(norm) ?? (durante ? CLOCK_RE.exec(norm) : null);
  if (clock) {
    const minutes = Number(clock[2]);
    return minutes < 60 ? { end: k + 1, minutes: Number(clock[1]) * 60 + minutes } : null;
  }
  const compact = COMPACT_RE.exec(norm);
  if (!compact || compact[1] === undefined || compact[2] === undefined) return null;
  const perUnit = compact[2] === 'd' ? 24 * 60 : (unitMinutes(compact[2]) ?? 0);
  const minutes = Math.round(Number(compact[1].replace(',', '.')) * perUnit);
  return perUnit === 60 ? withHourMinutes(tokens, k + 1, minutes) : { end: k + 1, minutes };
}

/** A duration that starts exactly at `tokens[k]` (no prefixes). */
function matchCore(tokens: readonly Token[], k: number, durante: boolean): Core | null {
  const token = tokens[k];
  if (!token) return null;
  const word = token.norm;
  if (word === 'media' && isSingularHour(nextNorm(tokens, k + 1))) {
    return { end: k + 2, minutes: 30 };
  }
  if (isSingularHour(word)) {
    const fraction = fractionAfterY(tokens, k + 1);
    return fraction ? { end: fraction.end, minutes: 60 + fraction.minutes } : null;
  }
  if (word === 'cuarto' && nextNorm(tokens, k + 1) === 'de') {
    return isSingularHour(nextNorm(tokens, k + 2)) ? { end: k + 3, minutes: 15 } : null;
  }
  if (token.type === 'num') {
    const compact = compactCore(token, tokens, k, durante);
    if (compact) return compact;
  }
  const amount = parseAmount(tokens, k);
  if (!amount) return null;
  // «2 próximas horas»: skip the word between the amount and its unit.
  const unitAt =
    PLURAL_NEXT.has(nextNorm(tokens, amount.end)) &&
    unitMinutes(nextNorm(tokens, amount.end + 1)) !== undefined
      ? amount.end + 1
      : amount.end;
  const unit = nextNorm(tokens, unitAt);
  if (
    (unit === 'cuarto' || unit === 'cuartos') &&
    nextNorm(tokens, unitAt + 1) === 'de' &&
    isSingularHour(nextNorm(tokens, unitAt + 2))
  ) {
    return { end: unitAt + 3, minutes: amount.value * 15 };
  }
  const perUnit = unitMinutes(unit);
  if (perUnit === undefined) return null;
  const minutes = Math.round(amount.value * perUnit);
  const end = unitAt + 1;
  return perUnit === 60 ? withHourMinutes(tokens, end, minutes) : { end, minutes };
}

/**
 * A duration starting at `tokens[i]`, prefixes included: «una hora», «media hora», «hora y
 * media», «un cuarto de hora», «tres cuartos de hora», «90 min», «2h», «1h30», «1h 30min»,
 * «dos horas y media», «un par de horas», «2 días», «en una hora» (read as «for one hour»),
 * «durante la próxima hora», «las 2 próximas horas». «1:30» is a duration only after
 * «durante».
 */
export function matchDuration(tokens: readonly Token[], i: number): DurationMatch | null {
  let durante = false;
  let singularNext = false;
  for (let k = i; k < tokens.length && k - i <= MAX_PREFIXES; k += 1) {
    if (k > i && tokens[k]?.breakBefore) return null;
    const core = matchCore(tokens, k, durante);
    if (core && Number.isFinite(core.minutes)) {
      return { start: i, end: core.end, minutes: core.minutes };
    }
    const word = normAt(tokens, k);
    if (singularNext && isSingularHour(word)) return { start: i, end: k + 1, minutes: 60 };
    if (!PREFIXES.has(word)) return null;
    if (word === 'durante') durante = true;
    if (SINGULAR_NEXT.has(word)) singularNext = true;
  }
  return null;
}
