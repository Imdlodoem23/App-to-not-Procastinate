// Fixed time zone before any Date is created: «until 8:30 pm» means Madrid time.
process.env.TZ = 'Europe/Madrid';

import { describe, expect, it } from 'vitest';
import { getCategory, getService } from '../src/catalog';
import { parseIntent, type ParseResult, type ParseWarning } from '../src/parser';

/*
 * The parser reads English phrases with the same rules as Spanish ones (parser.test.ts):
 * nothing is invented, unblock requests and wishes to use something are never blocks, and
 * exceptions and later plans stay in `unparsed`. The UI locale only changes chip labels.
 */

/** Monday 28 September 2026, 16:42 in Madrid (CEST, UTC+2). */
const NOW = new Date(2026, 8, 28, 16, 42);

/** Local instant in September 2026 as ISO, e.g. at(28, 20, 30). */
const at = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 8, day, hour, minute).toISOString();

/** `Intl` may separate «PM» with a narrow no-break space: compare with a space. */
const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, ' ');

/** Parses `text` in the English UI and checks the invariants every result must keep. */
function parse(text: string, now: Date = NOW): ParseResult {
  const result = parseIntent(text, { now, locale: 'en' });
  let previous = -1;
  for (const chip of result.chips) {
    expect(chip.start).toBeGreaterThanOrEqual(0);
    expect(chip.end).toBeGreaterThan(chip.start);
    expect(chip.end).toBeLessThanOrEqual(text.length);
    expect(chip.start).toBeGreaterThanOrEqual(previous);
    expect(chip.label.length).toBeGreaterThan(0);
    previous = chip.start;
  }
  for (const id of result.serviceIds) expect(getService(id)).toBeDefined();
  for (const id of result.categoryIds) expect(getCategory(id)).toBeDefined();
  expect(result.durationMinutes === undefined).toBe(result.endsAt === undefined);
  if (result.complete) {
    expect(result.unparsed).toEqual([]);
    expect(result.durationMinutes).toBeDefined();
    expect(result.kind).not.toBe('unknown');
  }
  if (result.kind !== 'study') expect(result.task).toBeUndefined();
  // The UI language never changes what was understood.
  const spanishUi = parseIntent(text, { now });
  expect({ ...spanishUi, chips: spanishUi.chips.map(({ label: _l, ...chip }) => chip) }).toEqual({
    ...result,
    chips: result.chips.map(({ label: _l, ...chip }) => chip),
  });
  return result;
}

const sorted = (warnings: readonly ParseWarning[]): ParseWarning[] => [...warnings].sort();

/** Text covered by the chips of `kind`. */
function chipTexts(text: string, result: ParseResult, kind: string): string[] {
  return result.chips.filter((c) => c.kind === kind).map((c) => text.slice(c.start, c.end));
}

