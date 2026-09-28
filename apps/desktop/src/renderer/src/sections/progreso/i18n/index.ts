/** Copy of section 4 «Progreso» in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { PROGRESO_EN } from './en';
import { PROGRESO_ES, type ProgresoMessages } from './es';

export { PROGRESO_EN, PROGRESO_ES, type ProgresoMessages };
export const PROGRESO: ProgresoMessages = localized<ProgresoMessages>({
  es: PROGRESO_ES,
  en: PROGRESO_EN,
});
