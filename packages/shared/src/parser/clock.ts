import { isLongUnit, isMinuteUnit, UNIT_WORDS } from './duration';
import { parseAmount, parseWordNumber } from './numbers';
import { nextNorm, normAt, type Token } from './text';
import type { ParseWarning } from './types';

const MINUTES_PER_DAY = 24 * 60;

export interface UntilMatch {
  /** Token range [start, end). */
  readonly start: number;
  readonly end: number;
  readonly endsAt: Date;
  readonly warnings: readonly ParseWarning[];
}

type Period = 'manana' | 'tarde' | 'noche' | 'madrugada' | 'mediodia' | 'am' | 'pm';

const PERIODS: ReadonlySet<string> = new Set(['manana', 'tarde', 'noche', 'madrugada']);
const HOUR_SUFFIXES: ReadonlySet<string> = new Set(['h', 'hs', 'hrs', 'hora', 'horas']);

// «18:00», «8.30», «18h», «18h30», «18:30h», «6pm».
const CLOCK_RE = /^(\d{1,2})(?:[:.h](\d{2}))?(h|hs|hrs|horas?)?(am|pm)?$/;

interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly explicitMinutes: boolean;
  /** «08:00»: a leading zero means the 24-hour clock. */
  readonly padded: boolean;
  readonly hasSuffix: boolean;
  readonly meridiem?: 'am' | 'pm';
  readonly end: number;
}

function parseClock(tokens: readonly Token[], j: number, hasArticle: boolean): Clock | null {
  const token = tokens[j];
  if (!token || token.breakBefore) return null;
  if (token.type === 'num') {
    const match = CLOCK_RE.exec(token.norm);
    if (!match || match[1] === undefined) return null;
    const hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return null;
    // «hasta 8» (no «las», no «:00») is too vague; «hasta 2 horas» is not a time.
    if (!hasArticle && match[2] === undefined && match[3] === undefined && !match[4]) return null;
    return {
      hour,
      minute,
      explicitMinutes: match[2] !== undefined,
      padded: match[1].length === 2 && match[1].startsWith('0'),
      hasSuffix: match[3] !== undefined,
      ...(match[4] ? { meridiem: match[4] as 'am' | 'pm' } : {}),
      end: j + 1,
    };
  }
  if (!hasArticle) return null;
  const number = parseWordNumber(tokens, j);
  if (!number || number.value > 24) return null;
  return {
    hour: number.value,
    minute: 0,
    explicitMinutes: false,
    padded: false,
    hasSuffix: false,
    end: number.end,
  };
}

/** «y media», «y cuarto», «y 10», «menos cuarto», «menos veinte»: minutes to add. */
function spokenMinutes(tokens: readonly Token[], j: number): { offset: number; end: number } {
  const word = nextNorm(tokens, j);
  if (word !== 'y' && word !== 'menos') return { offset: 0, end: j };
  const sign = word === 'y' ? 1 : -1;
  const next = nextNorm(tokens, j + 1);
  if (next === 'media' && sign > 0) return { offset: 30, end: j + 2 };
  if (next === 'cuarto') return { offset: 15 * sign, end: j + 2 };
  if (next === '' || tokens[j + 1]?.type === 'domain') return { offset: 0, end: j };
  const amount = parseAmount(tokens, j + 1);
  if (!amount || !Number.isInteger(amount.value) || amount.value < 1 || amount.value > 59) {
    return { offset: 0, end: j };
  }
  const unit = nextNorm(tokens, amount.end);
  if (isLongUnit(unit)) return { offset: 0, end: j };
  const end = isMinuteUnit(unit) ? amount.end + 1 : amount.end;
  return { offset: amount.value * sign, end };
}

/** «de la tarde», «por la mañana», «del mediodía», «esta noche». */
function periodAt(tokens: readonly Token[], j: number): { period?: Period; end: number } {
  const a = nextNorm(tokens, j);
  const b = nextNorm(tokens, j + 1);
  const c = nextNorm(tokens, j + 2);
  if ((a === 'de' || a === 'por') && b === 'la' && PERIODS.has(c)) {
    return { period: c as Period, end: j + 3 };
  }
  if (a === 'de' && b === 'esta' && PERIODS.has(c)) return { period: c as Period, end: j + 3 };
  if (a === 'esta' && PERIODS.has(b)) return { period: b as Period, end: j + 2 };
  if (a === 'del' && b === 'mediodia') return { period: 'mediodia', end: j + 2 };
  if (a === 'am' || a === 'pm') return { period: a, end: j + 1 };
  return { end: j };
}