describe('the six phrases of PROMPT.md section 4, in English', () => {
  it('«no YouTube for an hour» → YouTube, 60 min', () => {
    const text = 'no YouTube for an hour';
    const result = parse(text);
    expect(result).toEqual({
      kind: 'block',
      serviceIds: ['youtube'],
      categoryIds: [],
      domains: [],
      durationMinutes: 60,
      endsAt: at(28, 17, 42),
      chips: [
        { kind: 'service', label: 'YouTube', value: 'youtube', start: 3, end: 10 },
        { kind: 'duration', label: '1 h', value: '60', start: 11, end: 22 },
      ],
      unparsed: [],
      warnings: [],
      complete: true,
    });
    expect(chipTexts(text, result, 'duration')).toEqual(['for an hour']);
  });

  it('«nothing on TikTok or Instagram for 45 minutes» style lists → both, 45 min', () => {
    expect(parse('block TikTok and Instagram for 45 minutes')).toMatchObject({
      kind: 'block',
      serviceIds: ['tiktok', 'instagram'],
      durationMinutes: 45,
      endsAt: at(28, 17, 27),
      complete: true,
    });
  });

  it('«block social media until 8:30 pm» → Social media, until 20:30', () => {
    const text = 'block social media until 8:30 pm';
    const result = parse(text);
    expect(result).toMatchObject({
      kind: 'block',
      categoryIds: ['social'],
      durationMinutes: 228,
      endsAt: at(28, 20, 30),
      warnings: [],
      complete: true,
    });
    expect(chipTexts(text, result, 'category')).toEqual(['social media']);
    expect(chipTexts(text, result, 'until')).toEqual(['until 8:30 pm']);
    expect(result.chips.map((chip) => plain(chip.label))).toEqual([
      'Social media',
      'until 8:30 PM',
    ]);
  });

  it('«no games for an hour and a half» → Games, 90 min', () => {
    expect(parse('no games for an hour and a half')).toMatchObject({
      kind: 'block',
      categoryIds: ['games'],
      durationMinutes: 90,
      complete: true,
    });
  });

  it('«I don’t want to watch Netflix for 2h» → Netflix, 120 min', () => {
    for (const text of [
      "I don't want to watch Netflix for 2h",
      'I don’t want to watch Netflix for 2h',
      'I dont want to watch Netflix for 2h',
    ]) {
      expect(parse(text)).toMatchObject({
        kind: 'block',
        serviceIds: ['netflix'],
        durationMinutes: 120,
        complete: true,
      });
    }
  });

  it('«study math for 1 hour» → study session «math», 60 min', () => {
    const text = 'study math for 1 hour';
    const result = parse(text);
    expect(result).toMatchObject({
      kind: 'study',
      task: 'math',
      durationMinutes: 60,
      serviceIds: [],
      complete: true,
    });
    expect(chipTexts(text, result, 'task')).toEqual(['math']);
  });
});

describe('English durations', () => {
  it.each([
    ['no youtube for an hour', 60],
    ['no youtube for 1 hour', 60],
    ['no youtube for one hour', 60],
    ['no youtube in an hour', 60],
    ['no youtube for another hour', 60],
    ['no youtube for half an hour', 30],
    ['no youtube for half hour', 30],
    ['no youtube for a half hour', 30],
    ['no youtube for a quarter of an hour', 15],
    ['no youtube for a quarter hour', 15],
    ['no youtube for three quarters of an hour', 45],
    ['no youtube for an hour and a half', 90],
    ['no youtube for an hour and a quarter', 75],
    ['no youtube for an hour and three quarters', 105],
    ['no youtube for hour and a half', 90],
    ['no youtube for one and a half hours', 90],
    ['no youtube for 2 and a half hours', 150],
    ['no youtube for a couple of hours', 120],
    ['no youtube for a couple hours', 120],
    ['no youtube for 90 minutes', 90],
    ['no youtube for 90 mins', 90],
    ['no youtube for a minute', 1],
    ['no youtube for 2 hours', 120],
    ['no youtube for two hours', 120],
    ['no youtube for 2 hrs', 120],
    ['no youtube for 1 hr', 60],
    ['no youtube for 1.5 hours', 90],
    ['no youtube for 1 hour 30 minutes', 90],
    ['no youtube for 1 hour and 30 minutes', 90],
    ['no youtube for an hour and 20 minutes', 80],
    ['no youtube for an hour and 20', 80],
    ['no youtube for 1:30', 90],
    ['no youtube for 1hour', 60],
    ['no youtube for 45minutes', 45],
    ['no youtube for forty-five minutes', 45],
    ['no youtube for twenty five minutes', 25],
    ['no youtube for fifteen minutes', 15],
    ['no youtube for the next hour', 60],
    ['no youtube for the next 2 hours', 120],
    ['no youtube over the next 30 minutes', 30],
    ['no youtube for about an hour', 60],
    ['no youtube for like 20 min', 20],
    ['no youtube for just 10 minutes', 10],
    ['no youtube for 2 hours max', 120],
    ['no youtube for 2 hours tops', 120],
    ['no youtube for an hour or so', 60],
    ['no youtube for at least an hour', 60],
    ['no youtube for up to 2 hours', 120],
    ['no youtube for 1 hour straight', 60],
    ['no youtube for 2 hours in a row', 120],
    ['no youtube for a day', 1440],
  ])('%s → %i min', (text, minutes) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.durationMinutes).toBe(minutes);
    expect(result.endsAt).toBe(new Date(NOW.getTime() + minutes * 60_000).toISOString());
    expect(result.unparsed).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.chips.filter((c) => c.kind === 'duration')).toHaveLength(1);
  });

  it('warns about long and short durations like in Spanish', () => {
    expect(parse('no games for a week')).toMatchObject({
      durationMinutes: 10_080,
      warnings: ['over_24h'],
      complete: true,
    });
    expect(parse('no games for 2 minutes')).toMatchObject({ warnings: ['too_short'] });
  });
});

