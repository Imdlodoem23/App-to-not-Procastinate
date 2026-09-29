/** Phase 5 footer copy in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { FOOTER_EN } from './en';
import { FOOTER_ES, type FooterMessages } from './es';

export { FOOTER_EN, FOOTER_ES, type FooterMessages };
export const FOOTER: FooterMessages = localized<FooterMessages>({ es: FOOTER_ES, en: FOOTER_EN });