/**
 * Hours of the day `hour` can mean, in order of preference. Several hours means the
 * reading is ambiguous («las 8»: 8:00 or 20:00).
 */
function candidateHours(clock: Clock, period: Period | undefined): number[] {
  const { hour } = clock;
  if (hour === 0 || hour > 12) return [hour];
  switch (period ?? clock.meridiem) {
    case 'manana':
      return [hour];
    case 'madrugada':
    case 'am':
      return [hour % 12];
    case 'tarde':
    case 'pm':
      return [hour === 12 ? 12 : hour + 12];
    case 'noche':
      if (hour === 12) return [24];
      return [hour >= 5 ? hour + 12 : hour];
    case 'mediodia':
      return [hour <= 4 ? hour + 12 : hour];
    default:
      if (clock.padded) return [hour];
      return hour === 12 ? [12, 24] : [hour, hour + 12];
  }
}

function localDayAt(now: Date, dayOffset: number, minuteOfDay: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, minuteOfDay);
}

/** Periods that name the early hours: from noon on, «las 8 de la mañana» is tomorrow. */
const EARLY_PERIODS: ReadonlySet<Period> = new Set(['manana', 'madrugada', 'am', 'noche']);
const NOON = 12 * 60;

/**
 * Turns minutes of the day (in order of preference) into an instant. With «mañana» the
 * first reading on the next day wins; otherwise the earliest reading still ahead, today or
 * tomorrow. `earlyPeriod` means the user named the early hours («de la madrugada», «de la
 * mañana», «am»): from noon on, reading them as tomorrow is what they meant, so there is no
 * `past_time` warning.
 */
