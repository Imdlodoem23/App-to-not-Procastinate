// Fixed time zone before any Date is created: «hasta las 20:30» means Madrid time.
process.env.TZ = 'Europe/Madrid';

import { describe, expect, it } from 'vitest';
import { findCategoryByAlias, findServiceByAlias, getCategory, getService } from '../src/catalog';
import {
  PARSER_EXTRA_ALIASES,
  PARSER_LIMITS,
  durationLabel,
  notUnderstoodMessage,
  parseIntent,
  untilLabel,
  type ParseResult,
  type ParseWarning,
} from '../src/parser';

/** Monday 28 September 2026, 16:42 in Madrid (CEST, UTC+2). */
const NOW = new Date(2026, 8, 28, 16, 42);

/** Local instant in September 2026 as ISO, e.g. at(28, 20, 30). */
const at = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 8, day, hour, minute).toISOString();

/** Parses `text` and checks the invariants every result must keep. */
function parse(text: string, now: Date = NOW): ParseResult {
  const result = parseIntent(text, { now });
  let previous = -1;
  for (const chip of result.chips) {
    expect(chip.start).toBeGreaterThanOrEqual(0);
    expect(chip.end).toBeGreaterThan(chip.start);
    expect(chip.end).toBeLessThanOrEqual(text.length);
    expect(chip.start).toBeGreaterThanOrEqual(previous);
    expect(chip.label.length).toBeGreaterThan(0);
    previous = chip.start;
  }
  expect(new Set(result.serviceIds).size).toBe(result.serviceIds.length);
  expect(new Set(result.categoryIds).size).toBe(result.categoryIds.length);
  for (const id of result.serviceIds) expect(getService(id)).toBeDefined();
  for (const id of result.categoryIds) expect(getCategory(id)).toBeDefined();
  expect(result.durationMinutes === undefined).toBe(result.endsAt === undefined);
  if (result.complete) {
    expect(result.unparsed).toEqual([]);
    expect(result.durationMinutes).toBeDefined();
    expect(result.kind).not.toBe('unknown');
  }
  if (result.kind !== 'study') expect(result.task).toBeUndefined();
  return result;
}

const sorted = (warnings: readonly ParseWarning[]): ParseWarning[] => [...warnings].sort();

/** Text covered by the chips of `kind`. */
function chipTexts(text: string, result: ParseResult, kind: string): string[] {
  return result.chips.filter((c) => c.kind === kind).map((c) => text.slice(c.start, c.end));
}

describe('test setup', () => {
  it('runs in Europe/Madrid', () => {
    expect(NOW.getTimezoneOffset()).toBe(-120);
    expect(at(28, 20, 30)).toBe('2026-09-28T18:30:00.000Z');
  });
});

describe('the six phrases of PROMPT.md section 4', () => {
  it('«no veo YouTube en una hora» → YouTube, 60 min', () => {
    const text = 'no veo YouTube en una hora';
    const result = parse(text);
    expect(result).toEqual({
      kind: 'block',
      serviceIds: ['youtube'],
      categoryIds: [],
      domains: [],
      durationMinutes: 60,
      endsAt: at(28, 17, 42),
      chips: [
        { kind: 'service', label: 'YouTube', value: 'youtube', start: 7, end: 14 },
        { kind: 'duration', label: '1 h', value: '60', start: 15, end: 26 },
      ],
      unparsed: [],
      warnings: [],
      complete: true,
    });
    expect(chipTexts(text, result, 'duration')).toEqual(['en una hora']);
  });

  it('«nada de TikTok ni Instagram durante 45 minutos» → TikTok + Instagram, 45 min', () => {
    const result = parse('nada de TikTok ni Instagram durante 45 minutos');
    expect(result).toMatchObject({
      kind: 'block',
      serviceIds: ['tiktok', 'instagram'],
      categoryIds: [],
      durationMinutes: 45,
      endsAt: at(28, 17, 27),
      unparsed: [],
      warnings: [],
      complete: true,
    });
  });

  it('«bloquea las redes sociales hasta las 20:30» → Redes sociales, until 20:30', () => {
    const text = 'bloquea las redes sociales hasta las 20:30';
    const result = parse(text);
    expect(result).toMatchObject({
      kind: 'block',
      serviceIds: [],
      categoryIds: ['social'],
      durationMinutes: 228,
      endsAt: at(28, 20, 30),
      warnings: [],
      complete: true,
    });
    expect(chipTexts(text, result, 'category')).toEqual(['redes sociales']);
    expect(result.chips.find((c) => c.kind === 'until')).toMatchObject({
      label: 'hasta 20:30',
      value: at(28, 20, 30),
    });
  });

  it('«sin juegos hora y media» → Juegos, 90 min', () => {
    const result = parse('sin juegos hora y media');
    expect(result).toMatchObject({
      kind: 'block',
      categoryIds: ['games'],
      durationMinutes: 90,
      complete: true,
    });
    expect(result.chips.find((c) => c.kind === 'category')?.label).toBe('Juegos');
  });

  it('«no quiero ver Netflix 2h» → Netflix, 120 min', () => {
    expect(parse('no quiero ver Netflix 2h')).toMatchObject({
      kind: 'block',
      serviceIds: ['netflix'],
      durationMinutes: 120,
      complete: true,
    });
  });

  it('«estudiar mates 1 hora» → Study Mode, 60 min, task «mates»', () => {
    const text = 'estudiar mates 1 hora';
    const result = parse(text);
    expect(result).toMatchObject({
      kind: 'study',
      serviceIds: [],
      categoryIds: [],
      durationMinutes: 60,
      task: 'mates',
      unparsed: [],
      complete: true,
    });
    expect(chipTexts(text, result, 'task')).toEqual(['mates']);
  });
});

