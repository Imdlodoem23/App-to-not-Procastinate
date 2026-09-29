import { describe, expect, it } from 'vitest';
import type { PointsSummary } from '@centrate/shared/domain';
import { HARNESS_NOW, harnessFixture, makeStatsOverview } from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import { DEFAULT_PREFS, DEFAULT_TEMPLATES } from '../../../src/shared/ui-state';
import type { EventLogEntry, StatsHeatmap } from '../../../src/shared/stats';
import {
  deriveChart,
  deriveHeatmap,
  deriveHours,
  deriveLog,
  deriveNav,
  deriveTargets,
  effectiveAnchor,
  eventText,
  exportNotice,
  firstSessionDraft,
  isCurrentPeriod,
  logFilters,
  rangeOptions,
  summaryText,
  targetName,
  windowMnemonics,
  type ChartView,
  type SummaryItemView,
} from '../../../src/renderer/src/windows/estadisticas/view';
import { ESTADISTICAS_ES } from '../../../src/renderer/src/windows/estadisticas/i18n/es';
import { ESTADISTICAS_EN } from '../../../src/renderer/src/windows/estadisticas/i18n/en';

const TODAY = '2026-09-28';

function duplicateKeys(keys: readonly string[]): string[] {
  const lower = keys.map((k) => k.toLowerCase());
  return [...new Set(lower.filter((k, i) => lower.indexOf(k) !== i))];
}
const week = harnessFixture('stats-week');
const POINTS = week.snapshot.state?.points as PointsSummary;

function chart(
  range: 'day' | 'week' | 'month',
  overrides: { anchor?: string; points?: PointsSummary | null; study?: boolean } = {},
): ChartView {
  const overview =
    overrides.anchor !== undefined
      ? makeStatsOverview(range, overrides.anchor, HARNESS_NOW)
      : week.local.stats.overview[range];
  return deriveChart({
    overview,
    today: TODAY,
    points: overrides.points === undefined ? POINTS : overrides.points,
    goalMinutes: 60,
    studyEnabled: overrides.study ?? false,
  });
}

function summary(view: ChartView): Record<string, string> {
  return Object.fromEntries(
    view.summary.map((i: SummaryItemView) => [i.id, i.value.map((p) => p.text).join('')]),
  );
}

