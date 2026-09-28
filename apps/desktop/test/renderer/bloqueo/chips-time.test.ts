import { describe, expect, it } from 'vitest';
import { parseIntent } from '@centrate/shared/parser';
import { HARNESS_NOW } from '../../../src/shared/fixtures';
import {
  draftChips,
  estimateTextWidth,
  fitChips,
  typingChips,
  type ChipView,
} from '../../../src/renderer/src/sections/bloqueo/chips';
import {
  calendarDaysBetween,
  endsPhrase,
  untilPhrase,
  untilShort,
  whenLabel,
} from '../../../src/renderer/src/sections/bloqueo/time';
import { DEFAULT_PREFS, DEFAULT_TEMPLATES, draftFromTemplate } from '../../../src/shared/ui-state';

const NOW = HARNESS_NOW; // Monday 17:00 Madrid.
const H = 3_600_000;

function parse(text: string) {
  return parseIntent(text, { now: new Date(NOW) });
}

describe('typingChips', () => {
  it('lists targets, then duration and the end it gives', () => {
    const chips = typingChips(parse('nada de TikTok ni Instagram durante 45 minutos'), NOW);
    expect(chips.map((c) => [c.kind, c.label])).toEqual([
      ['service', 'TikTok'],
      ['service', 'Instagram'],
      ['duration', '45 min'],
      ['until', 'hasta 17:45'],
    ]);
    expect(chips[0]?.monogram).toBeTruthy();
  });

  it('shows the duration of a clock end, pointing at the same words', () => {
    const text = 'bloquea las redes sociales hasta las 20:30';
    const chips = typingChips(parse(text), NOW);
    expect(chips.map((c) => c.label)).toEqual(['Redes sociales', '3 h 30 min', 'hasta 20:30']);
    expect(chips[0]).toMatchObject({ kind: 'category', categoryId: 'social' });
    const until = chips[2];
    expect(until?.span && text.slice(until.span.start, until.span.end)).toBe('hasta las 20:30');
    expect(chips[1]?.span).toEqual(until?.span);
  });

  it('keeps the study task and domains', () => {
    expect(typingChips(parse('estudiar mates 1 hora'), NOW).map((c) => c.kind)).toEqual([
      'task',
      'duration',
      'until',
    ]);
    expect(typingChips(parse('no veo marca.com 1h'), NOW)[0]).toMatchObject({
      kind: 'domain',
      label: 'marca.com',
    });
  });

  it('is empty when nothing was understood', () => {
    expect(typingChips(parse('hola'), NOW)).toEqual([]);
  });
});

describe('draftChips', () => {
  it('shows the whitelist, then duration and end, each editable', () => {
    const exam = DEFAULT_TEMPLATES.find((t) => t.id === 'examen');
    if (!exam) throw new Error('missing');
    const chips = draftChips(draftFromTemplate(exam, DEFAULT_PREFS), NOW);
    expect(chips.map((c) => [c.label, c.field])).toEqual([
      ['Todo salvo la lista blanca', 'targets'],
      ['3 h', 'duration'],
      ['hasta 20:00', 'end'],
    ]);
  });

  it('names categories', () => {
    const deberes = DEFAULT_TEMPLATES[0];
    if (!deberes) throw new Error('missing');
    const chips = draftChips(draftFromTemplate(deberes, DEFAULT_PREFS), NOW);
    expect(chips.map((c) => c.label)).toEqual([
      'Redes sociales',
      'Vídeo y streaming',
      'Juegos',
      'Mensajería',
      '1 h',
      'hasta 18:00',
    ]);
  });
});

describe('fitting one line', () => {
  it('estimates more for longer and bolder text', () => {
    expect(estimateTextWidth('YouTube', 12)).toBeLessThan(
      estimateTextWidth('YouTube, Instagram', 12),
    );
    expect(estimateTextWidth('Bloqueo', 13)).toBeLessThan(estimateTextWidth('Bloqueo', 13, true));
    expect(estimateTextWidth('', 13)).toBe(0);
  });

  it('keeps chips that fit and hides targets behind «+N» otherwise', () => {
    const chips = typingChips(
      parse('no veo tiktok ni youtube ni instagram ni twitch ni netflix 1h'),
      NOW,
    );
    expect(fitChips(chips, 10_000)).toEqual(chips);
    const fitted = fitChips(chips, 260);
    const labels = fitted.map((c: ChipView) => c.label);
    expect(labels.slice(-2)).toEqual(['1 h', 'hasta 18:00']);
    expect(labels.some((l) => /^\+\d$/.test(l))).toBe(true);
    const hidden = Number(labels.find((l) => l.startsWith('+'))?.slice(1));
    expect(labels.length - 1 - 2 + hidden).toBe(5);
  });
});

describe('time phrases', () => {
  it('counts local calendar days', () => {
    expect(calendarDaysBetween(NOW, NOW + 6 * H)).toBe(0);
    expect(calendarDaysBetween(NOW, NOW + 8 * H)).toBe(1);
  });

  it('words the next schedule', () => {
    expect(whenLabel(NOW + H, NOW)).toBe('18:00');
    expect(whenLabel(NOW + 23 * H, NOW)).toBe('mañana 16:00');
    expect(whenLabel(NOW + 71 * H, NOW)).toMatch(/^jue\.? 16:00$/);
  });

  it('words end times for the consequence and undo lines', () => {
    expect(endsPhrase(NOW + 6 * H, NOW)).toBe('a las 23:00');
    expect(endsPhrase(NOW + 7 * H, NOW)).toBe('a las 00:00');
    expect(endsPhrase(NOW + 15 * H, NOW)).toBe('mañana a las 08:00');
    expect(untilPhrase(NOW + 1.5 * H, NOW)).toBe('hasta las 18:30');
    expect(untilPhrase(NOW + 15 * H, NOW)).toBe('hasta mañana a las 08:00');
    expect(untilShort(NOW + 42 * 60_000 + 10_000, NOW)).toBe('hasta 17:42');
  });
});