describe('durations', () => {
  it.each([
    ['no veo youtube en 1 hora', 60],
    ['no veo youtube media hora', 30],
    ['sin tiktok hora y media', 90],
    ['sin juegos un cuarto de hora', 15],
    ['sin juegos tres cuartos de hora', 45],
    ['no veo youtube 90 min', 90],
    ['no veo youtube 90 minutos', 90],
    ['no veo youtube 2h', 120],
    ['no veo youtube 2 h', 120],
    ['no veo youtube 2 horas', 120],
    ['no veo youtube 1h30', 90],
    ['no veo youtube 1h 30min', 90],
    ['sin series durante 1:30', 90],
    ['sin tiktok 45 minutos', 45],
    ['no veo youtube una hora y cuarto', 75],
    ['nada de netflix dos horas y media', 150],
    ['sin tiktok cuarenta y cinco minutos', 45],
    ['no veo youtube noventa minutos', 90],
    ['sin twitch diez minutos', 10],
    ['sin twitch quince minutos', 15],
    // «veinte minutos» is also the newspaper 20minutos; alone it is a duration.
    ['sin twitch veinte minutos', 20],
    ['sin twitch treinta minutos', 30],
    ['sin reddit cinco minutos', 5],
    ['no veo youtube tres horas', 180],
    ['sin redes cuatro horas', 240],
    ['sin redes ciento veinte minutos', 120],
    ['no veo youtube 1 h y 15 min', 75],
    ['no veo youtube 1 hora 30 minutos', 90],
    ['no veo youtube 1,5 horas', 90],
    ['no veo youtube 1.5h', 90],
    ['no veo youtube 2hrs', 120],
    ['no veo youtube una horita', 60],
    ['no veo youtube media horita', 30],
    ['sin redes un par de horas', 120],
    ['sin redes durante las próximas dos horas', 120],
    ['sin redes por 2 horas', 120],
    ['sin redes unos 20 min', 20],
    ['sin series 1 hora y tres cuartos', 105],
    ['sin juegos 1 hora y 20', 80],
    ['sin crunchyroll 1 h 45 min', 105],
    ['sin twitch dos horas y cuarto', 135],
    ['no veo youtube en una hora y media', 90],
  ])('%s → %i min', (text, minutes) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.durationMinutes).toBe(minutes);
    expect(result.endsAt).toBe(new Date(NOW.getTime() + minutes * 60_000).toISOString());
    expect(result.unparsed).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.chips.filter((c) => c.kind === 'duration')).toHaveLength(1);
  });

  it('labels duration chips in Spanish', () => {
    expect(parse('sin redes 45 min').chips[1]).toMatchObject({ label: '45 min', value: '45' });
    expect(parse('sin redes 1h30').chips[1]).toMatchObject({ label: '1 h 30 min', value: '90' });
  });
});

describe('end times («hasta…») with now = Monday 16:42', () => {
  it.each<[string, string, number, ParseWarning[]]>([
    ['sin redes hasta las 18:00', at(28, 18), 78, []],
    ['sin redes hasta las 20:30', at(28, 20, 30), 228, []],
    ['no veo youtube hasta las 8', at(28, 20), 198, ['ambiguous_time']],
    ['no veo youtube hasta las 8 y media', at(28, 20, 30), 228, ['ambiguous_time']],
    ['no veo youtube hasta las 8 y 10', at(28, 20, 10), 208, ['ambiguous_time']],
    ['sin redes hasta mañana a las 8', at(29, 8), 918, []],
    ['sin redes hasta las 6 de la tarde', at(28, 18), 78, []],
    ['sin redes hasta mediodía', at(29, 12), 1158, ['past_time']],
    ['sin redes hasta mañana a mediodía', at(29, 12), 1158, []],
    ['sin redes hasta medianoche', at(29, 0), 438, []],
    ['sin redes hasta las 00:00', at(29, 0), 438, []],
    ['sin redes hasta las 12', at(29, 0), 438, ['ambiguous_time']],
    ['sin redes hasta las 16:00', at(29, 16), 1398, ['past_time']],
    ['sin redes hasta las 08:00', at(29, 8), 918, ['past_time']],
    ['sin redes hasta la una', at(29, 1), 498, ['ambiguous_time', 'past_time']],
    ['sin tiktok hasta las 9 menos cuarto', at(28, 20, 45), 243, ['ambiguous_time']],
    ['sin tiktok hasta las diez de la noche', at(28, 22), 318, []],
    ['no me dejes ver twitch hasta las once menos cuarto', at(28, 22, 45), 363, ['ambiguous_time']],
    ['sin redes hasta las 20h', at(28, 20), 198, []],
    ['sin redes hasta las 18h30', at(28, 18, 30), 108, []],
    ['sin redes hasta las 6pm', at(28, 18), 78, []],
    ['sin roblox ni minecraft hasta las 19', at(28, 19), 138, []],
    // «de la mañana» said in the afternoon: tomorrow is what the user meant, no warning.
    ['no veo youtube ni tiktok hasta las 8 de la mañana', at(29, 8), 918, []],
    ['sin netflix hasta mañana a las 20:00', at(29, 20), 1638, ['over_24h']],
  ])('%s', (text, endsAt, minutes, warnings) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.endsAt).toBe(endsAt);
    expect(result.durationMinutes).toBe(minutes);
    expect(sorted(result.warnings)).toEqual(sorted(warnings));
    expect(result.complete).toBe(true);
    const chip = result.chips.find((c) => c.kind === 'until');
    expect(chip?.value).toBe(endsAt);
    expect(text.slice(chip?.start, chip?.end).toLowerCase().startsWith('hasta')).toBe(true);
  });

  it('labels until chips with «mañana» when the end is tomorrow', () => {
    expect(parse('sin redes hasta mañana a las 8').chips[1]?.label).toBe('hasta mañana 08:00');
    expect(parse('sin redes hasta las 20:30').chips[1]?.label).toBe('hasta 20:30');
    expect(parse('sin redes hasta medianoche').chips[1]?.label).toBe('hasta 00:00');
  });

  it('rounds the derived duration up to the minute', () => {
    const now = new Date(2026, 8, 28, 16, 42, 30);
    const result = parse('sin redes hasta las 18:00', now);
    expect(result.durationMinutes).toBe(78);
    expect(result.endsAt).toBe(at(28, 18));
  });

  it('uses wall-clock time across the end of summer time', () => {
    // 25 October 2026: clocks go back from 03:00 CEST to 02:00 CET.
    const now = new Date(2026, 9, 24, 22, 0);
    const result = parse('sin redes hasta mañana a las 8', now);
    expect(result.endsAt).toBe(new Date(2026, 9, 25, 8, 0).toISOString());
    expect(result.durationMinutes).toBe(11 * 60);
  });
});