describe('Estadísticas: the chart section', () => {
  it('draws last week (stats-week): title, period, bars, axis and the text summary', () => {
    const view = chart('week');
    expect(view.title).toBe('Concentrado: 14 h');
    expect(view.datum).toBe('21–27 sept');
    expect(view.caption).toBe('Minutos concentrado por día');
    expect(view.bars.map((b) => b.minutes)).toEqual([110, 0, 175, 200, 195, 160, 0]);
    expect(view.ticks).toHaveLength(7);
    expect(Object.values(view.tickLabels)).toEqual([
      'lun 21',
      'mar 22',
      'mié 23',
      'jue 24',
      'vie 25',
      'sáb 26',
      'dom 27',
    ]);
    expect(view.maxKey).toBe('2026-09-24');
    expect(view.maxLabel).toBe('3 h 20 min');
    expect(view.bars[0]?.readout).toBe('Lunes 21: 1 h 50 min · 2 intentos');
    expect(view.bars[1]?.readout).toBe('Martes 22: 0 min');
    expect(summary(view)).toEqual({
      average: '2 h',
      best: 'jue 24 · 3 h 20 min',
      goal: '5 de 7 días',
      blocks: '9',
      attempts: '11',
      points: '+1.105 · −110',
    });
    const points = view.summary.find((i) => i.id === 'points');
    expect(points?.value.map((p) => p.tone)).toEqual(['green', 'muted', 'red']);
  });

  it('has a screen-reader twin: the summary as text and a table of every bar', () => {
    const view = chart('week');
    expect(summaryText(view.summary)).toContain('Mejor día: jue 24 · 3 h 20 min');
    expect(view.table.columns).toEqual(['Día', 'Concentrado', 'Intentos', 'Puntos']);
    expect(view.table.rows).toHaveLength(7);
    expect(view.table.rows[3]).toEqual(['Jueves 24', '3 h 20 min', '2', '+250']);
  });

  it('draws today hour by hour with 4 axis labels and today’s goal as Progreso shows it', () => {
    const view = chart('day');
    expect(view.datum).toBe('hoy');
    expect(view.bars).toHaveLength(24);
    expect(Object.values(view.tickLabels)).toEqual(['00:00', '06:00', '12:00', '18:00']);
    expect(view.caption).toBe('Minutos concentrado por hora');
    const s = summary(view);
    expect(s['best']).toBe('15:00 · 16 min');
    expect(s['goal']).toBe('42 min de 1 h');
    expect(view.summary.find((i) => i.id === 'goal')?.label).toBe('Objetivo de hoy');
    expect(view.bars[15]?.readout).toBe('15:00–16:00: 16 min');
  });

  it('draws a month with 5 axis labels and counts only closed days for the goal', () => {
    const view = chart('month');
    expect(view.datum).toBe('septiembre de 2026');
    expect(view.bars).toHaveLength(30);
    expect(Object.values(view.tickLabels)).toEqual(['1', '8', '15', '22', '29']);
    expect(summary(view)['goal']).toBe('22 de 27 días');
  });

  it('on the first day of a period shows today’s goal instead of «0 de 0 días»', () => {
    const view = chart('week', { anchor: TODAY });
    expect(view.datum).toBe('28 sept – 4 oct');
    expect(view.summary.find((i) => i.id === 'goal')?.label).toBe('Objetivo de hoy');
    expect(summary(view)['goal']).toBe('42 min de 1 h');
    const met = chart('week', {
      anchor: TODAY,
      points: { ...POINTS, today: { ...POINTS.today, focusMinutes: 60, goalMet: true } },
    });
    expect(summary(met)['goal']).toBe('cumplido');
  });

  it('adds the Study Mode minutes only with the study flag', () => {
    expect(chart('week').summary.some((i) => i.id === 'study')).toBe(false);
    expect(summary(chart('week', { study: true }))['study']).toBe('4 h 25 min');
  });

  it('says there is nothing when every bar is empty', () => {
    const empty = harnessFixture('stats-empty').local.stats.overview.week;
    const view = deriveChart({
      overview: empty,
      today: TODAY,
      points: null,
      goalMinutes: 60,
      studyEnabled: false,
    });
    expect(view.maxKey).toBeNull();
    expect(view.hint).toBe('Sin tiempo concentrado en este periodo');
    expect(summary(view)['best']).toBe('ninguno todavía');
    expect(summary(view)['points']).toBe('0');
  });

  it('speaks English', () => {
    withLocale('en', () => {
      const view = chart('week');
      expect(view.title).toBe('Focused: 14 h');
      expect(view.datum).toBe('Sep 21–27');
      expect(summary(view)['points']).toBe('+1,105 · −110');
      expect(view.bars[0]?.readout).toBe('Monday 21: 1 h 50 min · 2 attempts');
      expect(Object.values(chart('day').tickLabels)).toEqual([
        '12:00 AM',
        '6:00 AM',
        '12:00 PM',
        '6:00 PM',
      ]);
    });
  });
});

describe('Estadísticas: period navigation', () => {
  it('offers «Día | Semana | Mes» with help and keys', () => {
    expect(rangeOptions().map((o) => [o.label, o.mnemonic])).toEqual([
      ['Día', 'd'],
      ['Semana', 's'],
      ['Mes', 'm'],
    ]);
  });

  it('cannot go past today, and «Esta semana» is off while showing it', () => {
    const current = deriveNav('week', TODAY, TODAY);
    expect(current.current.disabledReason).toBe('Ya estás viendo el periodo de hoy');
    expect(current.next.disabledReason).toBe('Lo que aún no ha pasado no tiene estadísticas');
    expect(current.previous.disabledReason).toBeNull();
    const last = deriveNav('week', '2026-09-21', TODAY);
    expect(last.current.disabledReason).toBeNull();
    expect(last.next.disabledReason).toBeNull();
    expect([last.previous.label, last.current.label, last.next.label]).toEqual([
      '‹ Semana anterior',
      'Esta semana',
      'Semana siguiente ›',
    ]);
    expect(deriveNav('day', '2026-09-27', TODAY).current.label).toBe('Hoy');
  });

  it('reads a missing anchor as today', () => {
    expect(effectiveAnchor(null, TODAY)).toBe(TODAY);
    expect(effectiveAnchor('2026-09-21', TODAY)).toBe('2026-09-21');
    expect(effectiveAnchor('nonsense', TODAY)).toBe(TODAY);
    expect(isCurrentPeriod('month', '2026-09-01', TODAY)).toBe(true);
    expect(isCurrentPeriod('week', '2026-09-21', TODAY)).toBe(false);
  });
});

