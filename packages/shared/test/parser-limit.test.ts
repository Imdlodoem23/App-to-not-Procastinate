// Fixed time zone before any Date is created: «hasta las 20:30» means Madrid time.
process.env.TZ = 'Europe/Madrid';

import { describe, expect, it } from 'vitest';
import { GUARDIAN_LIMITS } from '../src/guardian-api';
import { SHARED_EN, SHARED_ES } from '../src/i18n';
import {
  PARSER_EN,
  PARSER_ES,
  PARSER_LIMITS,
  dailyLabel,
  daysLabel,
  parseIntent,
  type ParseChipKind,
  type ParseResult,
} from '../src/parser';

/** Monday 28 September 2026, 16:42 in Madrid (CEST, UTC+2). */
const NOW = new Date(2026, 8, 28, 16, 42);

/** Parses `text` and checks the invariants every result must keep. */
function parse(text: string, locale: 'es' | 'en' = 'es'): ParseResult {
  const result = parseIntent(text, { now: NOW, locale });
  let previous = -1;
  for (const chip of result.chips) {
    expect(chip.start).toBeGreaterThanOrEqual(0);
    expect(chip.end).toBeGreaterThan(chip.start);
    expect(chip.end).toBeLessThanOrEqual(text.length);
    expect(chip.start).toBeGreaterThanOrEqual(previous);
    expect(chip.label.length).toBeGreaterThan(0);
    previous = chip.start;
  }
  // Chips never overlap.
  const chips = [...result.chips].sort((a, b) => a.start - b.start);
  chips
    .slice(1)
    .forEach((chip, n) => expect(chip.start).toBeGreaterThanOrEqual(chips[n]?.end ?? 0));
  if (result.kind === 'limit') {
    expect(result.dailyMinutes).toBeDefined();
    expect(result.durationMinutes).toBeUndefined();
    expect(result.endsAt).toBeUndefined();
    expect(result.task).toBeUndefined();
    expect(result.chips.filter((c) => c.kind === 'daily')).toHaveLength(1);
    expect(result.chips.some((c) => c.kind === 'duration' || c.kind === 'until')).toBe(false);
    expect(result.serviceIds.length + result.categoryIds.length + result.domains.length).toBe(
      result.chips.filter((c) => ['service', 'category', 'domain'].includes(c.kind)).length,
    );
    if (result.days) {
      expect(result.days.length).toBeGreaterThan(0);
      expect([...result.days].sort((a, b) => a - b)).toEqual(result.days);
      expect(new Set(result.days).size).toBe(result.days.length);
    }
  } else {
    expect(result.dailyMinutes).toBeUndefined();
    expect(result.days).toBeUndefined();
    expect(result.chips.some((c) => c.kind === 'daily' || c.kind === 'days')).toBe(false);
    expect(result.warnings).not.toContain('limit_out_of_range');
  }
  if (result.complete) expect(result.unparsed).toEqual([]);
  return result;
}

/** Text covered by the chips of `kind`. */
function chipTexts(text: string, result: ParseResult, kind: ParseChipKind): string[] {
  return result.chips.filter((c) => c.kind === kind).map((c) => text.slice(c.start, c.end));
}

interface Expected {
  services?: string[];
  categories?: string[];
  domains?: string[];
  minutes: number;
  days?: number[];
}

/** A complete daily limit with exactly these targets, minutes and days. */
function expectLimit(text: string, expected: Expected): ParseResult {
  const result = parse(text);
  expect(result, text).toMatchObject({
    kind: 'limit',
    serviceIds: expected.services ?? [],
    categoryIds: expected.categories ?? [],
    domains: expected.domains ?? [],
    dailyMinutes: expected.minutes,
    unparsed: [],
    complete: true,
  });
  expect(result.days, text).toEqual(expected.days);
  expect(result.warnings, text).toEqual([]);
  return result;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];

