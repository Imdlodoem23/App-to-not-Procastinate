/**
 * Global shortcuts controller: registers `prefs.shortcuts` through the app's registry
 * (`src/main/app/shortcuts.ts`, Electron `globalShortcut`) whenever they change, runs the
 * action and publishes the refused ones (`snapshot.shortcuts`). Harness runs never register
 * anything (the test machine's own shortcuts stay free).
 */
import type { ShortcutAction, ShortcutPrefs } from '../../shared/prefs';
import type { ShortcutStatus } from '../../shared/platform';
import type { ShortcutRegistry } from '../app/shortcuts';
import { failedActions, planShortcuts, sameShortcuts } from './bindings';

export { acceleratorKey, failedActions, planShortcuts, sameShortcuts } from './bindings';

export interface ShortcutControllerOptions {
  registry: ShortcutRegistry;
  run(action: ShortcutAction): void;
  publish(status: ShortcutStatus): void;
}

export class ShortcutController {
  private applied: ShortcutPrefs | null = null;

  constructor(private readonly options: ShortcutControllerOptions) {}

  /** Registers `prefs` unless they are what is registered already. */
  apply(prefs: ShortcutPrefs): void {
    if (this.applied && sameShortcuts(this.applied, prefs)) return;
    this.applied = { ...prefs };
    const { plan, invalid } = planShortcuts(prefs);
    const refused = this.options.registry.apply(
      plan.map((p) => ({ accelerator: p.accelerator, action: () => this.options.run(p.action) })),
    );
    this.options.publish({ failed: failedActions(plan, invalid, refused) });
  }

  dispose(): void {
    this.options.registry.clear();
    this.applied = null;
  }
}
