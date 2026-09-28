/**
 * Section 5 «Pie» (PROMPT §10), pure: «● Guardián activo · ● Extensión conectada» (8 px dots and
 * text; when the guardian fails, «● Guardián detenido · Reparar»; «● Guardián sin respuesta ·
 * Reparar» in orange when a create timed out while the polls still answer), the version on the right
 * («v1.2.0», or «Actualizar a v1.3.0» in blue), and the secondary 32 px buttons
 * Mini temporizador (with its flag) | Ajustes… | Salir.
 */
import type { Accent } from '@centrate/shared/design/tokens';
import { featureEnabled } from '../../../../shared/features';
import type { UiSnapshot } from '../../../../shared/ui-state';
import { RENDERER } from '../../i18n/messages';

export interface FooterStatus {
  tone: Accent;
  label: string;
}

export type FooterButton = 'miniTimer' | 'settings' | 'quit';

export interface FooterView {
  guardian: FooterStatus & { action: 'repair' | 'install' | null };
  /** `null` while the guardian is down (its extension data is stale). */
  extension: FooterStatus | null;
  version: { label: string; update: boolean };
  buttons: FooterButton[];
}

const F = RENDERER.footer;

export function deriveFooterView(snapshot: UiSnapshot): FooterView {
  const { link, state, app } = snapshot;
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

  const update = app.updateVersion;
  const buttons: FooterButton[] = [];
  if (featureEnabled(snapshot.features, 'miniTimer', snapshot.health?.capabilities ?? null))
    buttons.push('miniTimer');
  buttons.push('settings', 'quit');

  return {
    guardian,
    extension,
    version: update
      ? { label: F.update(update), update: true }
      : { label: F.version(app.version), update: false },
    buttons,
  };
}
