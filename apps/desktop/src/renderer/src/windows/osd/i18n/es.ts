/**
 * Spanish strings of the OSD window (PROMPT §10 «Aviso grande»). The notice itself arrives
 * worded in `snapshot.osd`; the window only names itself for assistive technology. `en.ts` has
 * the same shape (`OsdMessages`).
 */
import type { Widen } from '../../../../../shared/i18n/locale';

export const OSD_ES = {
  /** The window's hidden `<h1>` and the name of its landmark. */
  title: 'Aviso de Céntrate',
};

export type OsdMessages = Widen<typeof OSD_ES>;
