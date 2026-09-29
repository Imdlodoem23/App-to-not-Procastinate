/**
 * Section 5 «Pie» (PROMPT §10), pure: «● Guardián activo · ● Extensión conectada» (8 px dots and
 * text; when the guardian fails, «● Guardián detenido · Reparar»; «● Guardián sin respuesta ·
 * Reparar» in orange when a create timed out while the polls still answer), the version on the right
 * («v1.2.0», or «Actualizar a v1.3.0» in blue), and the secondary 32 px buttons
 * Mini temporizador (with its flag) | Ajustes… | Salir.
 *
 * Phase 5:
 * - «Actualizar a vX» is a button: it downloads the new version (`updater:download`; a
 *   check-only system opens the download page instead) and, once downloaded (`ready`), installs
 *   it (`updater:install`, a restart; blocks stay, the guardian runs apart). While it downloads
 *   the link turns into «Descargando v0.2.0 · 45 %» (muted, not a button).
 * - «Mini temporizador» toggles its window (`mini-timer:toggle`) and shows pressed while it is
 *   visible (`prefs.miniTimer.visible`, neutral outline: showing it is no «better» choice).
 *
 * «Mantener despierto» (ARCHITECTURE §5.11): while it is on, the «Despierto · hasta las 18:30» chip
 * (blue) takes the version's place on the status line, so the footer never grows (the main
 * window has no height to spare at 1366×768 at 125 %). When the guardian cannot hold it, the
 * chip reads «Despierto: error» (orange) and the help line under the buttons says «No se ha
 * podido mantener despierto este equipo». Pressing it pops up the tray's choices
 * (`keep-awake:menu`). A pending update keeps the right side («Actualizar a vX» is an action
 * to take; the tray and Ajustes still show keep-awake). Off, the chip is not there at all (the
 * tray and Ajustes turn it on).
 */
import type { Accent } from '@centrate/shared/design/tokens';
import { featureEnabled } from '../../../../shared/features';
import { formatInt } from '../../../../shared/format';
import {
  keepAwakeAvailable,
  keepAwakeIsOn,
  keepAwakeOf,
  keepAwakeSummary,
  keepAwakeUntilLabel,
  keepAwakeTroubleText,
} from '../../../../shared/keep-awake';
import type { UpdaterState } from '../../../../shared/platform';
import { snapshotNow, type UiSnapshot } from '../../../../shared/ui-state';
import { RENDERER } from '../../i18n/messages';
import { FOOTER } from './i18n';

export interface FooterStatus {
  tone: Accent;
  label: string;
}

export type FooterButton = 'miniTimer' | 'settings' | 'quit';

/** The «Despierto» chip: what it says and in which tone. */
export interface FooterAwake {
  /**
   * Read by screen readers before `label` but not shown («Despierto · »): beside the status line
   * the chip only has room for the coffee icon and «hasta las 18:30». `""` when none.
   */
  hiddenPrefix: string;
  label: string;
  tone: 'blue' | 'orange';
  /** Why it is not held («No se ha podido mantener despierto este equipo»), else `null`. */
  trouble: string | null;
}

/** What pressing the version does: download, install (restart) or nothing (plain text). */
export type FooterUpdateAction = 'download' | 'install';

export interface FooterVersion {
  label: string;
  /** Blue: a newer version exists. */
  update: boolean;
  /** `null`: plain text (no update, or it is downloading). */
  action: FooterUpdateAction | null;
}

export interface FooterView {
  guardian: FooterStatus & { action: 'repair' | 'install' | null };
  /** `null` while the guardian is down (its extension data is stale). */
  extension: FooterStatus | null;
  version: FooterVersion;
  buttons: FooterButton[];
  /** The mini timer is on screen: its button shows pressed. */
  miniTimerVisible: boolean;
  /**
   * «Mantener despierto» is on: its chip, in place of the plain version. `null` while off, and
   * while the right side shows an update.
   */
  awake: FooterAwake | null;
}

/**
 * «Despierto · hasta las 18:30», «Despierto» or «Despierto: error»; `null` while off or
 * unavailable.
 */
