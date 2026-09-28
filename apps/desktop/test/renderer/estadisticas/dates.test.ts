import { describe, expect, it } from 'vitest';
import { withLocale } from '../../../src/shared/i18n/locale';
import {
  dayCount,
  dayParts,
  formatDayLong,
  formatHourRange,
  formatLogTime,
  formatPeriod,
  localDayOf,
} from '../../../src/renderer/src/windows/estadisticas/dates';

const TODAY = '2026-09-28';

describe('Estadísticas dates', () => {
  it('names local days without shifting them with the time zone', () => {
    expect(dayParts('2026-09-24')).toMatchObject({ weekdayShort: 'jue', day: 24, year: 2026 });
    expect(formatDayLong('2026-09-26')).toBe('Sábado 26 de septiembre');
    expect(localDayOf(Date.parse('2026-09-27T22:30:00Z'))).toBe('2026-09-28');
  });

  it('says the period in the header', () => {
    expect(formatPeriod('day', TODAY, TODAY)).toBe('hoy');
    expect(formatPeriod('day', '2026-09-27', TODAY)).toBe('ayer');
    expect(formatPeriod('day', '2026-09-24', TODAY)).toBe('jue 24 sept');
    expect(formatPeriod('day', '2025-09-24', TODAY)).toBe('mié 24 sept 2025');
    expect(formatPeriod('week', '2026-09-23', TODAY)).toBe('21–27 sept');
    expect(formatPeriod('week', TODAY, TODAY)).toBe('28 sept – 4 oct');
    expect(formatPeriod('month', '2026-02-10', TODAY)).toBe('febrero de 2026');
  });

  it('dates the event log relative to today', () => {
    expect(formatLogTime(Date.parse('2026-09-28T14:42:00Z'), TODAY)).toBe('hoy 16:42');
    expect(formatLogTime(Date.parse('2026-09-27T21:59:00Z'), TODAY)).toBe('ayer 23:59');
    expect(formatLogTime(Date.parse('2026-09-24T16:10:00Z'), TODAY)).toBe('24 sept 18:10');
  });

  it('writes hour ranges across midnight and counts days', () => {
    expect(formatHourRange(23)).toBe('23:00–00:00');
    expect(dayCount('2026-09-21', '2026-09-27')).toBe(7);
    expect(dayCount('2026-09-28', '2026-09-27')).toBe(0);
  });

  it('speaks English', () => {
    withLocale('en', () => {
      expect(formatPeriod('week', TODAY, TODAY)).toBe('Sep 28 – Oct 4');
      expect(formatPeriod('day', '2026-09-24', TODAY)).toBe('Thu, Sep 24');
      expect(formatPeriod('month', TODAY, TODAY)).toBe('September 2026');
      expect(formatDayLong('2026-09-26')).toBe('Saturday, September 26');
      expect(formatLogTime(Date.parse('2026-09-28T14:42:00Z'), TODAY)).toBe('today 4:42 PM');
      expect(formatHourRange(17)).toBe('5:00 PM–6:00 PM');
    });
  });
});