describe('English end times with now = Monday 16:42', () => {
  it.each<[string, string, number, ParseWarning[]]>([
    ['no reddit until 8', at(28, 20), 198, ['ambiguous_time']],
    ['no reddit until 8pm', at(28, 20), 198, []],
    ['no reddit until 8 pm', at(28, 20), 198, []],
    ['no reddit until 8 p.m.', at(28, 20), 198, []],
    ['no reddit until 8:30pm', at(28, 20, 30), 228, []],
    ['no reddit until 20:30', at(28, 20, 30), 228, []],
    ['no reddit till 9', at(28, 21), 258, ['ambiguous_time']],
    ["no reddit 'til 9:15", at(28, 21, 15), 273, ['ambiguous_time']],
    ['no reddit until eight', at(28, 20), 198, ['ambiguous_time']],
    ['no reddit until eight thirty', at(28, 20, 30), 228, ['ambiguous_time']],
    ['no reddit until 8 30', at(28, 20, 30), 228, ['ambiguous_time']],
    ["no reddit until 8 o'clock", at(28, 20), 198, ['ambiguous_time']],
    ['no reddit until half past 8', at(28, 20, 30), 228, ['ambiguous_time']],
    ['no reddit until a quarter past 7', at(28, 19, 15), 153, ['ambiguous_time']],
    ['no reddit until quarter to 9', at(28, 20, 45), 243, ['ambiguous_time']],
    ['no reddit until 10 to 9', at(28, 20, 50), 248, ['ambiguous_time']],
    ['no reddit until 8 in the evening', at(28, 20), 198, []],
    ['no reddit until 5 this afternoon', at(28, 17), 18, []],
    ['no reddit until 11 tonight', at(28, 23), 378, []],
    ['no reddit until 11 at night', at(28, 23), 378, []],
    ['no reddit until tonight at 11', at(28, 23), 378, []],
    // «in the morning» said in the afternoon: tomorrow is what the user meant, no warning.
    ['no reddit until 6 in the morning', at(29, 6), 798, []],
    ['no reddit until 8am', at(29, 8), 918, []],
    ['no reddit until tomorrow at 8', at(29, 8), 918, []],
    ['no reddit until tomorrow 8am', at(29, 8), 918, []],
    ['no reddit until 8 tomorrow', at(29, 8), 918, []],
    ['no reddit until 8 tomorrow morning', at(29, 8), 918, []],
    ['no reddit until tomorrow morning at 9', at(29, 9), 978, []],
    ['no reddit until noon', at(29, 12), 1158, ['past_time']],
    ['no reddit until noon tomorrow', at(29, 12), 1158, []],
    ['no reddit until tomorrow at noon', at(29, 12), 1158, []],
    ['no reddit until midnight', at(29, 0), 438, []],
    ['no reddit until the end of the day', at(29, 0), 438, []],
    ['no reddit until end of day', at(29, 0), 438, []],
    ['no reddit until 16:00', at(29, 16), 1398, ['past_time']],
    ['no games before 6', at(28, 18), 78, ['ambiguous_time']],
    ['no games before 6pm', at(28, 18), 78, []],
  ])('%s', (text, endsAt, minutes, warnings) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.endsAt).toBe(endsAt);
    expect(result.durationMinutes).toBe(minutes);
    expect(sorted(result.warnings)).toEqual(sorted(warnings));
    expect(result.complete).toBe(true);
    const chip = result.chips.find((c) => c.kind === 'until');
    expect(chip?.value).toBe(endsAt);
    // «'til»: the apostrophe is not part of the word.
    expect(text.slice(chip?.start, chip?.end)).toMatch(/^(?:until|till|til|before)\b/i);
  });

  it('labels the end in English, naming noon and midnight', () => {
    const label = (text: string): string | undefined =>
      parse(text)
        .chips.filter((chip) => chip.kind === 'until')
        .map((chip) => plain(chip.label))[0];
    expect(label('no reddit until 8:30 pm')).toBe('until 8:30 PM');
    expect(label('no reddit until tomorrow at 8')).toBe('until tomorrow 8:00 AM');
    expect(label('no reddit until midnight')).toBe('until midnight');
    expect(label('no reddit until noon tomorrow')).toBe('until noon tomorrow');
  });

  it('does not read a bare hour followed by a unit as a time', () => {
    expect(parse('no reddit until 2 hours')).toMatchObject({
      durationMinutes: 120,
      unparsed: ['until'],
      complete: false,
    });
  });

  it('falls back to the plain hour when «to» does not start a spoken time', () => {
    expect(parse('no reddit until 8 to be safe')).toMatchObject({
      endsAt: at(28, 20),
      unparsed: ['safe'],
      complete: false,
    });
  });
});