describe('Estadísticas: heatmap', () => {
  const heatmap = week.local.stats.heatmap;

  it('lays out 53 weeks, Monday first, up to today, with month names that fit', () => {
    const view = deriveHeatmap(heatmap, POINTS);
    expect(view.weeks).toBe(53);
    expect(view.cells).toHaveLength(365);
    expect(view.cells[0]).toMatchObject({ day: '2025-09-29', col: 0, row: 0 });
    expect(view.cells.at(-1)).toMatchObject({ day: TODAY, col: 52, row: 0, level: 4 });
    expect(view.cells.at(-1)?.readout).toBe(
      'Lunes 28 de septiembre: 2 h 35 min · objetivo cumplido',
    );
    expect(view.months[0]).toEqual({ col: 0, label: 'oct' });
    expect(view.months.at(-1)).toEqual({ col: 48, label: 'sept' });
    expect(view.months.every((m) => m.col <= view.weeks - 3)).toBe(true);
    expect(view.weekdays).toEqual([
      { row: 0, label: 'L' },
      { row: 2, label: 'X' },
      { row: 4, label: 'V' },
    ]);
  });

  it('titles the streak and the record, and summarises the year in one line', () => {
    const view = deriveHeatmap(heatmap, POINTS);
    expect(view.title).toBe('Racha: 5 días');
    expect(view.datum).toBe('récord: 12 días');
    expect(view.summary).toBe('Último año: 321 días con actividad · 313 con el objetivo');
    const none = view.cells.find((c) => c.level === 0);
    expect(none?.readout).toMatch(/: sin tiempo concentrado$/);
  });

  it('counts the streak from the cells when the guardian state is missing', () => {
    const cells: StatsHeatmap['cells'] = [
      { day: '2026-09-24', focusMinutes: 0, blockMinutes: 0, level: 0 },
      { day: '2026-09-25', focusMinutes: 0, blockMinutes: 60, level: 4 },
      { day: '2026-09-26', focusMinutes: 0, blockMinutes: 90, level: 4 },
      { day: '2026-09-27', focusMinutes: 0, blockMinutes: 70, level: 4 },
      { day: '2026-09-28', focusMinutes: 0, blockMinutes: 10, level: 1 },
    ];
    const view = deriveHeatmap(
      { from: '2026-09-21', to: '2026-09-27', goalMinutes: 60, cells },
      null,
    );
    expect(view.title).toBe('Racha: 3 días');
    expect(view.datum).toBe('récord: 3 días');
    expect(view.weeks).toBe(2);
    expect(view.cells[0]).toMatchObject({ col: 0, row: 3 });
    expect(view.cells.at(-1)).toMatchObject({ col: 1, row: 0 });
  });

  it('has no record datum for a first run', () => {
    const empty = harnessFixture('stats-empty');
    const view = deriveHeatmap(empty.local.stats.heatmap, empty.snapshot.state?.points ?? null);
    expect(view.title).toBe('Racha: 0 días');
    expect(view.datum).toBeNull();
    expect(view.summary).toBe('Último año: 0 días con actividad · 0 con el objetivo');
  });
});

describe('Estadísticas: ranked lists', () => {
  it('names what you try to open most, with attempts, points and bar lengths', () => {
    const view = deriveTargets(week.local.stats.overview.week);
    expect(view.title).toBe('Lo que más intentas abrir');
    expect(view.rows.map((r) => [r.name, r.attempts, r.points])).toEqual([
      ['YouTube', '5 intentos', '−75'],
      ['Instagram', '3 intentos', '−45'],
      ['TikTok', '2 intentos', '−30'],
      ['reddit.com', '1 intento', '−15'],
      ['Steam', '1 intento', '−15'],
    ]);
    expect(view.rows[0]?.share).toBe(1);
    expect(view.rows[1]?.share).toBeCloseTo(0.6);
    expect(view.empty).toBeNull();
  });

  it('lists the 3 best hours', () => {
    const view = deriveHours(week.local.stats.overview.week);
    expect(view.rows.map((r) => [r.label, r.minutes])).toEqual([
      ['17:00–18:00', '4 h 13 min'],
      ['18:00–19:00', '3 h 30 min'],
      ['16:00–17:00', '2 h 48 min'],
    ]);
  });

  it('says so when a period has no attempts or minutes', () => {
    const empty = harnessFixture('stats-empty').local.stats.overview.week;
    expect(deriveTargets(empty)).toMatchObject({
      rows: [],
      empty: 'Ningún intento en este periodo',
    });
    expect(deriveHours(empty)).toMatchObject({
      rows: [],
      empty: 'Aún no hay minutos en este periodo',
    });
  });
});

