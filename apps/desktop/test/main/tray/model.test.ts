import { describe, expect, it } from 'vitest';
import type { TrayMenuItemModel } from '../../../src/main/contracts';
import {
  TOOLTIP_MAX,
  TRAY_ITEM,
  nextTrayRefreshDelay,
  trayActionForItem,
  trayExtendMax,
  trayMenu,
  trayTooltip,
  trayView,
  truncateTooltip,
  windowTitle,
} from '../../../src/main/tray/model';
import type { TrayIconKey } from '../../../src/main/tray/icons';
import {
  HARNESS_NOW,
  HARNESS_STATE_IDS,
  harnessFixture,
  makeBlock,
  makeGuardianState,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { resolveFeatures } from '../../../src/shared/features';
import type { UiSnapshot } from '../../../src/shared/ui-state';

const NOW = HARNESS_NOW;

function snap(id: HarnessStateId): UiSnapshot {
  return harnessFixture(id).snapshot;
}

function ids(items: readonly TrayMenuItemModel[]): string[] {
  return items.map((i) => i.id);
}

function find(items: readonly TrayMenuItemModel[], id: string): TrayMenuItemModel | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = find(item.submenu, id);
    if (inner) return inner;
  }
  return undefined;
}

const EXPECTED_ICON: Record<HarnessStateId, TrayIconKey> = {
  idle: 'idle',
  typing: 'idle',
  'not-understood': 'idle',
  'confirm-normal': 'idle',
  'confirm-over-4h': 'idle',
  'confirm-hardcore': 'idle',
  'confirm-exam': 'idle',
  pending: 'idle',
  'guardian-timeout': 'idle',
  'one-block': 'strict',
  'three-blocks': 'red', // one of them is Hardcore
  'extend-undo': 'strict',
  finished: 'idle',
  'emergency-waiting': 'normal',
  'emergency-ready': 'normal',
  punishment: 'red',
  'negative-points': 'idle',
  'protection-broken': 'idle', // guardian stopped: nothing is enforced
  'extension-missing': 'strict',
  'compact-density': 'red',
  bloqueos: 'strict',
  emergencia: 'normal',
  ajustes: 'idle',
  'hardcore-block': 'red',
  'many-blocks': 'red',
  'boot-hold': 'normal',
  'not-installed': 'idle',
  'bloqueos-prefilled': 'idle',
  'ajustes-pairing': 'idle',
  'ajustes-delete': 'idle',
  'stats-empty': 'idle',
  'stats-week': 'idle',
  rewards: 'strict',
  'rewards-short-points': 'strict',
  logros: 'idle',
  'onboarding-1': 'idle',
  'onboarding-2': 'idle',
  'onboarding-3': 'idle',
  'onboarding-4': 'idle',
  'onboarding-5': 'idle',
  'mini-timer': 'strict',
  osd: 'strict',
  nuclear: 'red',
  'ajustes-full': 'strict',
  schedules: 'idle',
  'exam-whitelist': 'idle',
  'update-available': 'idle',
};

describe('tray icon', () => {
  it('follows the strongest active block for every fixture', () => {
    for (const id of HARNESS_STATE_IDS) {
      const view = trayView(snap(id), NOW);
      expect(view.icon.key, id).toBe(EXPECTED_ICON[id]);
      expect(view.icon.camera, id).toBe(false);
    }
  });

  it('is green while studying, only with the study flag and capability', () => {
    const base = snap('idle');
    const state = base.state;
    expect(state).not.toBeNull();
    if (!state) return;
    const studying = { ...base, state: { ...state, study: {} as never } };
    expect(trayView(studying, NOW).icon.key).toBe('idle');
    const flagged = { ...studying, features: resolveFeatures({ study: true }) };
    expect(trayView(flagged, NOW).icon.key).toBe('study');
    expect(windowTitle(flagged, NOW)).toBe('Céntrate · estudiando');
  });
});

