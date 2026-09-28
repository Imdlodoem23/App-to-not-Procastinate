import {
  addDays,
  daysBetween,
  isLocalDay,
  isoWeekOf,
  isoWeekRange,
  isValidTimeZone,
  localDayIn,
} from '@centrate/shared/cloud-api';
import { describe, expect, it } from 'vitest';

describe('ISO weeks', () => {
  it('handles 53-week years and year boundaries', () => {
    expect(isoWeekRange('2026-W53')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(isoWeekOf('2027-01-03')).toBe('2026-W53');
    expect(isoWeekOf('2027-01-04')).toBe('2027-W01');
    expect(isoWeekOf('2024-12-30')).toBe('2025-W01');
    expect(isoWeekRange('2025-W01')).toEqual({ from: '2024-12-30', to: '2025-01-05' });
    expect(isoWeekRange('2026-W40')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });

  it('rejects weeks a year does not have and malformed input', () => {
    expect(isoWeekRange('2027-W53')).toBeNull();
    expect(isoWeekRange('2026-W00')).toBeNull();
    expect(isoWeekRange('2026-40')).toBeNull();
    expect(() => isoWeekOf('2026-02-30')).toThrow(RangeError);
  });

  it('round-trips every day of several years', () => {
    for (let day = '2024-01-01'; day < '2028-01-01'; day = addDays(day, 1)) {
      const range = isoWeekRange(isoWeekOf(day));
      expect(range).not.toBeNull();
      expect(daysBetween(range!.from, day)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(day, range!.to)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('local days', () => {
  it('validates days and zones', () => {
    expect(isLocalDay('2026-09-28')).toBe(true);
    expect(isLocalDay('2026-9-28')).toBe(false);
    expect(isLocalDay('2026-02-29')).toBe(false);
    expect(isValidTimeZone('Europe/Madrid')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('computes the civil date in a zone', () => {
    const at = new Date('2026-09-27T22:30:00.000Z');
    expect(localDayIn('Europe/Madrid', at)).toBe('2026-09-28');
    expect(localDayIn('America/New_York', at)).toBe('2026-09-27');
    expect(localDayIn('UTC', at)).toBe('2026-09-27');
  });
});
