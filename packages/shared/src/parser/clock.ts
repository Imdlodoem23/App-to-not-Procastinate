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
/** English parts of the day and the Spanish period each one reads like. */
const EN_PERIODS: ReadonlyMap<string, Period> = new Map([
  ['morning', 'manana'],
  ['afternoon', 'tarde'],
  ['evening', 'tarde'],
  ['night', 'noche'],
]);
/** «tomorrow» and its common misspellings. */
const EN_TOMORROW: ReadonlySet<string> = new Set([
  'tomorrow',
  'tmrw',
  'tmr',
  'tomorow',
  'tommorow',
  'tommorrow',
]);
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

/**
 * A clock time at `tokens[j]`. A bare hour («8», «ocho») needs `hasArticle` («hasta las 8»):
 * «hasta 8» is too vague in Spanish and «hasta 2 horas» is not a time. After an English
 * «until» a bare hour is the usual way to say it («until 8», «until eight»), unless a unit
 * follows it («until 2 hours» is not a time either).
 */
function parseClock(
  tokens: readonly Token[],
  j: number,
  hasArticle: boolean,
  english = false,
): Clock | null {
  const token = tokens[j];
  if (!token || token.breakBefore) return null;
  const bareOk = hasArticle || (english && !UNIT_WORDS.has(nextNorm(tokens, j + 1)));
  if (token.type === 'num') {
    const match = CLOCK_RE.exec(token.norm);
    if (!match || match[1] === undefined) return null;
    const hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return null;
    if (!bareOk && match[2] === undefined && match[3] === undefined && !match[4]) return null;
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
  if (!bareOk) return null;
  const number = parseWordNumber(tokens, j);
  if (!number || number.value > 24) return null;
  if (!hasArticle && UNIT_WORDS.has(nextNorm(tokens, number.end))) return null;
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

/**
 * «de la tarde», «por la mañana», «del mediodía», «esta noche», «am», «pm»; in English «in
 * the evening», «at night», «this morning», «tonight», «a.m.», «p.m.». After «tomorrow»
 * (`afterDay`) a bare part of the day counts too: «8 tomorrow morning».
 */
function periodAt(
  tokens: readonly Token[],
  j: number,
  afterDay = false,
): { period?: Period; end: number } {
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
  // «a.m.», «p.m.»: the dot splits the letters into two tokens.
  const first = tokens[j];
  const second = tokens[j + 1];
  if (
    (a === 'a' || a === 'p') &&
    second?.norm === 'm' &&
    second.breakBefore &&
    first !== undefined &&
    second.start === first.end + 1
  ) {
    return { period: a === 'a' ? 'am' : 'pm', end: j + 2 };
  }
  const english = EN_PERIODS.get(c);
  if (a === 'in' && b === 'the' && english) return { period: english, end: j + 3 };
  if (a === 'at' && b === 'night') return { period: 'noche', end: j + 2 };
  if (a === 'this' && EN_PERIODS.has(b)) return { period: EN_PERIODS.get(b), end: j + 2 };
  if (a === 'tonight') return { period: 'noche', end: j + 1 };
  if (afterDay && EN_PERIODS.has(a)) return { period: EN_PERIODS.get(a), end: j + 1 };
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

/**
 * «de hoy», «hoy», «mañana», «de mañana» after the time; in English «today», «tonight»,
 * «tomorrow».
 */
function trailingDay(tokens: readonly Token[], j: number): { tomorrow: boolean; end: number } {
  const a = nextNorm(tokens, j);
  const b = nextNorm(tokens, j + 1);
  if (a === 'hoy' || a === 'today' || a === 'tonight') return { tomorrow: false, end: j + 1 };
  if (a === 'manana' || EN_TOMORROW.has(a)) return { tomorrow: true, end: j + 1 };
  if (a === 'de' && b === 'hoy') return { tomorrow: false, end: j + 2 };
  if (a === 'de' && b === 'manana') return { tomorrow: true, end: j + 2 };
  return { tomorrow: false, end: j };
}

/** «hasta que sean las 8», «hasta q den las 8». */
const UNTIL_VERBS: ReadonlySet<string> = new Set(['sean', 'sea', 'den', 'dan']);

/**
 * English words that start an end time: «until», «till», «til» («'til»), the typo
 * «untill», and «before» («no games before 6»).
 */
const EN_UNTIL: ReadonlySet<string> = new Set(['until', 'till', 'til', 'untill', 'before']);

/**
 * «hasta», its texting spelling «asta», «de aquí a» and the English `EN_UNTIL` words.
 * Returns the index after it and whether it was English.
 */
function untilWordEnd(
  tokens: readonly Token[],
  i: number,
): { end: number; english: boolean } | null {
  const word = normAt(tokens, i);
  if (EN_UNTIL.has(word)) return { end: i + 1, english: true };
  if (word === 'hasta' || word === 'asta') {
    const que = nextNorm(tokens, i + 1);
    if ((que === 'que' || que === 'q' || que === 'k') && UNTIL_VERBS.has(nextNorm(tokens, i + 2))) {
      return { end: i + 3, english: false };
    }
    return { end: i + 1, english: false };
  }
  const here = nextNorm(tokens, i + 1);
  if (word === 'de' && (here === 'aqui' || here === 'aki') && nextNorm(tokens, i + 2) === 'a') {
    return { end: i + 3, english: false };
  }
  return null;
}

/** Minutes of the day of `mediodía`, `noon`, `medianoche`, `midnight`… */
const NAMED_TIMES: ReadonlyMap<string, number> = new Map([
  ['mediodia', 12 * 60],
  ['noon', 12 * 60],
  ['midday', 12 * 60],
  ['medianoche', MINUTES_PER_DAY],
  ['midnight', MINUTES_PER_DAY],
]);

/** «end of the day», «the end of day»: the index after it, or null. */
function endOfDayEnd(tokens: readonly Token[], k: number): number | null {
  let j = k;
  if (nextNorm(tokens, j) === 'the') j += 1;
  if (nextNorm(tokens, j) !== 'end' || nextNorm(tokens, j + 1) !== 'of') return null;
  j += 2;
  if (nextNorm(tokens, j) === 'the') j += 1;
  return nextNorm(tokens, j) === 'day' ? j + 1 : null;
}

/**
 * English minutes said before the hour: «half past 8», «(a) quarter to 9», «10 past 8»,
 * «twenty to nine», «5 minutes to 8». Returns the minutes to add and where the hour is.
 */
function spokenBeforeHour(
  tokens: readonly Token[],
  j: number,
): { offset: number; hourAt: number } | null {
  let k = j;
  if (nextNorm(tokens, k) === 'a' && nextNorm(tokens, k + 1) === 'quarter') k += 1;
  const word = nextNorm(tokens, k);
  let minutes: number;
  let end = k + 1;
  if (word === 'half') minutes = 30;
  else if (word === 'quarter') minutes = 15;
  else {
    if (word === '') return null;
    const amount = parseAmount(tokens, k);
    if (!amount || !Number.isInteger(amount.value) || amount.value < 1 || amount.value > 59) {
      return null;
    }
    minutes = amount.value;
    end = amount.end;
    if (isMinuteUnit(nextNorm(tokens, end))) end += 1;
  }
  const link = nextNorm(tokens, end);
  const sign =
    link === 'past' || link === 'after' ? 1 : ['to', 'til', 'till'].includes(link) ? -1 : 0;
  if (sign === 0 || (word === 'half' && sign < 0)) return null;
  return { offset: minutes * sign, hourAt: end + 1 };
}

/**
 * A part of the day said before the clock: «until tonight at 11», «until tomorrow morning
 * at 8», «until this evening at 9». Returns the period and the index after it (and after
 * «at»), or null.
 */
function periodBefore(
  tokens: readonly Token[],
  j: number,
  tomorrow: boolean,
): { period: Period; end: number } | null {
  const found = periodAt(tokens, j, tomorrow);
  if (!found.period || found.end === j) return null;
  // Only the English forms: «esta noche a las 11» is not a Spanish word order we read.
  if (
    !['tonight', 'this', 'morning', 'afternoon', 'evening', 'night'].includes(normAt(tokens, j))
  ) {
    return null;
  }
  const end = nextNorm(tokens, found.end) === 'at' ? found.end + 1 : found.end;
  return { period: found.period, end };
}

/** «o'clock» (split by the apostrophe) or «oclock» after an English hour. */
function oclockEnd(tokens: readonly Token[], j: number): number {
  if (nextNorm(tokens, j) === 'oclock') return j + 1;
  return nextNorm(tokens, j) === 'o' && nextNorm(tokens, j + 1) === 'clock' ? j + 2 : j;
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
 * «until eight thirty», «until nine fifteen»: minutes in words after an hour in words.
 * Returns the minute and the index after it, or null.
 */
function wordMinutes(tokens: readonly Token[], j: number): { minute: number; end: number } | null {
  const token = tokens[j];
  if (!token || token.breakBefore || token.type !== 'word') return null;
  const number = parseWordNumber(tokens, j);
  if (!number || number.value < 1 || number.value > 59) return null;
  if (UNIT_WORDS.has(nextNorm(tokens, number.end))) return null;
  return { minute: number.value, end: number.end };
}

interface ClockRead {
  readonly clock: Clock;
  /** Minutes after `clock.hour` (negative for «menos cuarto», «quarter to»). */
  readonly offset: number;
  readonly end: number;
}

/**
 * The hour and minutes of an end time from `tokens[j]`: «las 8 y media», «las 20 30»,
 * «8:30», «half past 8», «quarter to 9», «eight thirty». English minutes said before the
 * hour are tried first; «until 8 to be safe» falls back to a plain «8».
 */
function readClock(tokens: readonly Token[], j: number, english: boolean): ClockRead | null {
  const spoken = english ? spokenBeforeHour(tokens, j) : null;
  if (spoken) {
    const clock = parseClock(tokens, spoken.hourAt, true, true);
    if (clock && !clock.explicitMinutes && clock.hour <= 12) {
      return { clock, offset: spoken.offset, end: clock.end };
    }
  }
  let k = j;
  const article = nextNorm(tokens, k);
  const hasArticle = article === 'las' || article === 'la';
  if (hasArticle) k += 1;
  const clock = parseClock(tokens, k, hasArticle, english);
  if (!clock) return null;
  const numeric = tokens[k]?.type === 'num';
  k = clock.end;
  if (clock.explicitMinutes) return { clock, offset: clock.minute, end: k };
  const plain = !clock.hasSuffix && !clock.meridiem;
  const bare = (hasArticle || english) && numeric && plain ? bareMinutes(tokens, k) : null;
  if (bare) return { clock, offset: bare.minute, end: bare.end };
  const words = english && !numeric && plain ? wordMinutes(tokens, k) : null;
  if (words) return { clock, offset: words.minute, end: words.end };
  const said = spokenMinutes(tokens, k);
  k = said.end;
  if (nextNorm(tokens, k) === 'en' && nextNorm(tokens, k + 1) === 'punto') k += 2;
  return { clock, offset: said.offset, end: k };
}

/**
 * An end time starting at `tokens[i]` («hasta …», «asta …», «de aquí a …», «hasta que
 * sean …»): «hasta las 18:00», «hasta las 8 y media», «hasta las 9 menos cuarto», «hasta las
 * 6 de la tarde», «hasta mañana a las 8», «hasta mediodía», «hasta medianoche», «hasta la
 * una», «hasta las 20 30». In English («until», «till», «before»): «until 8:30 pm», «until
 * 8», «until eight», «till 20:30», «until 6 in the evening», «until 11 tonight», «until
 * tomorrow at 8», «until 8 am tomorrow», «until noon», «until midnight», «until the end of
 * the day», «until half past 8», «until quarter to 9», «until 8 o'clock». A time that
 * already passed today means tomorrow.
 */
export function matchUntil(tokens: readonly Token[], i: number, now: Date): UntilMatch | null {
  const after = untilWordEnd(tokens, i);
  if (after === null) return null;
  const { english } = after;
  let j = after.end;
  let tomorrow = false;
  const first = nextNorm(tokens, j);
  if (first === 'manana' || EN_TOMORROW.has(first)) {
    tomorrow = true;
    j += 1;
    if (nextNorm(tokens, j) === 'a' || nextNorm(tokens, j) === 'at') j += 1;
  }

  let k = j;
  if (['el', 'la', 'the'].includes(nextNorm(tokens, k))) k += 1;
  const named = NAMED_TIMES.get(nextNorm(tokens, k));
  const endOfDay = named === undefined ? endOfDayEnd(tokens, j) : null;
  if (named !== undefined || endOfDay !== null) {
    const day = trailingDay(tokens, endOfDay ?? k + 1);
    const minuteOfDay = named ?? MINUTES_PER_DAY;
    const { endsAt, warnings } = resolve(now, [minuteOfDay], tomorrow || day.tomorrow);
    return { start: i, end: day.end, endsAt, warnings };
  }

  const before = english ? periodBefore(tokens, j, tomorrow) : null;
  if (before) j = before.end;
  const read = readClock(tokens, j, english);
  if (!read) return null;
  const { clock, offset } = read;
  j = read.end;
  if (english) j = oclockEnd(tokens, j);
  if (!clock.hasSuffix && HOUR_SUFFIXES.has(nextNorm(tokens, j))) j += 1;
  let period = periodAt(tokens, j);
  j = period.end;
  const day = trailingDay(tokens, j);
  j = day.end;
  if (!period.period && day.end > period.end) {
    // «8 tomorrow morning», «8 tomorrow night».
    period = periodAt(tokens, j, true);
    j = period.end;
  }
  const namedPeriod = period.period ?? before?.period;

  const hours = candidateHours(clock, namedPeriod);
  const minutesOfDay = hours.map((hour) => hour * 60 + offset);
  const said = namedPeriod ?? clock.meridiem;
  const earlyPeriod = said !== undefined && EARLY_PERIODS.has(said);
  const { endsAt, warnings } = resolve(now, minutesOfDay, tomorrow || day.tomorrow, earlyPeriod);
  return { start: i, end: j, endsAt, warnings };
}