describe('targets: services, categories, lists and colloquial forms', () => {
  it.each<[string, string[], string[]]>([
    ['bloquéame twitch y kick hasta las 23:00', ['twitch', 'kick'], []],
    ['quítame el insta media hora', ['instagram'], []],
    ['paso de instagram 1h', ['instagram'], []],
    ['fuera tiktok 30 min', ['tiktok'], []],
    ['cero redes hasta las 10 de la noche', [], ['social']],
    ['prohibido youtube 2 horas', ['youtube'], []],
    ['no me dejes entrar en reddit 45 min', ['reddit'], []],
    ['ni youtube ni twitch 1 hora', ['youtube', 'twitch'], []],
    ['sin Disney+ ni HBO Max 3h', ['disney-plus', 'hbo-max'], []],
    ['sin prime video ni movistar+ 2h', ['prime-video', 'movistar-plus'], []],
    ['no veo vídeos de youtube 1h', ['youtube'], []],
    ['no veo pelis ni series de netflix 2h', ['netflix'], ['video']],
    ['no juego al lol 2h', ['league-of-legends'], []],
    ['no juegues a roblox 1h', ['roblox'], []],
    ['no quiero jugar 1h', [], ['games']],
    ['no veo x 1h', ['x-twitter'], []],
    ['nada de redes ni juegos durante 2 horas', [], ['social', 'games']],
    ['olvídate de las redes 3 horas', [], ['social']],
    ['adiós a tiktok 1h', ['tiktok'], []],
    ['déjame sin youtube 1h', ['youtube'], []],
    ['no veo YouTube, TikTok e Instagram hasta las 22:30', ['youtube', 'tiktok', 'instagram'], []],
    ['youtube, tiktok e instagram 2h', ['youtube', 'tiktok', 'instagram'], []],
    ['fuera redes y juegos 2 horas', [], ['social', 'games']],
    ['bloquea steam 1h', ['steam'], []],
    ['sin mensajes ni whatsapp 30 minutos', ['whatsapp'], ['messaging']],
    ['nada de shein ni temu hasta mañana a las 9', ['shein', 'temu'], []],
    ['sin el mundo ni el país 1h', ['el-mundo', 'el-pais'], []],
    ['no leo marca 30 min', ['marca'], []],
    ['bloquea youtube + tiktok 1h', ['youtube', 'tiktok'], []],
    ['sin yt ni insta ni tik tok hasta las 20:00', ['youtube', 'instagram', 'tiktok'], []],
    ['sin RR.SS. hasta las 21:00', [], ['social']],
    ['nada de compras online ni noticias 1h', [], ['shopping', 'news']],
    ['sin whatsapp web 1h', ['whatsapp'], []],
    ['no veo series ni pelis 2h', [], ['video']],
    ['sin streaming 1h', [], ['video']],
    ['sin videojuegos 1h', [], ['games']],
    ['bloquea discord y telegram 45 min', ['discord', 'telegram'], []],
    ['sin redes sociales ni juegos online hasta las 21:15', [], ['social', 'games']],
    ['NO VEO YOUTUBE 1H', ['youtube'], []],
    ['no veo tiktoks 1h', ['tiktok'], []],
    // With another duration, «20 minutos» is the newspaper.
    ['nada de 20 minutos ni marca 1h', ['20minutos', 'marca'], []],
  ])('%s', (text, serviceIds, categoryIds) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.categoryIds).toEqual(categoryIds);
    expect(result.domains).toEqual([]);
    expect(result.unparsed).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('labels target chips with catalog names and spans the typed words', () => {
    const text = 'sin Disney+ ni HBO Max 3h';
    const result = parse(text);
    expect(result.chips.filter((c) => c.kind === 'service').map((c) => c.label)).toEqual([
      'Disney+',
      'HBO Max',
    ]);
    expect(chipTexts(text, result, 'service')).toEqual(['Disney+', 'HBO Max']);
    expect(chipTexts('sin yt ni tik tok 1h', parse('sin yt ni tik tok 1h'), 'service')).toEqual([
      'yt',
      'tik tok',
    ]);
  });
});

describe('typos', () => {
  it.each<[string, string[], string[]]>([
    ['no veo yutube 1h', ['youtube'], []],
    ['nada de instagarm 30 min', ['instagram'], []],
    ['no veo youtbue 2h', ['youtube'], []],
    ['no veo youtubee 1h', ['youtube'], []],
    ['sin discrod 1h', ['discord'], []],
    ['sin netflx ni disnei 2h', ['netflix', 'disney-plus'], []],
    ['bloquea tiktokk 1h', ['tiktok'], []],
    ['sin twiter 1h', ['x-twitter'], []],
    ['sin wasap 1h', ['whatsapp'], []],
    ['no veo tik-tok 1h', ['tiktok'], []],
    ['sin redes socales 1h', [], ['social']],
    ['sin notiicas 1h', [], ['news']],
  ])('%s', (text, serviceIds, categoryIds) => {
    const result = parse(text);
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.categoryIds).toEqual(categoryIds);
    expect(result.complete).toBe(true);
  });

  it('merges a typo continuing the same target into one chip', () => {
    const text = 'sin redes socales 1h';
    expect(chipTexts(text, parse(text), 'category')).toEqual(['redes socales']);
  });

  it('does not stretch typos onto ordinary words', () => {
    // «mates» is one letter from «games», «diario» one from «diarios», «marco» from «marca».
    expect(parse('no quiero mates 1h')).toMatchObject({ categoryIds: [], unparsed: ['mates'] });
    expect(parse('no veo youtube a diario')).toMatchObject({
      serviceIds: ['youtube'],
      categoryIds: [],
      unparsed: ['diario'],
    });
    expect(parse('no veo marco 1h')).toMatchObject({ serviceIds: [], unparsed: ['marco'] });
  });
});

