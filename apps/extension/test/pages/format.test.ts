import { describe, expect, it } from 'vitest';
import {
  MINUS,
  countdownAnnouncement,
  countdownAria,
  formatInt,
  formatPoints,
  formatRemaining,
  formatRemainingProse,
  formatUntil,
  nextMinuteDelay,
  nextTickDelay,
  parseIso,
  remainingMinutes,
  splitCountdown,
} from '../../src/pages/shared/format';

const S = 1_000;
const M = 60 * S;

describe('numbers and points', () => {
  it('groups thousands in es-ES and uses the typographic minus', () => {
    expect(formatInt(1240)).toBe('1.240');
    expect(formatInt(-340)).toBe(`${MINUS}340`);
    expect(formatInt(-0.4)).toBe('0');
    expect(MINUS).toBe('−');
  });

  it('writes points like the app', () => {
    expect(formatPoints(-10)).toBe('−10 puntos');
    expect(formatPoints(-1)).toBe('−1 punto');
    expect(formatPoints(-1240)).toBe('−1.240 puntos');
    expect(formatPoints(80, { signed: true })).toBe('+80 puntos');
    expect(formatPoints(-10)).not.toContain('-');
  });
});

describe('countdown', () => {
  it('is M:SS under an hour and H:MM:SS above, rounded up to the second', () => {
    expect(splitCountdown(42 * M + 16_200)).toEqual({ lead: '42', seconds: ':17', text: '42:17' });
    expect(splitCountdown(59 * M + 59_001).text).toBe('1:00:00');
    expect(splitCountdown(2 * 60 * M + 4 * M + 51 * S).text).toBe('2:04:51');
    expect(splitCountdown(1).text).toBe('0:01');
    expect(splitCountdown(0).text).toBe('0:00');
    expect(splitCountdown(-5 * S).text).toBe('0:00');
  });

  it('never says 0 minutes while time is left', () => {
    expect(remainingMinutes(1)).toBe(1);
    expect(remainingMinutes(0)).toBe(0);
    expect(formatRemaining(42 * M + 10 * S)).toBe('quedan 43 min');
    expect(formatRemaining(30 * S)).toBe('queda 1 min');
    expect(formatRemaining(65 * M)).toBe('quedan 1 h 5 min');
    expect(formatRemaining(120 * M)).toBe('quedan 2 h');
  });

  it('labels the timer and the humor lines in words', () => {
    expect(countdownAria(42 * M + 1)).toBe('Quedan 43 minutos');
    expect(countdownAria(30 * S)).toBe('Queda 1 minuto');
    expect(countdownAria(60 * M)).toBe('Queda 1 hora');
    expect(countdownAria(65 * M)).toBe('Quedan 1 hora y 5 minutos');
    expect(formatRemainingProse(125 * M)).toBe('2 horas y 5 minutos');
    expect(formatRemainingProse(43 * M)).toBe('43 minutos');
  });

  it('schedules the next tick just after the displayed second changes', () => {
    expect(nextTickDelay(10_250)).toBe(254);
    expect(nextTickDelay(10_000)).toBe(1_004);
    expect(nextTickDelay(0)).toBeNull();
  });

  it('speaks only at 15, 5 and 1 min; crossing 0 is not the end (phase.ts says that)', () => {
    expect(countdownAnnouncement(15 * M + 1, 15 * M)).toBe('Quedan 15 minutos');
    expect(countdownAnnouncement(5 * M + 500, 4 * M)).toBe('Quedan 5 minutos');
    expect(countdownAnnouncement(M + 1, M - 1)).toBe('Queda 1 minuto');
    // The block may still be enforced at 0 («Comprobando la hora…»).
    expect(countdownAnnouncement(1_000, 0)).toBeNull();
    expect(countdownAnnouncement(20 * M, 0)).toBeNull();
    expect(countdownAnnouncement(14 * M, 13 * M)).toBeNull();
    // Waking from sleep across several marks reads only the lowest.
    expect(countdownAnnouncement(20 * M, 3 * M)).toBe('Quedan 5 minutos');
  });
});

describe('minute ticks (blocked.html: «quedan N min», no seconds)', () => {
  it('fires just after the rounded-up minutes change', () => {
    // 42:10 left reads «quedan 43 min» until 42:00, i.e. 10 s from now.
    expect(nextMinuteDelay(42 * M + 10 * S)).toBe(10 * S + 4);
    expect(formatRemaining(42 * M + 10 * S - (10 * S + 4))).toBe('quedan 42 min');
    expect(nextMinuteDelay(42 * M)).toBe(M + 4);
    expect(nextMinuteDelay(59 * S)).toBe(59 * S + 4);
    expect(nextMinuteDelay(0)).toBeNull();
    expect(nextMinuteDelay(-5)).toBeNull();
  });

  it('lands on every mark the live region announces (15, 5 and 1 min) and on the end', () => {
    let remaining = 16 * M + 30 * S;
    let previous = remaining;
    const said: string[] = [];
    for (
      let delay = nextMinuteDelay(remaining);
      delay !== null;
      delay = nextMinuteDelay(remaining)
    ) {
      remaining = Math.max(0, remaining - delay);
      const line = countdownAnnouncement(previous, remaining);
      if (line !== null) said.push(line);
      previous = remaining;
    }
    expect(said).toEqual(['Quedan 15 minutos', 'Quedan 5 minutos', 'Queda 1 minuto']);
    // The last tick lands on the end: the page then re-evaluates checking / ended.
    expect(remaining).toBe(0);
  });
});

describe('clock', () => {
  it('shows «hasta HH:MM» in 24 h', () => {
    const now = new Date(2026, 8, 28, 16, 0).getTime();
    expect(formatUntil(new Date(2026, 8, 28, 17, 42).getTime(), now)).toBe('hasta 17:42');
    expect(formatUntil(new Date(2026, 8, 29, 8, 0).getTime(), now)).toBe('hasta mañana 08:00');
  });

  it('parses guardian times', () => {
    expect(parseIso('2026-09-28T15:00:00Z')).toBe(Date.parse('2026-09-28T15:00:00Z'));
    expect(parseIso('nope')).toBeNull();
    expect(parseIso(null)).toBeNull();
  });
});