describe('Estadísticas: event log and export', () => {
  it('turns the log into rows: time, what happened, points', () => {
    const view = deriveLog(week.local.stats.events, TODAY, false);
    expect(view.title).toBe('Registro: 12 eventos');
    expect(view.rows.slice(0, 5).map((r) => [r.when, r.text, r.points, r.tone])).toEqual([
      ['hoy 16:42', 'Bloqueo: YouTube · 1 h · Estricto', null, 'muted'],
      ['hoy 16:25', 'Intento: YouTube', '−10', 'red'],
      ['hoy 15:58', 'Bloqueo cumplido: Instagram · 1 h · Normal', '+60', 'green'],
      ['hoy 15:56', 'Recompensa: YouTube · 15 min', '−150', 'red'],
      ['hoy 14:50', 'Ampliado: Instagram · +30 min · Normal', null, 'muted'],
    ]);
    expect(view.rows[7]?.text).toBe('Bloqueo cumplido: Redes sociales · 2 h · Estricto');
    expect(view.rows[6]?.when).toBe('ayer 17:20');
    expect(view.rows[10]?.when).toBe('26 sept 17:00');
    expect(view.more).toBeNull();
    expect(view.empty).toBeNull();
  });

  it('offers «Mostrar más» while older pages exist', () => {
    const page = { ...week.local.stats.events, nextBefore: 'ep_x:408', total: 40 };
    expect(deriveLog(page, TODAY, false).more).toEqual({
      label: 'Mostrar más',
      help: 'Ves 12 de 40 eventos',
      mnemonic: 'o',
    });
    expect(deriveLog(page, TODAY, false).title).toBe('Registro: 40 eventos');
  });

  it('names events it does not know and targets it cannot find', () => {
    const entry: EventLogEntry = {
      id: 'e:1',
      at: new Date(HARNESS_NOW).toISOString(),
      type: 'something_new',
      points: 0,
      target: null,
      minutes: null,
      mode: null,
    };
    expect(eventText(entry)).toBe('Otro evento');
    expect(eventText({ ...entry, type: 'attempt', target: 'discord', mode: 'strict' })).toBe(
      'Intento: Discord',
    );
    expect(targetName('mi-juego.exe')).toBe('mi-juego.exe');
    expect(targetName('chrome')).toBe('Google Chrome');
    expect(deriveLog({ entries: [], nextBefore: null, total: 0 }, TODAY, false).empty).toBe(
      'Nada en el registro con este filtro',
    );
    expect(deriveLog(null, TODAY, false).title).toBe('Registro');
  });

  it('offers the Study Mode filter only with its flag', () => {
    expect(logFilters(false).map((f) => f.label)).toEqual([
      'Todo',
      'Bloqueos',
      'Intentos',
      'Puntos',
    ]);
    expect(logFilters(true).map((f) => f.value)).toContain('study');
  });

  it('reports the export on the help line', () => {
    expect(exportNotice(null, false)).toEqual({
      text: 'Guarda tus datos en CSV para abrirlos en una hoja de cálculo',
      tone: 'muted',
    });
    expect(
      exportNotice(
        { outcome: 'saved', rows: 12, fileName: 'centrate-eventos-2026-09-28.csv' },
        false,
      ),
    ).toEqual({ text: 'Guardado: centrate-eventos-2026-09-28.csv · 12 filas', tone: 'green' });
    expect(exportNotice({ outcome: 'cancelled', rows: 0, fileName: null }, false).text).toBe(
      'No se ha guardado nada',
    );
    expect(exportNotice(null, true).tone).toBe('red');
  });
});

describe('Estadísticas: empty state and keys', () => {
  it('is empty before the first session (stats-empty)', () => {
    const empty = harnessFixture('stats-empty');
    expect(Object.values(empty.local.stats.overview).every((o) => o.empty)).toBe(true);
  });

  it('«Empezar 25 min» hands the «Deberes» distractions for 25 min to the card', () => {
    const draft = firstSessionDraft(DEFAULT_TEMPLATES, DEFAULT_PREFS);
    expect(draft.end).toEqual({ kind: 'duration', minutes: 25 });
    expect(draft.targets.categoryIds).toEqual(
      DEFAULT_TEMPLATES.find((t) => t.id === 'deberes')?.targets.categoryIds,
    );
    expect(draft.mode).toBe(DEFAULT_PREFS.defaultMode);
    expect(draft.whitelistOnly).toBe(false);
    expect(firstSessionDraft([], { ...DEFAULT_PREFS, defaultMode: 'strict' }).mode).toBe('strict');
  });

  it('gives every tile a unique Alt + letter in both languages', () => {
    for (const locale of ['es', 'en'] as const) {
      withLocale(locale, () => {
        for (const range of ['day', 'week', 'month'] as const) {
          for (const study of [false, true]) {
            const keys = windowMnemonics(range, study);
            expect(duplicateKeys(keys), `${locale} ${range} study=${study}`).toEqual([]);
          }
        }
      });
    }
  });

  it('keeps both tables of copy in step', () => {
    expect(Object.keys(ESTADISTICAS_EN.log.events).sort()).toEqual(
      Object.keys(ESTADISTICAS_ES.log.events).sort(),
    );
  });
});
