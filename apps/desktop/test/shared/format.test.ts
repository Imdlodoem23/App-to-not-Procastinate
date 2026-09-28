import { emptyTargets } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { HARNESS_NOW } from '../../src/shared/fixtures';
import {
  MINUS,
  TICK_EPSILON_MS,
  countdownAnnouncement,
  countdownAria,
  formatClock,
  formatInt,
  formatPoints,
  formatPointsShort,
  formatRemaining,
  modeLabel,
  nextTickDelay,
  splitCountdown,
  targetsLabel,
} from '../../src/shared/format';

const MIN = 60_000;

describe('numbers', () => {
  it('groups always and uses the typographic minus', () => {
    expect(formatInt(1240)).toBe('1.240');
    expect(formatInt(12)).toBe('12');
    expect(formatInt(-340)).toBe(`${MINUS}340`);
    expect(formatInt(0)).toBe('0');
    expect(formatPoints(1240)).toBe('1.240 puntos');
    expect(formatPoints(1)).toBe('1 punto');
    expect(formatPoints(80, { signed: true })).toBe('+80 puntos');
    expect(formatPoints(-10, { signed: true })).toBe(`${MINUS}10 puntos`);
    expect(formatPointsShort(1240)).toBe('1.240 pts');
    expect(formatPoints(-100, { signed: true })).not.toContain('-');
  });

  it('formats 24 h clock times in the local zone', () => {
    expect(formatClock(HARNESS_NOW)).toBe('17:00');
    expect(formatClock(HARNESS_NOW + 42 * MIN)).toBe('17:42');
    expect(formatClock(HARNESS_NOW + 15 * 60 * MIN + 5 * MIN)).toBe('08:05');
  });
});

describe('countdown', () => {
  it('shows M:SS under an hour and H:MM:SS above, rounded up', () => {
    expect(splitCountdown(42 * MIN + 10_000)).toEqual({
      lead: '42',
      seconds: ':10',
      text: '42:10',
    });
    expect(splitCountdown(62 * MIN + 3_000).text).toBe('1:02:03');
    expect(splitCountdown(59 * MIN + 59_200).text).toBe('1:00:00');
    expect(splitCountdown(59 * MIN + 59_000).text).toBe('59:59');
    expect(splitCountdown(1).text).toBe('0:01');
    expect(splitCountdown(0).text).toBe('0:00');
    expect(splitCountdown(-5_000).text).toBe('0:00');
  });

  it('schedules the next tick just after the displayed second changes', () => {
    expect(nextTickDelay(42_010_500)).toBe(500 + TICK_EPSILON_MS);
    expect(nextTickDelay(42_010_000)).toBe(1_000 + TICK_EPSILON_MS);
    expect(nextTickDelay(0)).toBeNull();
  });

  it('never skips or repeats a second over an hour with late timers (drift 0)', () => {
    let seed = 7;
    const jitter = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % 41; // 0–40 ms late
    };
    const endsAt = 3_600_000 + 123;
    let now = 0;
    let shown = splitCountdown(endsAt - now).text;
    let seconds = Math.ceil((endsAt - now) / 1000);
    for (;;) {
      const delay = nextTickDelay(endsAt - now);
      if (delay === null) break;
      now += delay + jitter();
      const next = Math.ceil(Math.max(0, endsAt - now) / 1000);
      expect(next).toBe(seconds - 1);
      seconds = next;
      shown = splitCountdown(endsAt - now).text;
    }
    expect(shown).toBe('0:00');
    expect(now - endsAt).toBeLessThan(50);
  });

  it('speaks minutes for screen readers only at 15, 5 and 1 min and at the end', () => {
    expect(countdownAria(42 * MIN + 10_000)).toBe('Quedan 43 minutos');
    expect(countdownAria(65 * MIN)).toBe('Quedan 1 hora y 5 minutos');
    expect(countdownAria(60 * MIN)).toBe('Queda 1 hora');
    expect(countdownAria(120 * MIN)).toBe('Quedan 2 horas');
    expect(countdownAria(30_000)).toBe('Queda 1 minuto');
    expect(countdownAnnouncement(15 * MIN + 1, 15 * MIN)).toBe('Quedan 15 minutos');
    expect(countdownAnnouncement(5 * MIN + 500, 5 * MIN - 500)).toBe('Quedan 5 minutos');
    expect(countdownAnnouncement(20 * MIN, 30_000)).toBe('Queda 1 minuto');
    expect(countdownAnnouncement(1_000, 0)).toBe('Bloqueo terminado');
    expect(countdownAnnouncement(14 * MIN, 13 * MIN)).toBeNull();
  });

  it('words the remaining time like the title and tooltip', () => {
    expect(formatRemaining(42 * MIN + 10_000)).toBe('quedan 43 min');
    expect(formatRemaining(30_000)).toBe('queda 1 min');
    expect(formatRemaining(65 * MIN)).toBe('quedan 1 h 5 min');
  });
});

describe('labels', () => {
  it('names modes and targets without clipping', () => {
    expect(modeLabel('strict')).toBe('Estricto');
    const t = { ...emptyTargets(), serviceIds: ['youtube', 'instagram'] };
    expect(targetsLabel(t, false)).toBe('YouTube, Instagram');
    expect(
      targetsLabel({ ...t, serviceIds: ['youtube', 'instagram', 'tiktok', 'netflix'] }, false),
    ).toBe('YouTube, Instagram +2');
    expect(targetsLabel({ ...emptyTargets(), categoryIds: ['social'] }, false)).toBe(
      'Redes sociales',
    );
    expect(targetsLabel(emptyTargets(), true)).toBe('Todo salvo la lista blanca');
    expect(targetsLabel({ ...emptyTargets(), customDomains: ['marca.com'] }, false)).toBe(
      'marca.com',
    );
  });
});