describe('the phrases of the daily limits brief', () => {
  it('reads the Spanish ones', () => {
    expectLimit('YouTube máximo 30 minutos al día', { services: ['youtube'], minutes: 30 });
    expectLimit('limita Instagram a 1 h al día', { services: ['instagram'], minutes: 60 });
    expectLimit('máx 45 min de TikTok cada día', { services: ['tiktok'], minutes: 45 });
    expectLimit('redes sociales 1 hora al día entre semana', {
      categories: ['social'],
      minutes: 60,
      days: WEEKDAYS,
    });
    expectLimit('YouTube 30 min al día los fines de semana', {
      services: ['youtube'],
      minutes: 30,
      days: WEEKEND,
    });
  });

  it('reads the English ones', () => {
    expectLimit('limit YouTube to 30 min a day', { services: ['youtube'], minutes: 30 });
    expectLimit('YouTube max 1h per day', { services: ['youtube'], minutes: 60 });
    expectLimit('social media 1 hour a day on weekdays', {
      categories: ['social'],
      minutes: 60,
      days: WEEKDAYS,
    });
  });

  it('builds the chips of «redes sociales 1 hora al día entre semana»', () => {
    const text = 'redes sociales 1 hora al día entre semana';
    const result = parse(text);
    expect(result.chips.map((c) => [c.kind, text.slice(c.start, c.end), c.label, c.value])).toEqual(
      [
        ['category', 'redes sociales', 'Redes sociales', 'social'],
        ['daily', '1 hora al día', '1 h al día', '60'],
        ['days', 'entre semana', 'entre semana', '1,2,3,4,5'],
      ],
    );
  });

  it('labels the chips in the UI language only', () => {
    const text = 'social media 1 hour a day on weekdays';
    const es = parse(text, 'es');
    const en = parse(text, 'en');
    expect(en.chips.map((c) => c.label)).toEqual(['Social media', '1 h a day', 'weekdays']);
    expect(es.chips.map((c) => c.label)).toEqual(['Redes sociales', '1 h al día', 'entre semana']);
    const strip = (r: ParseResult): unknown => ({
      ...r,
      chips: r.chips.map(({ label: _label, ...chip }) => chip),
    });
    expect(strip(en)).toEqual(strip(es));
  });
});

