import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, MASCOT_RULES } from '@centrate/shared/points';
import {
  HARNESS_STATE_IDS,
  harnessFixture,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import type { UiSnapshot } from '../../../src/shared/ui-state';
import { mascotStageOf, minutesToGrow } from '../../../src/renderer/src/components/mascot/stage';
import { RENDERER } from '../../../src/renderer/src/i18n/messages';
import { deriveBloqueoView } from '../../../src/renderer/src/sections/bloqueo/view';
import {
  PROGRESO_DOOR_VIEWS,
  deriveProgresoView,
  progresoMnemonics,
} from '../../../src/renderer/src/sections/progreso/view';
import { PROGRESO_EN } from '../../../src/renderer/src/sections/progreso/i18n/en';
import { PROGRESO_ES } from '../../../src/renderer/src/sections/progreso/i18n/es';

function snapshotOf(id: HarnessStateId): UiSnapshot {
  return harnessFixture(id).snapshot;
}

function withPoints(
  base: UiSnapshot,
  today: { focusMinutes: number; goalMinutes?: number },
  progress: UiSnapshot['progress'] = null,
): UiSnapshot {
  if (!base.state) throw new Error('fixture without state');
  const points = base.state.points;
  return {
    ...base,
    progress,
    state: {
      ...base.state,
      points: { ...points, today: { ...points.today, goalMinutes: 60, ...today } },
    },
  };
}

function door(snapshot: UiSnapshot, id: 'stats' | 'rewards' | 'achievements') {
  const found = deriveProgresoView(snapshot)?.doors.find((d) => d.id === id);
  if (!found) throw new Error(`no ${id} door`);
  return found;
}

describe('the mascot in the Progreso header', () => {
  it('takes main’s phase when it has read the log', () => {
    const base = snapshotOf('idle');
    const progress = { mascot: 'wilted' as const, achieved: 3, total: 8, fresh: [] };
    expect(mascotStageOf(withPoints(base, { focusMinutes: 60 }, progress))).toBe('wilted');
    expect(deriveProgresoView(withPoints(base, { focusMinutes: 60 }, progress))?.phase).toBe(
      'wilted',
    );
  });

  it('grows with today’s minutes until main has read the log (no wilting from the poll)', () => {
    const base = snapshotOf('idle');
    expect(mascotStageOf(withPoints(base, { focusMinutes: 0 }))).toBe('sprout');
    expect(mascotStageOf(withPoints(base, { focusMinutes: 29 }))).toBe('sprout');
    expect(mascotStageOf(withPoints(base, { focusMinutes: 30 }))).toBe('plant');
    expect(mascotStageOf(withPoints(base, { focusMinutes: 60 }))).toBe('tree');
    expect(mascotStageOf({ progress: null, state: null })).toBeNull();
  });

  it('says how many minutes the next phase needs', () => {
    const today = { focusMinutes: 42, goalMinutes: 60 };
    expect(minutesToGrow('plant', today)).toBe(18);
    expect(minutesToGrow('sprout', { focusMinutes: 10, goalMinutes: 60 })).toBe(
      Math.ceil((60 * MASCOT_RULES.plantAtGoalPercent) / 100) - 10,
    );
    expect(minutesToGrow('tree', today)).toBeNull();
    expect(minutesToGrow('wilted', today)).toBeNull();
    // Main's phase and the poll disagree for a moment: nothing left, nothing said.
    expect(minutesToGrow('plant', { focusMinutes: 60, goalMinutes: 60 })).toBeNull();
  });

  it('follows the fixtures: a plant at 42 of 60 min, wilted in the red', () => {
    expect(deriveProgresoView(snapshotOf('idle'))?.phase).toBe('plant');
    expect(deriveProgresoView(snapshotOf('negative-points'))?.phase).toBe('wilted');
  });
});

describe('the Progreso doors', () => {
  it('open Estadísticas, Recompensas and Logros with their default requests', () => {
    const view = deriveProgresoView(snapshotOf('idle'));
    expect(view?.doors.map((d) => d.request)).toEqual([
      { name: 'estadisticas', range: null },
      { name: 'recompensas' },
      { name: 'logros', focus: null },
    ]);
    expect(view?.doors.map((d) => PROGRESO_DOOR_VIEWS[d.id])).toEqual([
      'estadisticas',
      'recompensas',
      'logros',
    ]);
  });

  it('say on the help line what is behind them', () => {
    const idle = snapshotOf('idle');
    expect(door(idle, 'stats').help).toBe('Tiempo concentrado por día, semana y mes');
    expect(door(idle, 'rewards').help).toBe('Canjea tus puntos por descansos ganados');
    expect(door(idle, 'achievements').help).toBe(
      `3 de ${ACHIEVEMENTS.length} conseguidos: mira cómo lograr el resto`,
    );
    const noProgress = { ...idle, progress: null };
    expect(door(noProgress, 'achievements').help).toBe(RENDERER.progreso.doorsHelp.achievements);
  });

  it('say why the shop is closed (Hardcore, examen, castigo, emergencia…)', () => {
    expect(door(snapshotOf('punishment'), 'rewards').help).toBe(
      'Cerradas mientras dure el castigo',
    );
    const idle = snapshotOf('idle');
    if (!idle.state) throw new Error('no state');
    for (const [lock, text] of Object.entries(PROGRESO_ES.rewardsLocked)) {
      const locked = { ...idle, state: { ...idle.state, rewardsLock: lock as 'exam' } };
      expect(door(locked, 'rewards').help).toBe(text);
    }
  });

  it('point Logros at a new achievement', () => {
    const idle = snapshotOf('idle');
    const one = {
      ...idle,
      progress: { mascot: 'plant' as const, achieved: 4, total: 8, fresh: ['streak-7' as const] },
    };
    expect(door(one, 'achievements')).toMatchObject({
      help: 'Logro nuevo: 7 días de racha',
      request: { name: 'logros', focus: 'streak-7' },
    });
    const two = {
      ...idle,
      progress: {
        mascot: 'plant' as const,
        achieved: 5,
        total: 8,
        fresh: ['streak-7' as const, 'clean-week' as const],
      },
    };
    expect(door(two, 'achievements')).toMatchObject({
      help: '2 logros nuevos',
      request: { name: 'logros', focus: 'streak-7' },
    });
  });

  it('have unique Alt + keys that sections 1 and 2 and the footer never use', () => {
    for (const locale of ['es', 'en'] as const) {
      withLocale(locale, () => {
        const doors = progresoMnemonics();
        const shell = [
          ...Object.values(RENDERER.protection.mnemonics),
          ...Object.values(RENDERER.footer.mnemonics),
        ];
        expect(new Set(doors).size).toBe(doors.length);
        expect(doors.filter((k) => shell.includes(k))).toEqual([]);
        // Section 2 picks the first free letter of its labels: in no fixture one of these.
        for (const id of HARNESS_STATE_IDS) {
          const f = harnessFixture(id);
          const keys: string[] = [];
          JSON.stringify(
            deriveBloqueoView({ snapshot: f.snapshot, main: f.main }, f.nowMs),
            (k, v) => {
              if (k === 'mnemonic' && typeof v === 'string') keys.push(v);
              return v;
            },
          );
          expect(
            doors.filter((k) => keys.includes(k)),
            `${locale} ${id}`,
          ).toEqual([]);
        }
      });
    }
    // Underlined while Alt is held where the label has the letter (all but «Recompensas…»,
    // whose letters section 2 uses).
    const underlined = (locale: 'es' | 'en') =>
      withLocale(locale, () =>
        (deriveProgresoView(snapshotOf('idle'))?.doors ?? [])
          .filter((d) => d.label.toLowerCase().includes(d.mnemonic))
          .map((d) => d.id),
      );
    expect(underlined('es')).toEqual(['stats', 'achievements']);
    expect(underlined('en')).toEqual(['stats', 'rewards', 'achievements']);
  });

  it('read in English', () => {
    withLocale('en', () => {
      const view = deriveProgresoView(snapshotOf('idle'));
      expect(view?.doors.map((d) => [d.label, d.mnemonic])).toEqual([
        ['Statistics…', PROGRESO_EN.mnemonics.stats],
        ['Rewards…', PROGRESO_EN.mnemonics.rewards],
        ['Achievements…', PROGRESO_EN.mnemonics.achievements],
      ]);
      expect(door(snapshotOf('punishment'), 'rewards').help).toBe(
        'Closed while the punishment lasts',
      );
      expect(deriveProgresoView(snapshotOf('negative-points'))).toMatchObject({
        pill: 'In the red',
        negative: true,
      });
    });
  });
});