describe('tooltip', () => {
  it('reads like the brief', () => {
    expect(trayTooltip(snap('idle'), NOW)).toBe('Céntrate · sin bloqueos · 1.240 pts');
    // 42:10 left rounds up to 43 min.
    expect(trayTooltip(snap('one-block'), NOW)).toBe(
      'Céntrate · YouTube, Instagram · quedan 43 min · 1.240 pts',
    );
    expect(trayTooltip(snap('emergencia'), NOW)).toBe(
      'Céntrate · YouTube · quedan 43 min · 1.240 pts',
    );
    expect(trayTooltip(snap('punishment'), NOW)).toBe(
      'Céntrate · castigo · quedan 38 min · 1.095 pts',
    );
    expect(trayTooltip(snap('three-blocks'), NOW)).toBe(
      'Céntrate · 3 bloqueos · quedan 2 h 11 min · 1.240 pts',
    );
    expect(trayTooltip(snap('negative-points'), NOW)).toBe('Céntrate · sin bloqueos · −340 pts');
    expect(trayTooltip(snap('protection-broken'), NOW)).toBe('Céntrate · guardián detenido');
    expect(trayTooltip(snap('not-installed'), NOW)).toBe('Céntrate · guardián no instalado');
    expect(trayTooltip(snap('boot-hold'), NOW)).toBe(
      'Céntrate · YouTube · comprobando la hora · 1.240 pts',
    );
  });

  it('never exceeds what Windows shows', () => {
    const long = 'x'.repeat(300);
    expect(truncateTooltip(long)).toHaveLength(TOOLTIP_MAX);
    for (const id of HARNESS_STATE_IDS) {
      expect(trayTooltip(snap(id), NOW).length, id).toBeLessThanOrEqual(TOOLTIP_MAX);
    }
  });

  it('says «connecting» only as the app name before the first answer', () => {
    const s = snap('idle');
    expect(trayTooltip({ ...s, state: null, link: { ...s.link, status: 'connecting' } }, NOW)).toBe(
      'Céntrate',
    );
  });
});

describe('window title', () => {
  it('is the state', () => {
    expect(windowTitle(snap('idle'), NOW)).toBe('Céntrate');
    expect(windowTitle(snap('one-block'), NOW)).toBe('Céntrate · quedan 43 min');
    expect(windowTitle(snap('punishment'), NOW)).toBe('Céntrate · castigo 38 min');
    expect(windowTitle(snap('protection-broken'), NOW)).toBe('Céntrate · guardián detenido');
    expect(windowTitle(snap('boot-hold'), NOW)).toBe('Céntrate · comprobando la hora');
  });

  it('says «queda 1 min» in the last minute', () => {
    const s = snap('one-block');
    const state = s.state;
    if (!state) throw new Error('fixture without state');
    const block = makeBlock(
      { n: 1, services: ['youtube'], mode: 'normal', leftMs: 30_000, elapsedMs: 60_000 },
      NOW,
    );
    const last = { ...s, state: makeGuardianState(NOW, { blocks: [block] }) };
    expect(windowTitle(last, NOW)).toBe('Céntrate · queda 1 min');
  });
});

describe('menu', () => {
  it('mirrors the tiles with an active block', () => {
    const menu = trayMenu(snap('one-block'), NOW);
    expect(ids(menu)).toEqual([
      'status',
      'sep-status',
      'extend',
      'quick',
      'mini-timer',
      'sep-actions',
      'open',
      'quit',
    ]);
    expect(menu[0]).toMatchObject({ label: 'Quedan 43 min · YouTube, Instagram', enabled: false });
    expect(find(menu, 'extend')?.submenu.map((i) => i.label)).toEqual([
      '+15 min',
      '+30 min',
      '+1 h',
    ]);
    expect(find(menu, 'quick')?.submenu.map((i) => [i.id, i.label])).toEqual([
      ['template:deberes', 'Deberes 1 h'],
      ['template:examen', 'Examen 3 h'],
      ['template:leer', 'Leer 30 min'],
    ]);
    expect(find(menu, 'quit')?.label).toBe('Salir (los bloqueos siguen activos)');
    expect(find(menu, 'open')?.label).toBe('Abrir Céntrate');
  });

  it('has no «Ampliar» without an extendable block', () => {
    for (const id of [
      'idle',
      'punishment',
      'protection-broken',
      'boot-hold',
      'not-installed',
    ] as const) {
      expect(find(trayMenu(snap(id), NOW), 'extend'), id).toBeUndefined();
    }
    expect(trayMenu(snap('idle'), NOW)[0]?.label).toBe('Sin bloqueos');
    expect(trayMenu(snap('punishment'), NOW)[0]?.label).toBe('Castigo · quedan 38 min');
    expect(trayMenu(snap('protection-broken'), NOW)[0]?.label).toBe('Guardián detenido');
  });

  it('disables the entries that would pass 24 h in total', () => {
    const s = snap('one-block');
    const block = makeBlock(
      {
        n: 1,
        services: ['youtube'],
        mode: 'normal',
        leftMs: (24 * 60 - 40) * 60_000,
        elapsedMs: 60_000,
      },
      NOW,
    );
    const nearMax = { ...s, state: makeGuardianState(NOW, { blocks: [block] }) };
    expect(trayExtendMax(nearMax, NOW)).toBe(40);
    const extend = find(trayMenu(nearMax, NOW), 'extend');
    expect(extend?.submenu.map((i) => i.enabled)).toEqual([true, true, false]);
  });

  it('counts minutes already queued for undo', () => {
    // extend-undo: 43 min left (rounded up) + 30 queued.
    expect(trayExtendMax(snap('extend-undo'), NOW)).toBe(24 * 60 - 43 - 30);
  });
});