describe('ways to say «per day»', () => {
  it.each([
    ['YouTube 30 min al día', 30],
    ['YouTube 30 min al dia', 30],
    ['YouTube 30 min por día', 30],
    ['YouTube 30 min x día', 30],
    ['YouTube 30 min cada día', 30],
    ['YouTube 30 min por cada día', 30],
    ['YouTube 30 min todos los días', 30],
    ['YouTube 30 min a diario', 30],
    ['YouTube 30 minutos diarios', 30],
    ['YouTube 1 hora diaria', 60],
    ['YouTube 2 horas diarias', 120],
    ['YouTube 30 min diariamente', 30],
    ['YouTube 30 min/día', 30],
    ['YouTube 1h/day', 60],
    ['YouTube 30 min a day', 30],
    ['YouTube 30 min per day', 30],
    ['YouTube 30 min each day', 30],
    ['YouTube 30 min every day', 30],
    ['YouTube 30 min every single day', 30],
    ['YouTube 30 min everyday', 30],
    ['YouTube 30 min daily', 30],
    ['YouTube an hour a day', 60],
    ['YouTube half an hour a day', 30],
    ['YouTube 1 hora y media al día', 90],
    ['YouTube hora y media al día', 90],
    ['TikTok media hora al día', 30],
    ['TikTok un cuarto de hora al día', 15],
    ['TikTok veinte minutos al día', 20],
    ['TikTok twenty minutes a day', 20],
    ['TikTok 1h30 al día', 90],
    ['TikTok 1,5 h al día', 90],
  ])('«%s» → %i min', (text, minutes) => {
    const result = expectLimit(text, {
      services: [text.startsWith('TikTok') ? 'tiktok' : 'youtube'],
      minutes,
    });
    expect(chipTexts(text, result, 'daily')).toHaveLength(1);
  });

  it.each([
    ['YouTube como mucho 30 min al día', 30],
    ['YouTube como máximo 30 min al día', 30],
    ['YouTube máximo 30 min al día', 30],
    ['YouTube máx. 30 min al día', 30],
    ['YouTube max 30 min al día', 30],
    ['YouTube hasta 1 hora al día', 60],
    ['YouTube 30 min al día como máximo', 30],
    ['YouTube 30 min al día como mucho', 30],
    ['YouTube 30 min al día máx', 30],
    ['YouTube 30 min como máximo al día', 30],
    ['YouTube 1h max per day', 60],
    ['YouTube at most 30 min a day', 30],
    ['YouTube up to 1 hour a day', 60],
    ['YouTube 30 min a day at most', 30],
    ['YouTube 30 min a day tops', 30],
    ['YouTube 30 min a day max', 30],
    ['no más de 30 min de YouTube al día', 30],
    ['no quiero YouTube más de una hora al día', 60],
    ['no more than 30 min of YouTube a day', 30],
  ])('«%s» keeps its qualifiers out of the result', (text, minutes) => {
    expectLimit(text, { services: ['youtube'], minutes });
  });

  it('reads «per day» before the allowance', () => {
    expectLimit('límite diario de 30 min para YouTube', { services: ['youtube'], minutes: 30 });
    expectLimit('máximo diario de 1 h en Instagram', { services: ['instagram'], minutes: 60 });
    expectLimit('YouTube al día máximo 30 min', { services: ['youtube'], minutes: 30 });
    expectLimit('YouTube todos los días 30 min', { services: ['youtube'], minutes: 30 });
    expectLimit('YouTube cada día 45 minutos', { services: ['youtube'], minutes: 45 });
    expectLimit('daily limit of 30 min for Reddit', { services: ['reddit'], minutes: 30 });
    expectLimit('Reddit daily max 1h', { services: ['reddit'], minutes: 60 });
    expectLimit('every day 1 hour of YouTube', { services: ['youtube'], minutes: 60 });
    // Both markers: the second one is read too.
    expectLimit('daily limit of 30 min per day for Reddit', { services: ['reddit'], minutes: 30 });
  });

  it('reads the targets between the allowance and «per day»', () => {
    const text = 'máx 45 min de TikTok cada día';
    const result = expectLimit(text, { services: ['tiktok'], minutes: 45 });
    // The chip covers the allowance; «cada día» is read but has no chip of its own.
    expect(chipTexts(text, result, 'daily')).toEqual(['45 min']);
    expectLimit('1 hora de redes sociales al día entre semana', {
      categories: ['social'],
      minutes: 60,
      days: WEEKDAYS,
    });
    expectLimit('45 min en Instagram y TikTok al día', {
      services: ['instagram', 'tiktok'],
      minutes: 45,
    });
    expectLimit('30 min de YouTube como máximo al día', { services: ['youtube'], minutes: 30 });
    expectLimit('30 min of YouTube a day', { services: ['youtube'], minutes: 30 });
    expectLimit('at most 45 minutes of TikTok daily', { services: ['tiktok'], minutes: 45 });
    expectLimit('30 min of YouTube and Reddit per day on weekends', {
      services: ['youtube', 'reddit'],
      minutes: 30,
      days: WEEKEND,
    });
  });

  it('reads the limit words', () => {
    expectLimit('limita Instagram a 1 h al día', { services: ['instagram'], minutes: 60 });
    expectLimit('limítame el TikTok a 45 minutos al día', { services: ['tiktok'], minutes: 45 });
    expectLimit('pon un límite de 30 min al día a YouTube', { services: ['youtube'], minutes: 30 });
    expectLimit('ponme un tope de 1 h al día en Twitch', { services: ['twitch'], minutes: 60 });
    expectLimit('limit Instagram to an hour a day', { services: ['instagram'], minutes: 60 });
    expectLimit('cap TikTok at 45 min a day', { services: ['tiktok'], minutes: 45 });
    expectLimit('set a daily limit of 30 min for YouTube', { services: ['youtube'], minutes: 30 });
    expectLimit('only 30 min of YouTube a day', { services: ['youtube'], minutes: 30 });
    // Outside a daily limit they stay unread, as before.
    expect(parse('limita Instagram a 1 h')).toMatchObject({
      kind: 'block',
      durationMinutes: 60,
      unparsed: ['limita'],
      complete: false,
    });
  });

  it('reads every kind of target', () => {
    expectLimit('marca.com 15 min al día', { domains: ['marca.com'], minutes: 15 });
    expectLimit('juegos 1 hora al día', { categories: ['games'], minutes: 60 });
    expectLimit('YouTube y Netflix 2 h al día', { services: ['youtube', 'netflix'], minutes: 120 });
    expectLimit('YouTube, TikTok e Instagram 1 h al día', {
      services: ['youtube', 'tiktok', 'instagram'],
      minutes: 60,
    });
  });

  it('keeps weak aliases where they can only be a target', () => {
    expectLimit('HBO Max 1h al día', { services: ['hbo-max'], minutes: 60 });
    expectLimit('30 min de HBO Max al día', { services: ['hbo-max'], minutes: 30 });
    expectLimit('HBO Max max 1h al día', { services: ['hbo-max'], minutes: 60 });
    // A limit verb anchors «x» and «lol» like a block word.
    expectLimit('limita X a 30 min al día', { services: ['x-twitter'], minutes: 30 });
    expectLimit('limita el lol a 1 h al día', { services: ['league-of-legends'], minutes: 60 });
    expectLimit('sin X 30 min al día', { services: ['x-twitter'], minutes: 30 });
    // Phrase-initial «x» is still nothing.
    expect(parse('x 30 min al día').kind).toBe('unknown');
  });

  it('accepts block words and wishes around the allowance', () => {
    expectLimit('sin redes 1 hora al día', { categories: ['social'], minutes: 60 });
    expectLimit('bloquea YouTube 30 min al día', { services: ['youtube'], minutes: 30 });
    expectLimit('quiero ver YouTube máximo 30 min al día', { services: ['youtube'], minutes: 30 });
    expectLimit('déjame 30 min de Instagram al día', { services: ['instagram'], minutes: 30 });
    expectLimit('no YouTube for 30 min a day', { services: ['youtube'], minutes: 30 });
    expectLimit('I only want YouTube 30 min a day', { services: ['youtube'], minutes: 30 });
  });
});

