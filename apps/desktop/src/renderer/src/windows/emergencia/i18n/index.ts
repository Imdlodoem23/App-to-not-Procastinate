/** Copy of the Emergencia window in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { EMERGENCIA_EN } from './en';
import { EMERGENCIA_ES, type EmergenciaMessages } from './es';

export { EMERGENCIA_EN, EMERGENCIA_ES, type EmergenciaMessages };
export const EMERGENCIA: EmergenciaMessages = localized<EmergenciaMessages>({ es: EMERGENCIA_ES, en: EMERGENCIA_EN });
