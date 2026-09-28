import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, evaluateAchievements, type AchievementId } from '@centrate/shared/points';
import { HARNESS_NOW, harnessFixture, makeAchievements } from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import type { AchievementStatus } from '../../../src/shared/platform';
import {
  LGR_IDS,
  assignKeys,
  deriveLogrosView,
  formatAchievedDay,
  loadErrorText,
  progressText,
  type LogrosInput,
  type LogrosView,
} from '../../../src/renderer/src/windows/logros/view';

const fixture = harnessFixture('logros');
const LIST = fixture.local.achievements;

function view(patch: Partial<LogrosInput> = {}): LogrosView {
  return deriveLogrosView({
    list: LIST,
    progress: fixture.snapshot.progress,
    fresh: [],
    focus: null,
    ...patch,
  });
}

function achievement(id: AchievementId) {
  const found = ACHIEVEMENTS.find((a) => a.id === id);
  if (!found) throw new Error(id);
  return found;
}

describe('Logros: the grid', () => {
  it('shows every achievement of points.ts, in its order, 3 of 8 reached', () => {
    const v = view();
    expect(v.title).toBe('Logros: 3 de 8');
    expect(v.datum).toBe('Último: Una semana sin intentos');
    expect(v.datumFresh).toBe(false);
    expect(v.tiles.map((t) => [t.id, t.title, t.achieved])).toEqual([
      ['first-session', 'Primera sesión', false],
      ['first-block', 'Primer bloqueo', true],
      ['streak-7', '7 días de racha', true],
      ['study-10h', '10 h de Study Mode', false],
      ['clean-week', 'Una semana sin intentos', true],
      ['sessions-25', '25 sesiones', false],
      ['streak-30', '30 días de racha', false],
      ['study-50h', '50 h de Study Mode', false],
    ]);
    expect(v.tiles.map((t) => t.id)).toEqual(ACHIEVEMENTS.map((a) => a.id));
    expect(v.rowHelp).toBe('Pasa el ratón por un logro para ver cómo se consigue');
    expect(v.focus).toBeNull();
  });

  it('says how to get the pending ones and how far you are («12 de 30»)', () => {
    const help = Object.fromEntries(view().tiles.map((t) => [t.id, t.help]));
    expect(help['streak-30']).toBe('Cumple tu objetivo diario 30 días seguidos · 12 de 30');
    expect(help['first-session']).toBe('Termina una sesión de Study Mode');
    expect(help['sessions-25']).toBe('Termina 25 sesiones de Study Mode · 0 de 25');
    expect(help['study-10h']).toBe('Suma 10 h concentrado en Study Mode · 0 de 10 h');
    // The fixture's help focus is the «12 de 30» one.
    expect(fixture.detail.help).toEqual({ row: LGR_IDS.row, item: 'streak-30' });
  });

  it('says when you got the reached ones', () => {
    const help = Object.fromEntries(view().tiles.map((t) => [t.id, t.help]));
    expect(help['clean-week']).toBe('Conseguido el 24 de septiembre');
    expect(help['streak-7']).toBe('Conseguido el 19 de septiembre');
    const undated = LIST.map((s) => (s.id === 'first-block' ? { ...s, achievedAt: null } : s));
    expect(view({ list: undated }).tiles.find((t) => t.id === 'first-block')?.help).toBe(
      'Conseguido',
    );
  });

  it('counts study minutes as durations and caps the progress at the threshold', () => {
    expect(progressText(achievement('study-10h'), 150)).toBe('2 h 30 min de 10 h');
    expect(progressText(achievement('study-50h'), 0)).toBe('0 de 50 h');
    expect(progressText(achievement('streak-30'), 45)).toBe('30 de 30');
    expect(progressText(achievement('first-block'), 0)).toBeNull();
  });

  it('agrees with evaluateAchievements over the same metrics', () => {
    const list: AchievementStatus[] = evaluateAchievements({
      completedStudySessions: 3,
      completedBlocks: 12,
      focusMinutesTotal: 640,
      bestStreakDays: 8,
      bestCleanDayRun: 2,
    }).map((s) => ({ ...s, achievedAt: null }));
    const v = view({ list });
    expect(v.title).toBe('Logros: 4 de 8');
    expect(v.tiles.filter((t) => t.achieved).map((t) => t.id)).toEqual([
      'first-session',
      'first-block',
      'streak-7',
      'study-10h',
    ]);
    expect(v.datum).toBeNull();
    expect(v.tiles.find((t) => t.id === 'study-50h')?.help).toBe(
      'Suma 50 h concentrado en Study Mode · 10 h 40 min de 50 h',
    );
  });

  it('marks the new ones and opens on them', () => {
    const fresh = makeAchievements(HARNESS_NOW, { fresh: true });
    const one = view({ list: fresh, fresh: ['clean-week'] });
    expect(one.datum).toBe('Nuevo: Una semana sin intentos');
    expect(one.datumFresh).toBe(true);
    expect(one.focus).toBe('clean-week');
    expect(one.tiles.find((t) => t.id === 'clean-week')).toMatchObject({
      fresh: true,
      help: 'Nuevo: conseguido el 28 de septiembre',
    });
    const two = view({ fresh: ['streak-7', 'clean-week'] });
    expect(two.datum).toBe('2 logros nuevos');
    expect(two.focus).toBe('streak-7');
    // A «new» id that is not reached (stale) is ignored.
    expect(view({ fresh: ['streak-30'] }).datum).toBe('Último: Una semana sin intentos');
  });

  it('opens on the requested achievement (a «¡Logro!» notification)', () => {
    expect(view({ focus: 'streak-7' }).focus).toBe('streak-7');
    expect(view({ focus: 'streak-7', fresh: ['clean-week'] }).focus).toBe('streak-7');
  });

  it('shows the count from main while the list loads, and nothing to press', () => {
    const loading = view({ list: null });
    expect(loading.title).toBe('Logros: 3 de 8');
    expect(loading.tiles).toEqual([]);
    expect(view({ list: null, progress: null }).title).toBe('Logros');
    expect(loadErrorText()).toBe('No he podido leer tus logros');
  });

  it('with none reached, invites to look at how to get them', () => {
    const none = LIST.map((s) => ({ ...s, achieved: false, achievedAt: null }));
    const v = view({ list: none });
    expect(v.title).toBe('Logros: 0 de 8');
    expect(v.datum).toBeNull();
    expect(v.rowHelp).toBe(
      'Aún no tienes ninguno: pasa el ratón por uno para ver cómo se consigue',
    );
  });
});