describe('study intents', () => {
  it.each<[string, string | undefined, number | undefined]>([
    ['voy a estudiar historia 45 min', 'historia', 45],
    ['hacer deberes de inglés media hora', 'deberes de inglés', 30],
    ['repasar física hasta las 19:00', 'física', 138],
    ['estudio 2h', undefined, 120],
    ['estudiar 1h de historia', 'historia', 60],
    ['estudiar mates y física 2h', 'mates y física', 120],
    ['hacer los deberes 1h', 'deberes', 60],
    ['tengo que hacer la tarea de historia hasta las 7', 'tarea de historia', 138],
    ['me pongo a estudiar lengua hasta las 20:00', 'lengua', 198],
    ['estudiar para el examen de mañana 2h', 'examen de mañana', 120],
    ['Estudiar Matemáticas 1 hora', 'Matemáticas', 60],
    ['estudia inglés 20 min', 'inglés', 20],
    ['repaso de química 40 minutos', 'química', 40],
    ['leer 30 min', 'leer', 30],
    ['deberes 1h', 'deberes', 60],
    ['estudiar mates sin distracciones 1h', 'mates', 60],
    // Words that are also catalog aliases stay in the task.
    ['estudiar series de Taylor 1h', 'series de Taylor', 60],
    ['estudiar redes de computadores 2 horas', 'redes de computadores', 120],
    ['estudiar historia del mundo 1h', 'historia del mundo', 60],
  ])('%s', (text, task, minutes) => {
    const result = parse(text);
    expect(result.kind).toBe('study');
    expect(result.task).toBe(task);
    expect(result.durationMinutes).toBe(minutes);
    expect(result.serviceIds).toEqual([]);
    expect(result.categoryIds).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('reads the end time of «repasar física hasta las 19:00»', () => {
    expect(parse('repasar física hasta las 19:00').endsAt).toBe(at(28, 19));
  });

  it('keeps block targets typed after a block word', () => {
    expect(parse('estudiar mates 1h sin youtube')).toMatchObject({
      kind: 'study',
      task: 'mates',
      serviceIds: ['youtube'],
      complete: true,
    });
    expect(parse('no veo youtube, estudio mates 1h')).toMatchObject({
      kind: 'study',
      task: 'mates',
      serviceIds: ['youtube'],
    });
  });

  it('needs a duration to be complete', () => {
    expect(parse('estudiar')).toMatchObject({ kind: 'study', complete: false, unparsed: [] });
    expect(parse('estudiar mates')).toMatchObject({
      kind: 'study',
      task: 'mates',
      complete: false,
    });
  });

  it('ignores negated study phrases', () => {
    expect(parse('no quiero estudiar')).toMatchObject({ kind: 'unknown', unparsed: ['estudiar'] });
    expect(parse('no voy a hacer los deberes')).toMatchObject({ kind: 'unknown', complete: false });
  });
});

describe('never invents anything', () => {
  it.each<[string, string[]]>([
    ['', []],
    ['   ', []],
    ['¡¡¡!!!', []],
    ['hola', ['hola']],
    ['123', ['123']],
    ['no veo la tele 1h', ['tele']],
    ['no veo nada 2h', []],
    ['bloquea 2h', []],
    ['1 hora', []],
    ['hasta las 8', []],
    ['hasta mañana', ['hasta mañana']],
    ['x 1h', ['x']],
    ['steam 1h', ['steam']],
    ['marca hasta las 8', ['marca']],
  ])('«%s» has no target', (text, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('unknown');
    expect(result.serviceIds).toEqual([]);
    expect(result.categoryIds).toEqual([]);
    expect(result.domains).toEqual([]);
    expect(result.task).toBeUndefined();
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });

  it.each<[string, string[]]>([
    ['no veo youtube mañana tarde', ['mañana tarde']],
    ['no veo youtube un rato', ['rato']],
    ['no veo youtube dentro de una hora', ['dentro']],
    ['no veo youtube hasta mañana', ['hasta mañana']],
    ['no veo youtube en clase', ['en clase']],
    ['no veo series ni pelis esta tarde', ['esta tarde']],
    ['sin series 1:30', ['1:30']],
    ['sin redes 45', ['45']],
    ['sin redes hasta las 25:00', ['hasta las 25:00']],
    ['no veo youtube 99999999 horas', ['99999999 horas']],
    ['no veo youtube en una hora modo estricto', ['modo estricto']],
  ])('«%s» stays incomplete and reports what it did not understand', (text, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });

  it('keeps only the first time expression', () => {
    expect(parse('no veo youtube 1h hasta las 20:00')).toMatchObject({
      durationMinutes: 60,
      unparsed: ['hasta las 20:00'],
      complete: false,
    });
    expect(parse('no veo youtube 1h y tiktok 30 min')).toMatchObject({
      serviceIds: ['youtube', 'tiktok'],
      durationMinutes: 60,
      unparsed: ['30 min'],
      complete: false,
    });
  });

  it('does not block what the user says they want to use', () => {
    expect(parse('quiero ver youtube 1h')).toMatchObject({
      kind: 'unknown',
      serviceIds: ['youtube'],
      durationMinutes: 60,
      complete: false,
    });
    expect(parse('voy a jugar a fortnite 1h')).toMatchObject({ kind: 'unknown', complete: false });
  });

  it('is incomplete without a duration', () => {
    expect(parse('no veo youtube')).toMatchObject({ kind: 'block', complete: false, unparsed: [] });
    expect(parse('no veo youtube hoy')).toMatchObject({ kind: 'block', complete: false });
  });
});

describe('warnings', () => {
  it.each<[string, number, ParseWarning[]]>([
    ['no veo youtube 30 horas', 1800, ['over_24h']],
    ['sin juegos 2 días', 2880, ['over_24h']],
    ['sin redes una semana', 10080, ['over_24h']],
    ['no veo youtube 24 horas', 1440, []],
    ['no veo youtube 2 minutos', 2, ['too_short']],
    ['sin redes 0 min', 0, ['too_short']],
    ['no veo youtube 5 min', 5, []],
  ])('%s → %i min %j', (text, minutes, warnings) => {
    const result = parse(text);
    expect(result.durationMinutes).toBe(minutes);
    expect(result.warnings).toEqual(warnings);
    // The UI enforces the limits; the phrase itself was fully understood.
    expect(result.complete).toBe(true);
  });

  it('exposes the limits it warns about', () => {
    expect(PARSER_LIMITS).toMatchObject({ minMinutes: 5, maxMinutes: 1440 });
  });
});

describe('explicit domains', () => {
  it('keeps typed domains as custom domains', () => {
    expect(parse('bloquea marca.com 1h')).toMatchObject({
      kind: 'block',
      serviceIds: [],
      domains: ['marca.com'],
      complete: true,
    });
    expect(parse('BLOQUEA MARCA.COM 1H').domains).toEqual(['marca.com']);
    expect(parse('twitch.tv 1h')).toMatchObject({ kind: 'block', domains: ['twitch.tv'] });
  });

  it('reads several domains and URLs', () => {
    expect(parse('no entro en www.ejemplo.es ni en foro.example.org 2h').domains).toEqual([
      'www.ejemplo.es',
      'foro.example.org',
    ]);
    const text = 'bloquea https://news.ycombinator.com/item?id=1 30 min';
    const result = parse(text);
    expect(result.domains).toEqual(['news.ycombinator.com']);
    expect(chipTexts(text, result, 'domain')).toEqual(['https://news.ycombinator.com/item?id=1']);
  });

  it('does not read a missing space after a period as a domain', () => {
    expect(parse('no veo youtube.hasta las 8')).toMatchObject({
      serviceIds: ['youtube'],
      domains: [],
      endsAt: at(28, 20),
    });
  });
});

describe('input handling', () => {
  it('treats non-string input as empty', () => {
    const result = parseIntent(undefined as unknown as string, { now: NOW });
    expect(result).toMatchObject({ kind: 'unknown', chips: [], unparsed: [], complete: false });
  });

  it('requires a valid reference time', () => {
    expect(() => parseIntent('sin redes 1h', { now: new Date(Number.NaN) })).toThrow(TypeError);
  });

  it('cuts very long input', () => {
    const result = parse(`no veo youtube 1h ${'bla '.repeat(1000)}`);
    expect(result.serviceIds).toEqual(['youtube']);
    expect(result.unparsed.join(' ').length).toBeLessThanOrEqual(PARSER_LIMITS.maxInputLength);
  });

  it('ignores emoji and punctuation around the phrase', () => {
    expect(parse('🙂 ¡no veo youtube 1h!')).toMatchObject({
      serviceIds: ['youtube'],
      complete: true,
    });
  });
});

describe('formatting helpers', () => {
  it('formats durations', () => {
    expect(durationLabel(0)).toBe('0 min');
    expect(durationLabel(45)).toBe('45 min');
    expect(durationLabel(60)).toBe('1 h');
    expect(durationLabel(90)).toBe('1 h 30 min');
    expect(durationLabel(1800)).toBe('30 h');
  });

  it('formats end times', () => {
    expect(untilLabel(new Date(2026, 8, 28, 20, 30), NOW)).toBe('hasta 20:30');
    expect(untilLabel(new Date(2026, 8, 29, 0, 0), NOW)).toBe('hasta 00:00');
    expect(untilLabel(new Date(2026, 8, 29, 8, 0), NOW)).toBe('hasta mañana 08:00');
    expect(untilLabel(new Date(2026, 8, 30, 8, 5), NOW)).toBe('hasta el 30/9 08:05');
  });

  it('builds the «No he entendido» line', () => {
    expect(notUnderstoodMessage(['mañana tarde'])).toBe('No he entendido: "mañana tarde"');
    expect(notUnderstoodMessage(['rato', '45'])).toBe('No he entendido: "rato", "45"');
    expect(notUnderstoodMessage([])).toBe('');
  });
});

describe('regression: phrases from the catalog audit', () => {
  it.each<[string, 'block' | 'study', string[], string[], number]>([
    ['q no me deje entrar a insta en 2 horas', 'block', ['instagram'], [], 120],
    ['bloqueame yt 1 hora porfa', 'block', ['youtube'], [], 60],
    ['no  veo   youtube    1   h', 'block', ['youtube'], [], 60],
    ['nada de youtube,tiktok,insta 1h', 'block', ['youtube', 'tiktok', 'instagram'], [], 60],
    [
      'sin redes: insta, tiktok y twitter hasta las 10',
      'block',
      ['instagram', 'tiktok', 'x-twitter'],
      ['social'],
      318,
    ],
    [
      'sin fornite ni el maincra hasta las 9 de la noche',
      'block',
      ['fortnite', 'minecraft'],
      [],
      258,
    ],
    ['apaga discord y el wasap durante hora y media', 'block', ['discord', 'whatsapp'], [], 90],
    ['hasta las 10 nada de redes', 'block', [], ['social'], 318],
    ['no veo netflix hasta las nueve y media', 'block', ['netflix'], [], 288],
    ['sin insta hasta las 7 menos 10', 'block', ['instagram'], [], 128],
    ['sin tiktok hasta las 8:30pm', 'block', ['tiktok'], [], 228],
    ['sin juegos hasta las 12 y media de la noche', 'block', [], ['games'], 468],
    ['tengo q estudiar historia hasta las 8', 'study', [], [], 198],
    ['estudiar mates sin insta ni tiktok hasta las 8', 'study', ['instagram', 'tiktok'], [], 198],
  ])('%s', (text, kind, serviceIds, categoryIds, minutes) => {
    const result = parse(text);
    expect(result.kind).toBe(kind);
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.categoryIds).toEqual(categoryIds);
    expect(result.durationMinutes).toBe(minutes);
    expect(result.unparsed).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it.each(['q aburrimiento tio', 'no se que hacer', 'tengo examen mañana y no me concentro'])(
    '«%s» blocks nothing',
    (text) => {
      const result = parse(text);
      expect(result.kind).toBe('unknown');
      expect(result.serviceIds).toEqual([]);
      expect(result.categoryIds).toEqual([]);
      expect(result.complete).toBe(false);
    },
  );

  it.each<[string, string[]]>([
    ['no tt 1h', ['tiktok']],
    ['sin el mine 1h', ['minecraft']],
    ['no ajedrez 1h', ['chess-com']],
    ['sin fifa 1h', ['ea-sports-fc']],
    ['no juego al fc 26 2h', ['ea-sports-fc']],
    ['no veo anime 1h', ['crunchyroll']],
    ['no geforce now 1h', ['geforce-now']],
    ['sin xcloud ni boosteroid 1h', ['xbox-cloud-gaming', 'boosteroid']],
    ['no veo flashscore ni sofascore 1h', ['flashscore', 'sofascore']],
    ['sin 1001 juegos 1h', ['1001juegos']],
  ])('reads the new catalog aliases: %s', (text, serviceIds) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.complete).toBe(true);
  });

  it.each(['tt 1h', 'mine 1h', 'anime 1h', 'ajedrez 1h', 'fc 1h'])(
    'treats short or common new aliases as weak: «%s»',
    (text) => {
      expect(parse(text)).toMatchObject({ kind: 'unknown', serviceIds: [], complete: false });
    },
  );
});

describe('parser-side aliases', () => {
  it.each(PARSER_EXTRA_ALIASES.map((entry) => [entry.alias, entry.kind, entry.id] as const))(
    '«%s» points to an existing %s (%s) and is missing from the catalog',
    (alias, kind, id) => {
      expect(kind === 'service' ? getService(id) : getCategory(id)).toBeDefined();
      expect(findServiceByAlias(alias)).toBeUndefined();
      expect(findCategoryByAlias(alias)).toBeUndefined();
    },
  );
});

describe('regression: parser audit (weak aliases in everyday texting)', () => {
  it.each<[string, string[], number | undefined, string[]]>([
    // «x» is «por»: before a number or duration, «hoy», «fa», «favor», «q»…
    ['sin tiktok x 1 hora', ['tiktok'], 60, []],
    ['bloquea youtube x 1 hora', ['youtube'], 60, []],
    ['no mas tiktok x hoy', ['tiktok'], undefined, []],
    ['bloquea insta x fa', ['instagram'], undefined, []],
    ['no quiero netflix x favor 1h', ['netflix'], 60, []],
    ['no quiero ver youtube x ahora', ['youtube'], undefined, []],
    ['x fa bloquea youtube 1h', ['youtube'], 60, []],
    // «max» next to a duration is «máximo».
    ['sin redes 2h max', [], 120, []],
    ['sin redes como max 1h', [], 60, []],
    ['sin youtube max. 2h', ['youtube'], 120, []],
    ['no veo youtube, como max 1 hora', ['youtube'], 60, []],
    // «lol», «ea», «wa» trailing after a duration or a comma.
    ['sin tiktok 1h lol', ['tiktok'], 60, []],
    ['bloquea twitch 1h, lol', ['twitch'], 60, []],
    ['no quiero tiktok 1h, ea', ['tiktok'], 60, ['ea']],
    ['bloquea youtube 1h wa', ['youtube'], 60, ['wa']],
    ['venga ea, fuera redes 2h', [], 120, ['ea']],
  ])('«%s» adds no extra service', (text, serviceIds, minutes, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.durationMinutes).toBe(minutes);
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(minutes !== undefined && unparsed.length === 0);
  });

  it.each<[string, string[]]>([
    ['no veo x 1h', ['x-twitter']],
    ['sin tiktok ni x 1h', ['tiktok', 'x-twitter']],
    ['sin tiktok, x 1h', ['tiktok', 'x-twitter']],
    ['cero x 1h', ['x-twitter']],
    ['nada de x 1h', ['x-twitter']],
    ['sin twitter x 1h', ['x-twitter']],
    ['sin max 2h', ['hbo-max']],
    ['sin netflix ni max 2h', ['netflix', 'hbo-max']],
    ['no veo max 1h', ['hbo-max']],
    ['sin hbo max 2h', ['hbo-max']],
    ['no juego al lol 2h', ['league-of-legends']],
    ['no juego lol 1h', ['league-of-legends']],
    ['sin lol ni valo 2h', ['league-of-legends', 'valorant']],
    ['lol y fortnite 2h', ['league-of-legends', 'fortnite']],
    ['sin abc 1h', ['abc']],
    ['no veo youtube ni abc 1h', ['youtube', 'abc']],
    ['bloquea steam y epic 1h', ['steam', 'epic-games']],
    ['youtube y steam 1h', ['youtube', 'steam']],
  ])('still reads weak aliases in target position: «%s»', (text, serviceIds) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.categoryIds).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it.each<[string, string[]]>([
    ['no se lol', []],
    ['no veo nada x hoy', []],
    ['me voy al insti', ['insti']],
    ['no puedo mas con el insti', ['con el insti']],
    ['voy a comprar chuches', ['chuches']],
    ['tengo que hacer la compra', ['compra']],
    ['me voy a la tienda un momento', ['tienda un momento']],
    ['tengo q grabar un video pa clase', ['grabar un video pa clase']],
    ['no tengo vida social jaja', ['vida social']],
    ['tengo examen de ciencias sociales', ['examen de ciencias sociales']],
    ['voy al trabajo', ['trabajo']],
    ['no uso el disco 1h', ['disco']],
    ['no voy a valorar eso', ['valorar']],
    ['no leo sports 1h', ['sports']],
    ['sin amazonas 1h', ['amazonas']],
    ['netfl 2h', ['netfl']],
  ])('«%s» blocks nothing', (text, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('unknown');
    expect(result.serviceIds).toEqual([]);
    expect(result.categoryIds).toEqual([]);
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });

  it('does not read «insti» as Instagram next to a real target', () => {
    expect(parse('no veo tiktok en el insti')).toMatchObject({
      kind: 'block',
      serviceIds: ['tiktok'],
      unparsed: ['en el insti'],
      complete: false,
    });
  });

  it('trusts short fuzzy hits only in target position', () => {
    expect(parse('sin netfl 2h')).toMatchObject({ serviceIds: ['netflix'], complete: true });
  });

  it.each<[string, string[], string[]]>([
    ['no veo video 1h', [], ['video']],
    ['sin chat 1h', [], ['messaging']],
    ['no quiero comprar 1h', [], ['shopping']],
    ['no veo video de youtube 1h', ['youtube'], []],
    ['no juego al steams 1h', [], ['games']],
  ])('keeps generic category words after a block word: «%s»', (text, serviceIds, categoryIds) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.categoryIds).toEqual(categoryIds);
  });
});