function resolve(
  now: Date,
  minutesOfDay: readonly number[],
  tomorrow: boolean,
  earlyPeriod = false,
): { endsAt: Date; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  if (tomorrow) return { endsAt: localDayAt(now, 1, minutesOfDay[0] ?? 0), warnings };
  let best: { at: Date; rolled: boolean; minuteOfDay: number } | undefined;
  for (const minuteOfDay of minutesOfDay) {
    const today = localDayAt(now, 0, minuteOfDay);
    const rolled = today.getTime() <= now.getTime();
    const at = rolled ? localDayAt(now, 1, minuteOfDay) : today;
    if (!best || at.getTime() < best.at.getTime()) best = { at, rolled, minuteOfDay };
  }
  if (!best) return { endsAt: now, warnings };
  if (minutesOfDay.length > 1) warnings.push('ambiguous_time');
  const midnight = ((best.minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY === 0;
  const intended = earlyPeriod && best.minuteOfDay < NOON && now.getHours() * 60 >= NOON;
  if (best.rolled && !midnight && !intended) warnings.push('past_time');
  return { endsAt: best.at, warnings };
}

/** «de hoy», «hoy», «mañana», «de mañana» after the time. */
function trailingDay(tokens: readonly Token[], j: number): { tomorrow: boolean; end: number } {
  const a = nextNorm(tokens, j);
  const b = nextNorm(tokens, j + 1);
  if (a === 'hoy') return { tomorrow: false, end: j + 1 };
  if (a === 'manana') return { tomorrow: true, end: j + 1 };
  if (a === 'de' && b === 'hoy') return { tomorrow: false, end: j + 2 };
  if (a === 'de' && b === 'manana') return { tomorrow: true, end: j + 2 };
  return { tomorrow: false, end: j };
}

/** «hasta que sean las 8», «hasta q den las 8». */
const UNTIL_VERBS: ReadonlySet<string> = new Set(['sean', 'sea', 'den', 'dan']);

/** «hasta», its texting spelling «asta», and «de aquí a». Returns the index after it. */
function untilWordEnd(tokens: readonly Token[], i: number): number | null {
  const word = normAt(tokens, i);
  if (word === 'hasta' || word === 'asta') {
    const que = nextNorm(tokens, i + 1);
    if ((que === 'que' || que === 'q' || que === 'k') && UNTIL_VERBS.has(nextNorm(tokens, i + 2))) {
      return i + 3;
    }
    return i + 1;
  }
  const here = nextNorm(tokens, i + 1);
  if (word === 'de' && (here === 'aqui' || here === 'aki') && nextNorm(tokens, i + 2) === 'a') {
    return i + 3;
  }
  return null;
}

const TWO_DIGITS_RE = /^\d{2}$/;

/**
 * «hasta las 20 30»: a bare two-digit minute after an hour typed in digits with «las».
 * Returns the minute and the index after it, or null.
 */
function bareMinutes(tokens: readonly Token[], j: number): { minute: number; end: number } | null {
  const token = tokens[j];
  if (!token || token.breakBefore || token.type !== 'num' || !TWO_DIGITS_RE.test(token.norm)) {
    return null;
  }
  const minute = Number(token.norm);
  if (minute > 59 || UNIT_WORDS.has(nextNorm(tokens, j + 1))) return null;
  return { minute, end: j + 1 };
}

/**
 * An end time starting at `tokens[i]` («hasta …», «asta …», «de aquí a …», «hasta que
 * sean …»): «hasta las 18:00», «hasta las 8 y media», «hasta las 9 menos cuarto», «hasta las
 * 6 de la tarde», «hasta mañana a las 8», «hasta mediodía», «hasta medianoche», «hasta la
 * una», «hasta las 20 30». A time that already passed today means tomorrow.
 */
export function matchUntil(tokens: readonly Token[], i: number, now: Date): UntilMatch | null {
  const after = untilWordEnd(tokens, i);
  if (after === null) return null;
  let j = after;
  let tomorrow = false;
  if (nextNorm(tokens, j) === 'manana') {
    tomorrow = true;
    j += 1;
    if (nextNorm(tokens, j) === 'a') j += 1;
  }

  let k = j;
  if (nextNorm(tokens, k) === 'el' || nextNorm(tokens, k) === 'la') k += 1;
  const special = nextNorm(tokens, k);
  if (special === 'mediodia' || special === 'medianoche') {
    const day = trailingDay(tokens, k + 1);
    const minuteOfDay = special === 'mediodia' ? 12 * 60 : MINUTES_PER_DAY;
    const { endsAt, warnings } = resolve(now, [minuteOfDay], tomorrow || day.tomorrow);
    return { start: i, end: day.end, endsAt, warnings };
  }

  const article = nextNorm(tokens, j);
  const hasArticle = article === 'las' || article === 'la';
  if (hasArticle) j += 1;
  const clock = parseClock(tokens, j, hasArticle);
  if (!clock) return null;
  const numeric = tokens[j]?.type === 'num';
  j = clock.end;

  let offset = clock.minute;
  const bare =
    hasArticle && numeric && !clock.explicitMinutes && !clock.hasSuffix && !clock.meridiem
      ? bareMinutes(tokens, j)
      : null;
  if (bare) {
    offset = bare.minute;
    j = bare.end;
  } else if (!clock.explicitMinutes) {
    const spoken = spokenMinutes(tokens, j);
    offset = spoken.offset;
    j = spoken.end;
    if (nextNorm(tokens, j) === 'en' && nextNorm(tokens, j + 1) === 'punto') j += 2;
  }
  if (!clock.hasSuffix && HOUR_SUFFIXES.has(nextNorm(tokens, j))) j += 1;
  const period = periodAt(tokens, j);
  j = period.end;
  const day = trailingDay(tokens, j);
  j = day.end;

  const hours = candidateHours(clock, period.period);
  const minutesOfDay = hours.map((hour) => hour * 60 + offset);
  const named = period.period ?? clock.meridiem;
  const earlyPeriod = named !== undefined && EARLY_PERIODS.has(named);
  const { endsAt, warnings } = resolve(now, minutesOfDay, tomorrow || day.tomorrow, earlyPeriod);
  return { start: i, end: j, endsAt, warnings };
}