describe('Logros: Alt + keys', () => {
  it('gives every tile a unique key from its name, in both languages', () => {
    for (const locale of ['es', 'en'] as const) {
      withLocale(locale, () => {
        const tiles = view().tiles;
        const keys = tiles.map((t) => t.mnemonic);
        expect(keys.every((k) => typeof k === 'string' && /^[a-z0-9]$/.test(k))).toBe(true);
        expect(new Set(keys).size).toBe(keys.length);
        for (const t of tiles) {
          const folded = t.title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
          expect(folded).toContain(t.mnemonic);
        }
      });
    }
    expect(view().tiles.map((t) => t.mnemonic)).toEqual(['p', 'r', '7', '1', 'u', '2', '3', '5']);
  });

  it('skips taken and accented letters sensibly', () => {
    expect(assignKeys(['Ábaco', 'abc', 'ab'], ['b'])).toEqual(['a', 'c', undefined]);
  });
});

describe('Logros in English', () => {
  it('reads the title, the datum and the help', () => {
    withLocale('en', () => {
      const v = view();
      expect(v.title).toBe('Achievements: 3 of 8');
      expect(v.datum).toBe('Latest: A week without attempts');
      expect(v.tiles.find((t) => t.id === 'streak-30')?.help).toBe(
        'Meet your daily goal 30 days in a row · 12 of 30',
      );
      expect(formatAchievedDay(Date.parse('2026-09-24T10:00:00Z'))).toBe('September 24');
    });
    expect(formatAchievedDay(Date.parse('2026-09-24T10:00:00Z'))).toBe('24 de septiembre');
  });
});