describe('regression: parser audit («20 minutos» next to another duration)', () => {
  it('keeps a second «20 minutos» after a target as an extra duration', () => {
    expect(parse('sin youtube 1h y sin tiktok 20 minutos')).toMatchObject({
      kind: 'block',
      serviceIds: ['youtube', 'tiktok'],
      durationMinutes: 60,
      unparsed: ['20 minutos'],
      complete: false,
    });
  });

  it('does not read «20 minutos o 30 minutos» as the newspaper', () => {
    expect(parse('sin redes 20 minutos o 30 minutos')).toMatchObject({
      serviceIds: [],
      categoryIds: ['social'],
      durationMinutes: 20,
      unparsed: ['30 minutos'],
      complete: false,
    });
  });

  it('does not read «descanso 20 minutos» as the newspaper', () => {
    const result = parse('estudio 1h y descanso 20 minutos');
    expect(result).toMatchObject({
      kind: 'study',
      serviceIds: [],
      durationMinutes: 60,
      unparsed: ['descanso', '20 minutos'],
      complete: false,
    });
    expect(result.task).toBeUndefined();
  });

  it('still reads it in target position', () => {
    expect(parse('sin youtube ni 20 minutos 1h').serviceIds).toEqual(['youtube', '20minutos']);
    expect(parse('nada de el 20 minutos ni marca 1h').serviceIds).toEqual(['20minutos', 'marca']);
    expect(parse('nada del 20 minutos ni marca 1h').serviceIds).toEqual(['20minutos', 'marca']);
  });
});

