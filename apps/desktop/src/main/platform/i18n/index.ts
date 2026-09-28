/** Platform copy in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../shared/i18n/locale';
import { PLATFORM_EN } from './en';
import { PLATFORM_ES, type PlatformMessages } from './es';

export { PLATFORM_EN, PLATFORM_ES, type PlatformMessages };
export const PLATFORM: PlatformMessages = localized<PlatformMessages>({
  es: PLATFORM_ES,
  en: PLATFORM_EN,
});
