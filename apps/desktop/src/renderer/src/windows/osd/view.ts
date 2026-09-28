/**
 * The big notice (PROMPT §10 «Aviso grande (OSD)», like G-Helper's `ToastForm`), pure: the
 * pill shows `snapshot.osd` (main stamps it, shows the window and clears it after 2 s) with its
 * 20 px icon in the notice's accent. Nothing on screen when there is no notice. The text comes
 * already worded and localized from whoever asked for it (tray actions, the global shortcut,
 * «¿Sigues ahí?»), at most `OSD_TEXT_MAX` characters.
 */
import type { OsdIcon, OsdTone } from '../../../../shared/platform';
import type { UiSnapshot } from '../../../../shared/ui-state';

export interface OsdView {
  /** New per notice: a repeated text still restarts the fade-in. */
  id: number;
  text: string;
  icon: OsdIcon;
  tone: OsdTone;
}

export function deriveOsdView(snapshot: Pick<UiSnapshot, 'osd'>): OsdView | null {
  const osd = snapshot.osd;
  if (!osd) return null;
  const text = osd.text.trim();
  if (text === '') return null;
  return { id: osd.id, text, icon: osd.icon, tone: osd.tone };
}