describe('«Mini temporizador» checkbox', () => {
  it('shows with its flag, checked when the mini timer is visible', () => {
    const hidden = find(trayMenu(snap('one-block'), NOW), TRAY_ITEM.miniTimer);
    expect(hidden).toMatchObject({ type: 'checkbox', checked: false, label: 'Mini temporizador' });
    const shown = find(trayMenu(snap('mini-timer'), NOW), TRAY_ITEM.miniTimer);
    expect(shown).toMatchObject({ type: 'checkbox', checked: true, enabled: true });
  });

  it('is not there with the flag off', () => {
    const s = snap('one-block');
    const off = { ...s, features: resolveFeatures({ miniTimer: false }) };
    expect(find(trayMenu(off, NOW), TRAY_ITEM.miniTimer)).toBeUndefined();
  });

  it('maps to the mini timer action', () => {
    expect(trayActionForItem(TRAY_ITEM.miniTimer)).toEqual({ type: 'mini-timer' });
  });
});

describe('menu actions', () => {
  it('maps ids back to actions', () => {
    expect(trayActionForItem(TRAY_ITEM.extendBy(30))).toEqual({ type: 'extend', minutes: 30 });
    expect(trayActionForItem(TRAY_ITEM.template('deberes'))).toEqual({
      type: 'template',
      templateId: 'deberes',
    });
    expect(trayActionForItem('open')).toEqual({ type: 'open' });
    expect(trayActionForItem('quit')).toEqual({ type: 'quit' });
    expect(trayActionForItem('status')).toBeNull();
    expect(trayActionForItem('extend')).toBeNull();
    expect(trayActionForItem('template:')).toBeNull();
    expect(trayActionForItem('extend:abc')).toBeNull();
  });
});

describe('refresh timer', () => {
  it('fires just after the minute shown flips', () => {
    // 42:10 left → «43 min» until 42:00 left, 10 s from now.
    const delay = nextTrayRefreshDelay(snap('one-block'), NOW);
    expect(delay).not.toBeNull();
    expect(delay).toBeGreaterThan(10_000);
    expect(delay).toBeLessThan(10_200);
    expect(windowTitle(snap('one-block'), NOW + (delay ?? 0))).toBe('Céntrate · quedan 42 min');
    expect(windowTitle(snap('one-block'), NOW + (delay ?? 0) - 100)).toBe(
      'Céntrate · quedan 43 min',
    );
  });

  it('never waits more than a minute and does not tick without a block', () => {
    for (const id of HARNESS_STATE_IDS) {
      const delay = nextTrayRefreshDelay(snap(id), NOW);
      if (delay !== null) expect(delay, id).toBeLessThanOrEqual(60_050);
    }
    expect(nextTrayRefreshDelay(snap('idle'), NOW)).toBeNull();
    expect(nextTrayRefreshDelay(snap('protection-broken'), NOW)).toBeNull();
  });
});