describe('days', () => {
  it.each([
    ['YouTube 1 h al día entre semana', WEEKDAYS],
    ['YouTube 1 h al día solo entre semana', WEEKDAYS],
    ['YouTube 1 h al día los días entre semana', WEEKDAYS],
    ['YouTube 1 h al día en días laborables', WEEKDAYS],
    ['YouTube 1 h al día durante la semana', WEEKDAYS],
    ['YouTube 1 h al día de lunes a viernes', WEEKDAYS],
    ['YouTube 1 h al día lunes a viernes', WEEKDAYS],
    ['YouTube 1 h al día del lunes al viernes', WEEKDAYS],
    ['YouTube 1 h al día desde el lunes hasta el viernes', WEEKDAYS],
    ['YouTube 1 h al día lun-vie', WEEKDAYS],
    ['YouTube 1 h al día los fines de semana', WEEKEND],
    ['YouTube 1 h al día el fin de semana', WEEKEND],
    ['YouTube 1 h al día en fin de semana', WEEKEND],
    ['YouTube 1 h al día el finde', WEEKEND],
    ['YouTube 1 h al día los findes', WEEKEND],
    ['YouTube 1 h al día sábados y domingos', WEEKEND],
    ['YouTube 1 h al día los sábados y los domingos', WEEKEND],
    ['YouTube 1 h al día los lunes', [1]],
    ['YouTube 1 h al día solo los lunes y los miércoles', [1, 3]],
    ['YouTube 1 h al día lunes, miércoles y viernes', [1, 3, 5]],
    ['YouTube 1 h al día de viernes a domingo', [5, 6, 7]],
    ['YouTube 1 h al día domingo a martes', [1, 2, 7]],
    ['YouTube 1 hour a day on weekdays', WEEKDAYS],
    ['YouTube 1 hour a day weekdays only', WEEKDAYS],
    ['YouTube 1 hour a day during the week', WEEKDAYS],
    ['YouTube 1 hour a day on workdays', WEEKDAYS],
    ['YouTube 1 hour a day Monday to Friday', WEEKDAYS],
    ['YouTube 1 hour a day from Monday through Friday', WEEKDAYS],
    ['YouTube 1 hour a day mon-fri', WEEKDAYS],
    ['YouTube 1 hour a day on weekends', WEEKEND],
    ['YouTube 1 hour a day at the weekend', WEEKEND],
    ['YouTube 1 hour a day on Saturdays and Sundays', WEEKEND],
    ['YouTube 1 hour a day sat and sun', WEEKEND],
    ['YouTube 1 hour a day on Mondays', [1]],
    ['YouTube 1 hour a day on Mondays and Wednesdays', [1, 3]],
    ['YouTube 1 hour a day Monday, Wednesday and Friday', [1, 3, 5]],
  ])('«%s»', (text, days) => {
    const result = expectLimit(text, { services: ['youtube'], minutes: 60, days });
    expect(result.chips.filter((c) => c.kind === 'days').length).toBeGreaterThan(0);
  });

  it('reads days before the allowance too', () => {
    expectLimit('entre semana YouTube 30 min al día', {
      services: ['youtube'],
      minutes: 30,
      days: WEEKDAYS,
    });
    expectLimit('on weekends, Reddit 20 min each day', {
      services: ['reddit'],
      minutes: 20,
      days: WEEKEND,
    });
  });

  it('joins several days phrases', () => {
    const text = 'YouTube 30 min al día los lunes y el finde';
    const result = expectLimit(text, { services: ['youtube'], minutes: 30, days: [1, 6, 7] });
    expect(chipTexts(text, result, 'days').length).toBeGreaterThan(0);
  });

  it('gives each days chip its days as a value', () => {
    const text = 'YouTube 30 min al día de viernes a domingo';
    const result = parse(text);
    const chip = result.chips.find((c) => c.kind === 'days');
    expect(chip).toMatchObject({ value: '5,6,7', label: 'de viernes a domingo' });
    expect(text.slice(chip?.start, chip?.end)).toBe('de viernes a domingo');
  });

  it('leaves alone short names that are other words', () => {
    // «mar» (sea, or «martes»?) alone is not read.
    expect(parse('YouTube 30 min al día, mar')).toMatchObject({
      kind: 'limit',
      unparsed: ['mar'],
      complete: false,
    });
    expect(parse('YouTube 30 min a day on sat')).toMatchObject({
      kind: 'limit',
      unparsed: ['on sat'],
      complete: false,
    });
  });

  it('never reads days outside a daily limit', () => {
    expect(parse('no YouTube 1 h los lunes')).toMatchObject({
      kind: 'block',
      durationMinutes: 60,
      unparsed: ['lunes'],
      complete: false,
    });
    expect(parse('block YouTube for 1 hour on weekdays')).toMatchObject({
      kind: 'block',
      durationMinutes: 60,
      complete: false,
    });
  });
});

