/** Copy of the Nuclear overlay in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { NUCLEAR_EN } from './en';
import { NUCLEAR_ES, type NuclearMessages } from './es';

export { NUCLEAR_EN, NUCLEAR_ES, type NuclearMessages };
export const NUCLEAR: NuclearMessages = localized<NuclearMessages>({
  es: NUCLEAR_ES,
  en: NUCLEAR_EN,
});