describe('regression: parser audit (exceptions, unblock and wanting to use)', () => {
  it.each<[string, 'block' | 'unknown', string[], string[], string[]]>([
    ['bloquea todo menos whatsapp 2h', 'unknown', [], [], ['todo menos whatsapp']],
    ['sin redes excepto whatsapp 1h', 'block', [], ['social'], ['excepto whatsapp']],
    ['sin redes pero déjame whatsapp 1h', 'block', [], ['social'], ['pero déjame whatsapp']],
    ['sin juegos salvo el minecraft 1h', 'block', [], ['games'], ['salvo el minecraft']],
    ['sin redes quitando whatsapp 1h', 'block', [], ['social'], ['quitando whatsapp']],
    [
      'sin redes menos whatsapp, y sin juegos 1h',
      'block',
      [],
      ['social', 'games'],
      ['menos whatsapp'],
    ],
  ])('never blocks the exception: «%s»', (text, kind, serviceIds, categoryIds, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe(kind);
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.categoryIds).toEqual(categoryIds);
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });

  it.each([
    'quítame el bloqueo de insta',
    'ya no quiero bloquear tiktok',
    'no bloquees youtube 1h',
    'no me bloquees youtube',
    'desbloquea youtube',
    'desbloquéame el tiktok 10 min',
    'cancela el bloqueo',
  ])('treats «%s» as an unblock request, never a block', (text) => {
    expect(parse(text)).toMatchObject({ kind: 'unknown', complete: false });
  });

  it.each<[string, string[]]>([
    ['quita youtube 1h', ['youtube']],
    ['quiero que bloquees youtube 1h', ['youtube']],
  ])('still blocks with «quita» and «bloquees» alone: «%s»', (text, serviceIds) => {
    expect(parse(text)).toMatchObject({ kind: 'block', serviceIds, complete: true });
  });

  it.each<[string, string[]]>([
    ['ver netflix 2h', ['netflix']],
    ['veo youtube 1h', ['youtube']],
    ['jugar al minecraft 1h', ['minecraft']],
    ['juego al lol 2h', ['league-of-legends']],
    ['tengo ganas de ver youtube', ['youtube']],
    ['me apetece ver netflix', ['netflix']],
    ['necesito el whatsapp pa hablar con mi madre', ['whatsapp']],
    ['déjame youtube 10 min', ['youtube']],
    ['voy a comprar en amazon', ['amazon']],
  ])('does not block what «%s» wants to use', (text, serviceIds) => {
    expect(parse(text)).toMatchObject({ kind: 'unknown', serviceIds, complete: false });
  });
});