describe('warnings and completeness', () => {
  it('keeps an allowance out of range as typed, with a warning', () => {
    for (const [text, minutes] of [
      ['YouTube 2 min al día', 2],
      ['YouTube 4 minutos al día', 4],
      ['YouTube 13 horas al día', 780],
      ['YouTube 2 days a day', 2880],
    ] as const) {
      const result = parse(text);
      expect(result, text).toMatchObject({
        kind: 'limit',
        dailyMinutes: minutes,
        warnings: ['limit_out_of_range'],
        complete: true,
      });
    }
  });

  it('accepts the bounds of the guardian', () => {
    expect(PARSER_LIMITS.minDailyMinutes).toBe(GUARDIAN_LIMITS.limitMinMinutes);
    expect(PARSER_LIMITS.maxDailyMinutes).toBe(GUARDIAN_LIMITS.limitMaxMinutes);
    expectLimit('YouTube 5 min al día', { services: ['youtube'], minutes: 5 });
    expectLimit('YouTube 12 horas al día', { services: ['youtube'], minutes: 720 });
  });

  it('never gives a limit the block warnings', () => {
    expect(parse('YouTube 2 min al día').warnings).not.toContain('too_short');
    expect(parse('YouTube 2 days a day').warnings).not.toContain('over_24h');
  });

  it('is incomplete when something is left over', () => {
    expect(parse('YouTube 1h al día entre semana y 2h los findes')).toMatchObject({
      kind: 'limit',
      dailyMinutes: 60,
      unparsed: ['2h'],
      complete: false,
    });
    expect(parse('YouTube 30 min al día cuando esté en clase')).toMatchObject({
      kind: 'limit',
      complete: false,
    });
    expect(parse('YouTube 30 min al día menos los domingos').complete).toBe(false);
  });
});

