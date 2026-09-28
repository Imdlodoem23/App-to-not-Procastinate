/** Window shell copy in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../shared/i18n/locale';
import { WINDOWS_EN } from './en';
import { WINDOWS_ES, type WindowsMessages } from './es';

export { WINDOWS_EN, WINDOWS_ES, type WindowsMessages };
export const WINDOWS: WindowsMessages = localized<WindowsMessages>({
  es: WINDOWS_ES,
  en: WINDOWS_EN,
});
