/** Copy of the Logros window in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { LOGROS_EN } from './en';
import { LOGROS_ES, type LogrosMessages } from './es';

export { LOGROS_EN, LOGROS_ES, type LogrosMessages };
export const LOGROS: LogrosMessages = localized<LogrosMessages>({
  es: LOGROS_ES,
  en: LOGROS_EN,
});