describe('phrases that are not a daily limit', () => {
  it('keeps «YouTube 30 min» and friends as blocks', () => {
    expect(parse('YouTube 30 min')).toMatchObject({
      kind: 'block',
      durationMinutes: 30,
      complete: true,
    });
    expect(parse('no YouTube 2h máx')).toMatchObject({ kind: 'block', durationMinutes: 120 });
    expect(parse('sin redes 2 días')).toMatchObject({ kind: 'block', durationMinutes: 2880 });
    expect(parse('block YouTube for a day')).toMatchObject({
      kind: 'block',
      durationMinutes: 1440,
      complete: true,
    });
    expect(parse('no YouTube for an hour')).toMatchObject({ kind: 'block', durationMinutes: 60 });
    expect(parse('sin TikTok todo el día').kind).not.toBe('limit');
  });

  it('keeps block phrases with the words of a limit as they were', () => {
    // «al día siguiente» is not «per day».
    expect(parse('YouTube 30 min al día siguiente')).toMatchObject({
      kind: 'block',
      durationMinutes: 30,
      unparsed: ['día siguiente'],
      complete: false,
    });
    expect(parse('no YouTube for a day or two').kind).not.toBe('limit');
    expect(parse('YouTube al día siguiente 2 h').kind).not.toBe('limit');
  });

  it('keeps study phrases as they were', () => {
    const result = parse('estudiar 1 hora al día');
    expect(result).toMatchObject({ kind: 'study', durationMinutes: 60 });
    expect(parse('study math 1 hour a day').kind).toBe('study');
  });

  it('never turns an unblock request into a limit', () => {
    for (const text of [
      'desbloquea YouTube 30 min al día',
      'no limites YouTube a 30 min al día',
      'quita el límite de 30 min al día de YouTube',
      "don't limit YouTube to 30 min a day",
      'remove the daily limit of 30 min on YouTube',
      'quita el límite diario de 30 min de YouTube',
    ]) {
      expect(parse(text).kind, text).toBe('unknown');
    }
  });

  it('needs a target', () => {
    const result = parse('30 min al día');
    expect(result.kind).toBe('unknown');
    expect(result.complete).toBe(false);
    expect(parse('limit 1 hour a day').kind).toBe('unknown');
  });

  it('needs the allowance to be the first time typed', () => {
    const result = parse('YouTube hasta las 20:00 y 30 min al día');
    expect(result.kind).not.toBe('limit');
    expect(result.complete).toBe(false);
  });
});