export function footerAwake(snapshot: UiSnapshot, nowMs: number): FooterAwake | null {
  if (!keepAwakeAvailable(snapshot)) return null;
  const state = keepAwakeOf(snapshot);
  if (!keepAwakeIsOn(state, nowMs)) return null;
  const trouble = keepAwakeTroubleText(state);
  if (trouble) return { hiddenPrefix: '', label: FOOTER.awake.error, tone: 'orange', trouble };
  const until = keepAwakeUntilLabel(state);
  if (until === null)
    return { hiddenPrefix: '', label: keepAwakeSummary(state), tone: 'blue', trouble: null };
  const summary = keepAwakeSummary(state);
  return {
    hiddenPrefix: summary.slice(0, summary.length - until.length),
    label: until,
    tone: 'blue',
    trouble: null,
  };
}

/** The version on the right: «v1.2.0», «Actualizar a v1.3.0», «Descargando v1.3.0 · 45 %». */
export function footerVersion(snapshot: Pick<UiSnapshot, 'app' | 'updater'>): FooterVersion {
  const { app, updater } = snapshot;
  const version = app.updateVersion ?? updater.version;
  if (updater.status === 'downloading' && version) {
    const label =
      updater.percent === null
        ? FOOTER.downloadingStart(version)
        : FOOTER.downloading(version, formatInt(Math.floor(updater.percent)));
    return { label, update: false, action: null };
  }
  if (!app.updateVersion) return { label: F.version(app.version), update: false, action: null };
  return {
    label: F.update(app.updateVersion),
    update: true,
    action: updater.status === 'ready' ? 'install' : 'download',
  };
}

const F = RENDERER.footer;

export function deriveFooterView(snapshot: UiSnapshot): FooterView {
  const { link, state } = snapshot;
  const create = snapshot.ops.create;
  // A create that timed out while the polls still answer: the confirm card says «El guardián
  // no responde», so the footer must not claim «Guardián activo» next to it. Main clears
  // `ops.create` on the next good create (or when the card is dropped).
  const createTimedOut = create?.status === 'failed' && create.error?.code === 'timeout';
  let guardian: FooterView['guardian'];
  if (link.status === 'ok')
    guardian = createTimedOut
      ? { tone: 'orange', label: F.guardianUnresponsive, action: 'repair' }
      : { tone: 'green', label: F.guardianOk, action: null };
  else if (link.status === 'connecting')
    guardian = { tone: 'neutral', label: F.guardianConnecting, action: null };
  else if (link.reason === 'not_installed')
    guardian = { tone: 'red', label: F.guardianNotInstalled, action: 'install' };
  else if (link.reason === 'unauthorized' || link.reason === 'incompatible')
    guardian = { tone: 'red', label: F.guardianOutdated, action: 'repair' };
  else guardian = { tone: 'red', label: F.guardianStopped, action: 'repair' };

  let extension: FooterStatus | null = null;
  if (link.status !== 'down' && state) {
    const extensions = state.protection.extensions;
    if (extensions.some((e) => e.connected)) extension = { tone: 'green', label: F.extensionOk };
    else if (extensions.length > 0) extension = { tone: 'orange', label: F.extensionDisconnected };
    else extension = { tone: 'orange', label: F.extensionMissing };
  }

  const buttons: FooterButton[] = [];
  const miniTimer = featureEnabled(
    snapshot.features,
    'miniTimer',
    snapshot.health?.capabilities ?? null,
  );
  if (miniTimer) buttons.push('miniTimer');
  buttons.push('settings', 'quit');

  const version = footerVersion(snapshot);
  // The chip takes the plain version's place; an update (or its download) keeps it.
  const plainVersion =
    snapshot.app.updateVersion === null && snapshot.updater.status !== 'downloading';
  return {
    guardian,
    extension,
    version,
    buttons,
    miniTimerVisible: miniTimer && snapshot.prefs.miniTimer.visible,
    awake: plainVersion ? footerAwake(snapshot, snapshotNow(snapshot)) : null,
  };
}

/** One line for the footer's help line after «Actualizar a vX». */
export interface UpdateMessage {
  text: string;
  tone: 'muted' | 'red';
}

/** The help line after a successful call, from the updater state it answered. Pure. */
export function updateOutcome(
  action: FooterUpdateAction,
  state: UpdaterState,
): UpdateMessage | null {
  switch (state.status) {
    case 'error':
      return { text: FOOTER.result.failed, tone: 'red' };
    case 'unsupported':
      return { text: FOOTER.result.unsupported, tone: 'red' };
    case 'ready':
      return action === 'install' ? { text: FOOTER.result.restarting, tone: 'muted' } : null;
    case 'available':
      // Nothing to download here (a check-only system): main opened the download page.
      return { text: FOOTER.result.downloadPage, tone: 'muted' };
    default:
      return null;
  }
}