describe('regression: parser audit (study phrases)', () => {
  it.each([
    'paso de estudiar',
    'deja de estudiar',
    'odio estudiar',
    'olvídate de estudiar',
    'cero ganas de estudiar',
    'cuando acabe de estudiar veo netflix',
  ])('«%s» is not a study session', (text) => {
    const result = parse(text);
    expect(result.kind).toBe('unknown');
    expect(result.task).toBeUndefined();
    expect(result.complete).toBe(false);
  });

  it('starts a new clause after «y»', () => {
    expect(parse('no veo youtube y estudio mates 1h')).toMatchObject({
      kind: 'study',
      task: 'mates',
      serviceIds: ['youtube'],
      complete: true,
    });
  });

  it.each<[string, number]>([
    ['estudiar 2 horas seguidas', 120],
    ['estudiar ya 30 min', 30],
    ['modo estudio 1h', 60],
  ])('keeps filler out of the task: «%s»', (text, minutes) => {
    const result = parse(text);
    expect(result).toMatchObject({ kind: 'study', durationMinutes: minutes, unparsed: [] });
    expect(result.task).toBeUndefined();
    expect(result.complete).toBe(true);
  });

  it.each<[string, string | undefined, string[]]>([
    ['estudiar un rato', undefined, ['rato']],
    ['estudiar toda la tarde', undefined, ['toda la tarde']],
    ['estudiar historia toda la tarde', 'historia', ['toda la tarde']],
    ['estudiar 1h y después youtube', undefined, ['después youtube']],
    ['estudiar mates 1h y después descanso', 'mates', ['después descanso']],
    ['estudiar mates y youtube 1h', 'mates', ['youtube']],
  ])('reports time words and later plans instead of a task: «%s»', (text, task, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('study');
    expect(result.task).toBe(task);
    expect(result.serviceIds).toEqual([]);
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });

  it.each<[string, string, number]>([
    ['me toca estudiar lengua 40 min', 'lengua', 40],
    ['me voy a poner a estudiar lengua 40 min', 'lengua', 40],
    ['hacer el trabajo de historia 2h', 'trabajo de historia', 120],
    ['hacer ejercicios de mates 1h', 'ejercicios de mates', 60],
    ['hacer un resumen de historia 30 min', 'resumen de historia', 30],
  ])('understands «%s»', (text, task, minutes) => {
    expect(parse(text)).toMatchObject({
      kind: 'study',
      task,
      durationMinutes: minutes,
      unparsed: [],
      complete: true,
    });
  });
});

