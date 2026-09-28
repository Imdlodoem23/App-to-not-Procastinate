/**
 * Section 1 «Aviso de protección» (PROMPT §10, docs/DESKTOP.md §5.1), pure. It appears only when
 * something fails (main's link rule makes that ≤ 5 s after detection) and shows at most one
 * warning, red before orange:
 *
 * - red, guardian link down, worded by reason: not installed («Instalar…»), stopped or not
 *   answering («Reparar | Detalles…»), outdated («Reparar»);
 * - red, guardian in safe mode («Detalles…»);
 * - red, a block is active but the hosts file or the process watcher is failing
 *   («Reparar | Detalles…»);
 * - orange, a block is active and a browser runs without the extension («Instalar…», the guide
 *   for that browser).
 */
import type { BrowserFamily } from '@centrate/shared/domain';
import type { GuideId } from '../../../../shared/ipc';
import type { UiSnapshot } from '../../../../shared/ui-state';
import { RENDERER_ES } from '../../i18n/es';

export type ProtectionActionKind = 'repair' | 'install-guardian' | 'details' | 'guide';

export interface ProtectionAction {
  id: ProtectionActionKind;
  label: string;
  help: string;
  /** Opens something (a window, a guide, the elevation prompt): `tile-2`, «…». */
  door: boolean;
  /** `guide` actions: which guide `app:open-guide` opens. */
  guide: GuideId | null;
}

export interface ProtectionView {
  kind: 'guardian' | 'extension';
  tone: 'red' | 'orange';
  title: string;
  actions: ProtectionAction[];
}

const P = RENDERER_ES.protection;

const REPAIR: ProtectionAction = {
  id: 'repair',
  label: P.actions.repair,
  help: P.help.repair,
  door: false,
  guide: null,
};
const DETAILS: ProtectionAction = {
  id: 'details',
  label: P.actions.details,
  help: P.help.details,
  door: true,
  guide: null,
};
const INSTALL_GUARDIAN: ProtectionAction = {
  id: 'install-guardian',
  label: P.actions.install,
  help: P.help.installGuardian,
  door: true,
  guide: null,
};

/** «Chrome», «Chrome y Edge», «Chrome, Edge y Brave». */
export function browsersLabel(browsers: readonly BrowserFamily[]): string {
  const names = [...new Set(browsers)].map((b) => P.browsers[b]);
  if (names.length <= 1) return names[0] ?? P.browsers.other;
  return `${names.slice(0, -1).join(', ')}${P.and}${names[names.length - 1]}`;
}

/** The install guide for the first browser without the extension. */
export function guideFor(browsers: readonly BrowserFamily[]): GuideId {
  return browsers[0] === 'firefox' ? 'extension-firefox' : 'extension-chromium';
}

export function deriveProtectionView(snapshot: UiSnapshot): ProtectionView | null {
  const { link, state } = snapshot;
  if (link.status === 'down') {
    switch (link.reason) {
      case 'not_installed':
        return {
          kind: 'guardian',
          tone: 'red',
          title: P.guardianNotInstalled,
          actions: [INSTALL_GUARDIAN],
        };
      case 'unauthorized':
      case 'incompatible':
        return { kind: 'guardian', tone: 'red', title: P.guardianOutdated, actions: [REPAIR] };
      case 'unreachable':
      case 'timeout':
      case null:
        return {
          kind: 'guardian',
          tone: 'red',
          title: P.guardianStopped,
          actions: [REPAIR, DETAILS],
        };
    }
  }
  if (!state) return null;
  if (state.guardian.mode !== 'normal') {
    return { kind: 'guardian', tone: 'red', title: P.safeMode, actions: [DETAILS] };
  }
  const blocking = state.blocks.length > 0;
  if (blocking && (!state.protection.hosts.ok || !state.protection.processWatcher.ok)) {
    return { kind: 'guardian', tone: 'red', title: P.notApplied, actions: [REPAIR, DETAILS] };
  }
  const missing = state.protection.browsersWithoutExtension;
  if (blocking && missing.length > 0) {
    const distinct = new Set(missing).size;
    return {
      kind: 'extension',
      tone: 'orange',
      title: P.extensionMissing(browsersLabel(missing), distinct > 1),
      actions: [
        {
          id: 'guide',
          label: P.actions.install,
          help: P.help.installExtension,
          door: true,
          guide: guideFor(missing),
        },
      ],
    };
  }
  return null;
}