describe('labels', () => {
  it('formats a daily allowance', () => {
    expect(dailyLabel(30)).toBe('30 min al día');
    expect(dailyLabel(90)).toBe('1 h 30 min al día');
    expect(dailyLabel(60, 'en')).toBe('1 h a day');
    expect(PARSER_ES.perDay('45 min')).toBe('45 min al día');
    expect(PARSER_EN.perDay('45 min')).toBe('45 min a day');
  });

  it.each([
    [[1, 2, 3, 4, 5, 6, 7], 'todos los días', 'every day'],
    [[], 'todos los días', 'every day'],
    [[1, 2, 3, 4, 5], 'entre semana', 'weekdays'],
    [[7, 6, 6], 'fines de semana', 'weekends'],
    [[1], 'lunes', 'Monday'],
    [[1, 3], 'lunes y miércoles', 'Monday and Wednesday'],
    [[1, 3, 5], 'lunes, miércoles y viernes', 'Monday, Wednesday, and Friday'],
    [[1, 2, 3, 4], 'de lunes a jueves', 'Monday to Thursday'],
    [[5, 6, 7], 'de viernes a domingo', 'Friday to Sunday'],
    [[7, 1, 2], 'de domingo a martes', 'Sunday to Tuesday'],
    [[1, 2, 6], 'lunes, martes y sábado', 'Monday, Tuesday, and Saturday'],
    [[6, 7, 1, 2, 3, 4], 'de sábado a jueves', 'Saturday to Thursday'],
    [[1, 2, 0, 9, 1.5], 'lunes y martes', 'Monday and Tuesday'],
  ])('%j → «%s», «%s»', (days, es, en) => {
    expect(daysLabel(days)).toBe(es);
    expect(daysLabel(days, 'en')).toBe(en);
  });

  it('has the same parser strings in both languages', () => {
    expect(Object.keys(PARSER_EN).sort()).toEqual(Object.keys(PARSER_ES).sort());
    expect(PARSER_ES.weekdayNames).toHaveLength(7);
    expect(PARSER_EN.weekdayNames).toHaveLength(7);
  });
});

describe('shared daily limit strings', () => {
  const es = SHARED_ES.dailyLimits;
  const en = SHARED_EN.dailyLimits;

  it('has the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it('names the feature', () => {
    expect(es.title).toBe('Límite diario');
    expect(es.sectionTitle).toBe('Límites diarios');
    expect(en.title).toBe('Daily limit');
    expect(en.sectionTitle).toBe('Daily limits');
    expect(es.blockedUntilTomorrow).toBe('Bloqueado hasta mañana');
    expect(en.blockedUntilTomorrow).toBe('Blocked until tomorrow');
  });

  it('formats the allowance and its days like the chips', () => {
    expect(es.perDay(30)).toBe('30 min al día');
    expect(en.perDay(30)).toBe('30 min a day');
    expect(es.days([1, 2, 3, 4, 5])).toBe('entre semana');
    expect(en.days([6, 7])).toBe('weekends');
  });

  it('shows today’s progress', () => {
    expect(es.usedToday(12, 30)).toBe('12 de 30 min hoy');
    expect(en.usedToday(12, 30)).toBe('12 of 30 min today');
    expect(es.usedToday(12.9, 30)).toBe('12 de 30 min hoy');
    expect(es.usedToday(-1, 30)).toBe('0 de 30 min hoy');
    expect(es.usedToday(70, 120)).toBe('1 h 10 min de 2 h hoy');
    expect(en.usedToday(45, 90)).toBe('45 min of 1 h 30 min today');
  });

  it('writes the notifications, the blocked page and the card', () => {
    expect(es.warning('YouTube', 5)).toBe('Te quedan 5 min de YouTube hoy');
    expect(en.warning('YouTube', 5)).toBe('You have 5 min of YouTube left today');
    expect(es.reached('YouTube', 30)).toBe('Has gastado tus 30 min de YouTube de hoy');
    expect(en.reached('YouTube', 30)).toBe("You've used up your 30 min of YouTube for today");
    expect(es.blockedPage('YouTube', 30)).toBe(
      'Has usado tus 30 min de YouTube de hoy. Vuelve mañana.',
    );
    expect(en.blockedPage('YouTube', 30)).toBe(
      "You've used your 30 min of YouTube for today. Come back tomorrow.",
    );
    expect(es.blockCard('YouTube', '0:00')).toBe(
      'Límite diario de YouTube: bloqueado hasta las 0:00',
    );
    expect(en.blockCard('YouTube', 'midnight')).toBe(
      'Daily limit for YouTube: blocked until midnight',
    );
  });
});