describe('English targets and block words', () => {
  it.each<[string, string[], string[]]>([
    ['block YouTube for 1 hour', ['youtube'], []],
    ['YouTube for 1 hour', ['youtube'], []],
    ['without YouTube for 1 hour', ['youtube'], []],
    ["don't let me open Instagram for 30 minutes", ['instagram'], []],
    ['dont let me use tiktok for an hour', ['tiktok'], []],
    ["I won't watch YouTube for an hour", ['youtube'], []],
    ["I can't use Reddit for 2 hours", ['reddit'], []],
    ['keep me off TikTok for an hour', ['tiktok'], []],
    ['stay off Instagram until 6pm', ['instagram'], []],
    ['lock me out of Reddit for 1 hour', ['reddit'], []],
    ['turn off Discord for 45 minutes', ['discord'], []],
    ['get rid of Twitter for a day', ['x-twitter'], []],
    ['stop scrolling TikTok for 1 hour', ['tiktok'], []],
    ['quit Instagram for 1 hour', ['instagram'], []],
    ['ban YouTube for 1 hour', ['youtube'], []],
    ['pause Netflix for 2 hours', ['netflix'], []],
    ['mute Discord for 1 hour', ['discord'], []],
    ['no more x for 1 hour', ['x-twitter'], []],
    ['block x and reddit for 1 hour', ['x-twitter', 'reddit'], []],
    ['no youtube or twitch for 1 hour', ['youtube', 'twitch'], []],
    ['neither YouTube nor Twitch for an hour', ['youtube', 'twitch'], []],
    ['block YouTube, TikTok and Instagram until 10:30 pm', ['youtube', 'tiktok', 'instagram'], []],
    ['no lol for 1 hour', ['league-of-legends'], []],
    ['no max for 1 hour', ['hbo-max'], []],
    ['no chess for 1 hour', ['chess-com'], []],
    ['block videos on YouTube for 1 hour', ['youtube'], []],
    ['no games on Steam for 2 hours', ['steam'], []],
    ['no YouTube videos or Instagram for 1h', ['youtube', 'instagram'], []],
    ['no Twitch streams for 1h', ['twitch'], []],
    ['no social media for 2 hours', [], ['social']],
    ['no socials until 9pm', [], ['social']],
    ['block social networks for 1 hour', [], ['social']],
    ['no movies or tv shows for 2 hours', [], ['video']],
    ['no streaming until 9pm', [], ['video']],
    ['no video games for 1 hour', [], ['games']],
    ['no gaming for 3 hours', [], ['games']],
    ['no messages for 30 minutes', [], ['messaging']],
    ['no texting for 30 minutes', [], ['messaging']],
    ['no shopping for a day', [], ['shopping']],
    ['no news for 2 hours', [], ['news']],
    ['please block youtube for an hour thanks', ['youtube'], []],
    ['pls no tiktok for 30 mins', ['tiktok'], []],
    ['block youtube for an hour starting now', ['youtube'], []],
  ])('%s', (text, serviceIds, categoryIds) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.serviceIds).toEqual(serviceIds);
    expect(result.categoryIds).toEqual(categoryIds);
    expect(result.unparsed).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('keeps typed domains', () => {
    expect(parse('block reddit.com and twitch.tv for 1 hour')).toMatchObject({
      domains: ['reddit.com', 'twitch.tv'],
      complete: true,
    });
  });

  it('reads Spanish and English mixed in one phrase', () => {
    for (const text of [
      'sin YouTube for 1 hour',
      'no veo YouTube for 1 hour',
      'bloquea YouTube until 8pm',
      'no YouTube durante 1 hora',
      'block youtube hasta las 8',
    ]) {
      expect(parse(text)).toMatchObject({ kind: 'block', serviceIds: ['youtube'], complete: true });
    }
  });

  it('does not read everyday phrases as targets', () => {
    expect(parse('my social life is dead')).toMatchObject({ kind: 'unknown', categoryIds: [] });
    expect(parse('no phone for 1 hour')).toMatchObject({
      kind: 'unknown',
      unparsed: ['phone'],
      complete: false,
    });
    expect(parse('I have an exam tomorrow and can’t focus')).toMatchObject({
      kind: 'unknown',
      serviceIds: [],
      categoryIds: [],
      complete: false,
    });
  });
});

