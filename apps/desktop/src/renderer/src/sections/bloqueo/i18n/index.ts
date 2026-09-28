/** Copy of section 2 «Bloqueo» in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { BLOQUEO_EN } from './en';
import { BLOQUEO_ES, type BloqueoMessages } from './es';

export { BLOQUEO_EN, BLOQUEO_ES, type BloqueoMessages };
export const BLOQUEO: BloqueoMessages = localized<BloqueoMessages>({ es: BLOQUEO_ES, en: BLOQUEO_EN });
