/**
 * Global shortcuts (Ajustes › General «Atajo global»): what gets registered, and which actions
 * Ajustes must show as refused.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  globalShortcut: { register: () => true, unregister: () => undefined },
}));

import type { ShortcutRegistry } from '../../../src/main/app/shortcuts';
import {
  ShortcutController,
  acceleratorKey,
  failedActions,
  planShortcuts,
  sameShortcuts,
} from '../../../src/main/shortcuts';
import type { ShortcutStatus } from '../../../src/shared/platform';
import { DEFAULT_FEATURE_PREFS, type ShortcutPrefs } from '../../../src/shared/prefs';

describe('plan', () => {
  it('registers the configured accelerators in action order', () => {
    const { plan, invalid } = planShortcuts(DEFAULT_FEATURE_PREFS.shortcuts);
    expect(plan).toEqual([{ action: 'toggle-main', accelerator: 'CommandOrControl+Alt+C' }]);
    expect(invalid).toEqual([]);
  });

  it('refuses a duplicate or invalid accelerator', () => {
    const prefs: ShortcutPrefs = {
      'toggle-main': 'CommandOrControl+Alt+C',
      'extend-15': 'Alt+CmdOrCtrl+C',
      'toggle-mini-timer': 'Shift+M',
    };
    const { plan, invalid } = planShortcuts(prefs);
    expect(plan.map((p) => p.action)).toEqual(['toggle-main']);
    expect(invalid).toEqual(['extend-15', 'toggle-mini-timer']);
    expect(acceleratorKey('CmdOrCtrl+Alt+E')).toBe(acceleratorKey('Alt+CommandOrControl+E'));
  });

  it('maps OS refusals back to actions', () => {
    const { plan, invalid } = planShortcuts({
      'toggle-main': 'CommandOrControl+Alt+C',
      'extend-15': 'CommandOrControl+Alt+E',
      'toggle-mini-timer': null,
    });
    expect(failedActions(plan, invalid, ['CommandOrControl+Alt+E'])).toEqual(['extend-15']);
    expect(
      sameShortcuts(DEFAULT_FEATURE_PREFS.shortcuts, { ...DEFAULT_FEATURE_PREFS.shortcuts }),
    ).toBe(true);
  });
});

describe('controller', () => {
  it('registers once per change, runs actions and publishes refusals', () => {
    const applied: string[][] = [];
    let bound: Array<{ accelerator: string; action: () => void }> = [];
    const registry: ShortcutRegistry = {
      apply: (bindings) => {
        bound = [...bindings];
        applied.push(bindings.map((b) => b.accelerator));
        return bindings.filter((b) => b.accelerator.endsWith('+E')).map((b) => b.accelerator);
      },
      clear: () => {
        bound = [];
      },
    };
    const ran: string[] = [];
    const published: ShortcutStatus[] = [];
    const c = new ShortcutController({
      registry,
      run: (action) => ran.push(action),
      publish: (s) => published.push(s),
    });
    const prefs: ShortcutPrefs = {
      'toggle-main': 'CommandOrControl+Alt+C',
      'extend-15': 'CommandOrControl+Alt+E',
      'toggle-mini-timer': null,
    };
    c.apply(prefs);
    c.apply({ ...prefs });
    expect(applied).toHaveLength(1);
    expect(published).toEqual([{ failed: ['extend-15'] }]);
    bound[0]?.action();
    expect(ran).toEqual(['toggle-main']);
    c.dispose();
    expect(bound).toEqual([]);
  });
});