describe('regression: parser audit (teen spellings, durations and end times)', () => {
  it.each<[string, string[], string[], number]>([
    ['no kiero ver tiktok en 1h', ['tiktok'], [], 60],
    ['nada d redes 1h', [], ['social'], 60],
    ['paso d insta 1h', ['instagram'], [], 60],
    ['bloquea el tiktok y el insta pa 2h', ['tiktok', 'instagram'], [], 120],
    ['bloquea insta xfa 30 min', ['instagram'], [], 30],
    ['sin tiktok 1 ora', ['tiktok'], [], 60],
    ['chao insta 1h', ['instagram'], [], 60],
    ['sin redes durante la próxima hora', [], ['social'], 60],
    ['sin redes las 2 próximas horas', [], ['social'], 120],
    ['sin redes una hora entera', [], ['social'], 60],
    ['sin redes 1 hora mas o menos', [], ['social'], 60],
    ['sin redes 1h o así', [], ['social'], 60],
    ['sin redes 1h aprox', [], ['social'], 60],
    ['sin redes al menos 1h', [], ['social'], 60],
    ['no veo youtube1h', ['youtube'], [], 60],
    ['sin tiktok30min', ['tiktok'], [], 30],
    ['sin tick tock 1h', ['tiktok'], [], 60],
    ['no veo youtubers 1h', ['youtube'], [], 60],
    ['sin y8 1h', ['y8'], [], 60],
  ])('%s', (text, serviceIds, categoryIds, minutes) => {
    expect(parse(text)).toMatchObject({
      kind: 'block',
      serviceIds,
      categoryIds,
      durationMinutes: minutes,
      unparsed: [],
      complete: true,
    });
  });

  it('splits a duration glued to an alias into two chips', () => {
    const text = 'no veo youtube1h';
    const result = parse(text);
    expect(chipTexts(text, result, 'service')).toEqual(['youtube']);
    expect(chipTexts(text, result, 'duration')).toEqual(['1h']);
  });

  it.each<[string, string, ParseWarning[]]>([
    ['no veo youtube asta las 8', at(28, 20), ['ambiguous_time']],
    ['sin redes de aquí a las 8', at(28, 20), ['ambiguous_time']],
    ['no veo youtube hasta q sean las 8', at(28, 20), ['ambiguous_time']],
    ['sin redes hasta las 20 30', at(28, 20, 30), []],
    ['sin redes hasta la 1 de la madrugada', at(29, 1), []],
    ['sin redes hasta las 2 de la noche', at(29, 2), []],
    ['sin redes hasta las 8am', at(29, 8), []],
  ])('%s', (text, endsAt, warnings) => {
    const result = parse(text);
    expect(result).toMatchObject({ kind: 'block', endsAt, unparsed: [], complete: true });
    expect(sorted(result.warnings)).toEqual(sorted(warnings));
  });

  it('still warns about a morning time typed in the morning', () => {
    const morning = new Date(2026, 8, 28, 10, 0);
    expect(parse('sin redes hasta las 8 de la mañana', morning).warnings).toEqual(['past_time']);
  });
});
