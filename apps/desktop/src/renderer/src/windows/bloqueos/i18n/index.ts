/** Copy of the Bloqueos window in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { BLOQUEOS_EN } from './en';
import { BLOQUEOS_ES, type BloqueosMessages } from './es';

export { BLOQUEOS_EN, BLOQUEOS_ES, type BloqueosMessages };
export const BLOQUEOS: BloqueosMessages = localized<BloqueosMessages>({
  es: BLOQUEOS_ES,
  en: BLOQUEOS_EN,
});
