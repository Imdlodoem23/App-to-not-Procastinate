/**
 * Global shortcuts (Ajustes › General «Atajo global», PROMPT §10): which accelerator runs which
 * action, and which actions the OS refused (`snapshot.shortcuts.failed`, so Ajustes can say
 * «Ese atajo lo usa otra app»). Pure.
 *
 * Every action shows the OSD (when «Avisos grandes» is on): «Céntrate», «+15 min · hasta las
 * 18:12», «Mini temporizador».
 */
import {
  SHORTCUT_ACTIONS,
  isAccelerator,
  type ShortcutAction,
  type ShortcutPrefs,
} from '../../shared/prefs';

export interface PlannedShortcut {
  action: ShortcutAction;
  accelerator: string;
}

/** The comparable form of an accelerator («CmdOrCtrl+alt+E» equals «CommandOrControl+Alt+E»). */
export function acceleratorKey(accelerator: string): string {
  const alias: Record<string, string> = {
    cmd: 'command',
    ctrl: 'control',
    cmdorctrl: 'commandorcontrol',
    option: 'alt',
    esc: 'escape',
    return: 'enter',
  };
  const parts = accelerator.split('+').map((p) => {
    const lower = p.toLowerCase();
    return alias[lower] ?? lower;
  });
  const key = parts.pop() ?? '';
  return [...parts.sort(), key].join('+');
}

/**
 * The shortcuts to register, in `SHORTCUT_ACTIONS` order. An invalid accelerator or one already
 * taken by an earlier action is not registered and counts as failed.
 */
export function planShortcuts(prefs: ShortcutPrefs): {
  plan: PlannedShortcut[];
  invalid: ShortcutAction[];
} {
  const plan: PlannedShortcut[] = [];
  const invalid: ShortcutAction[] = [];
  const taken = new Set<string>();
  for (const action of SHORTCUT_ACTIONS) {
    const accelerator = prefs[action];
    if (accelerator === null) continue;
    const key = isAccelerator(accelerator) ? acceleratorKey(accelerator) : null;
    if (key === null || taken.has(key)) {
      invalid.push(action);
      continue;
    }
    taken.add(key);
    plan.push({ action, accelerator });
  }
  return { plan, invalid };
}

/** Actions whose accelerator the OS refused, plus the invalid ones, in action order. */
export function failedActions(
  plan: readonly PlannedShortcut[],
  invalid: readonly ShortcutAction[],
  refusedAccelerators: readonly string[],
): ShortcutAction[] {
  const refused = new Set(refusedAccelerators);
  const failed = new Set<ShortcutAction>(invalid);
  for (const p of plan) if (refused.has(p.accelerator)) failed.add(p.action);
  return SHORTCUT_ACTIONS.filter((a) => failed.has(a));
}

/** Whether two shortcut settings register the same thing (skip a needless re-register). */
export function sameShortcuts(a: ShortcutPrefs, b: ShortcutPrefs): boolean {
  return SHORTCUT_ACTIONS.every((action) => a[action] === b[action]);
}
