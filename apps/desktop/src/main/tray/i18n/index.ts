/** Tray and main window title copy in the active locale (`src/shared/i18n/locale.ts`). */
import { intlLocale } from '../../../shared/format';
import { localized } from '../../../shared/i18n/locale';
import { TRAY_EN } from './en';
import { TRAY_ES, type TrayMessages } from './es';

export { TRAY_EN, TRAY_ES, type TrayMessages };
export const TRAY: TrayMessages = localized<TrayMessages>({ es: TRAY_ES, en: TRAY_EN });

/** «Guardián detenido» for the menu status line (sentence case). */
export function capitalise(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLocaleUpperCase(intlLocale()) + text.slice(1);
}
