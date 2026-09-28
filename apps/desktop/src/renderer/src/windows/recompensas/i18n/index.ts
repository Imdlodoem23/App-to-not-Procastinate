/** Copy of the Recompensas window in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { RECOMPENSAS_EN } from './en';
import { RECOMPENSAS_ES, type RecompensasMessages } from './es';

export { RECOMPENSAS_EN, RECOMPENSAS_ES, type RecompensasMessages };
export const RECOMPENSAS: RecompensasMessages = localized<RecompensasMessages>({
  es: RECOMPENSAS_ES,
  en: RECOMPENSAS_EN,
});
