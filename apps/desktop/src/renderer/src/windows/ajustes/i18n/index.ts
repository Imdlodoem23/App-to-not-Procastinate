/** Copy of the Ajustes window in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { AJUSTES_EN } from './en';
import { AJUSTES_ES, type AjustesMessages } from './es';

export { AJUSTES_EN, AJUSTES_ES, type AjustesMessages };
export const AJUSTES: AjustesMessages = localized<AjustesMessages>({ es: AJUSTES_ES, en: AJUSTES_EN });