describe('English study intents', () => {
  it.each<[string, string | undefined, number]>([
    ['study history for 45 minutes', 'history', 45],
    ["I'm going to study history for 45 min", 'history', 45],
    ['revise physics until 7pm', 'physics', 138],
    ['review chemistry for 40 minutes', 'chemistry', 40],
    ['studying 2h', undefined, 120],
    ['study mode for 1 hour', undefined, 60],
    ['study for 2 hours straight', undefined, 120],
    ['study for the exam for 2 hours', 'exam', 120],
    ['do my homework for 30 minutes', 'homework', 30],
    ['do my math homework for 1 hour', 'math homework', 60],
    ['math homework for 1 hour', 'math homework', 60],
    ['my social studies homework for 1 hour', 'social studies homework', 60],
    ['write my history essay until 7pm', 'history essay', 138],
    ['work on my essay for 2 hours', 'essay', 120],
    ['reading for 30 minutes', 'reading', 30],
  ])('%s', (text, task, minutes) => {
    const result = parse(text);
    expect(result.kind).toBe('study');
    expect(result.task).toBe(task);
    expect(result.durationMinutes).toBe(minutes);
    expect(result.serviceIds).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('keeps targets typed after a block word', () => {
    expect(parse('study math for 1 hour without YouTube')).toMatchObject({
      kind: 'study',
      task: 'math',
      serviceIds: ['youtube'],
      complete: true,
    });
    expect(parse('no YouTube and study math for 1 hour')).toMatchObject({
      kind: 'study',
      task: 'math',
      serviceIds: ['youtube'],
      complete: true,
    });
  });

  it.each(["I don't want to study", 'stop studying', 'tired of studying', 'after studying'])(
    '«%s» is not a study session',
    (text) => {
      const result = parse(text);
      expect(result.kind).toBe('unknown');
      expect(result.task).toBeUndefined();
      expect(result.complete).toBe(false);
    },
  );

  it.each<[string, string | undefined, string[]]>([
    ['study for a while', undefined, ['for a while']],
    ['study all afternoon', undefined, ['all afternoon']],
    ['study for 1 hour and then YouTube', undefined, ['then YouTube']],
    ['study math for 1h and after that YouTube', 'math', ['after that YouTube']],
    ['study math and YouTube for 1 hour', 'math', ['YouTube']],
  ])('reports time words and later plans instead of a task: «%s»', (text, task, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('study');
    expect(result.task).toBe(task);
    expect(result.serviceIds).toEqual([]);
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });
});

describe('English phrases that are never a block', () => {
  it.each([
    'unblock YouTube',
    'unblock TikTok for 10 minutes',
    'remove the block on Instagram',
    'remove the YouTube block',
    'cancel my block',
    'end the block',
    "don't block YouTube for 1 hour",
    'stop blocking TikTok',
    "I don't want to block TikTok anymore",
    "I don't want YouTube blocked",
    'no more blocking',
  ])('treats «%s» as an unblock request', (text) => {
    expect(parse(text)).toMatchObject({ kind: 'unknown', complete: false });
  });

  it.each<[string, string[]]>([
    ['I want to watch YouTube for 1 hour', ['youtube']],
    ['watch Netflix for 2 hours', ['netflix']],
    ['let me play Fortnite for an hour', ['fortnite']],
    ["I'm going to play Minecraft for 1h", ['minecraft']],
    ['I need WhatsApp for 1 hour', ['whatsapp']],
    ['can I use Instagram for 10 minutes', ['instagram']],
    ['play lol for 1 hour', ['league-of-legends']],
    ['watching the news for 1 hour', []],
  ])('does not block what «%s» wants to use', (text, serviceIds) => {
    expect(parse(text)).toMatchObject({ kind: 'unknown', serviceIds, complete: false });
  });

  it.each<[string, 'block' | 'unknown', string[], string[]]>([
    ['block everything except WhatsApp for 2 hours', 'unknown', [], ['everything except WhatsApp']],
    ['block all but WhatsApp for 1 hour', 'unknown', [], ['all but WhatsApp']],
    ['no social media except WhatsApp for 1 hour', 'block', ['social'], ['except WhatsApp']],
    [
      'no social media except for WhatsApp for 1 hour',
      'block',
      ['social'],
      ['except for WhatsApp'],
    ],
    ['no social media but not WhatsApp for 1 hour', 'block', ['social'], ['but not WhatsApp']],
    [
      'no social media but let me use WhatsApp for 1 hour',
      'block',
      ['social'],
      ['but let me use WhatsApp'],
    ],
    ['block social media, not WhatsApp, for 1 hour', 'block', ['social'], ['not WhatsApp']],
    ['no games apart from Minecraft for 1 hour', 'block', ['games'], ['apart from Minecraft']],
    ['no games other than Minecraft for 1 hour', 'block', ['games'], ['other than Minecraft']],
  ])('never blocks the exception: «%s»', (text, kind, categoryIds, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe(kind);
    expect(result.serviceIds).toEqual([]);
    expect(result.categoryIds).toEqual(categoryIds);
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });

  it('leaves later plans unread', () => {
    expect(parse('block YouTube for 1 hour and then Instagram')).toMatchObject({
      serviceIds: ['youtube'],
      unparsed: ['then Instagram'],
      complete: false,
    });
    expect(parse('no YouTube after 8pm')).toMatchObject({
      serviceIds: ['youtube'],
      unparsed: ['after 8pm'],
      complete: false,
    });
  });
});

describe('English phrases that stay incomplete', () => {
  it.each<[string, string[]]>([
    ['no YouTube for a while', ['for a while']],
    ['no YouTube in class', ['in class']],
    ['no YouTube later', ['later']],
    ['no YouTube tonight', ['tonight']],
    ['no YouTube until tomorrow', ['until tomorrow']],
    ['no YouTube for 1 hour in strict mode', ['in strict mode']],
    ['no YouTube for 45', ['for 45']],
  ])('«%s» reports what it did not understand', (text, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('block');
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });

  it.each<[string, string[]]>([
    ['hello', ['hello']],
    ['for an hour', []],
    ['block', []],
  ])('«%s» has no target', (text, unparsed) => {
    const result = parse(text);
    expect(result.kind).toBe('unknown');
    expect(result.serviceIds).toEqual([]);
    expect(result.unparsed).toEqual(unparsed);
    expect(result.complete).toBe(false);
  });
});

describe('rules shared with Spanish', () => {
  it('reads a service the category before it describes', () => {
    expect(parse('sin juegos en steam 1h')).toMatchObject({
      serviceIds: ['steam'],
      categoryIds: [],
      complete: true,
    });
  });

  it('does not trust a weak alias after a service and a link word', () => {
    expect(parse('no veo tiktok en el insti')).toMatchObject({
      serviceIds: ['tiktok'],
      unparsed: ['en el insti'],
    });
  });
});
