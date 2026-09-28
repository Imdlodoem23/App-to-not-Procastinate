/** Copy of the onboarding in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { ONBOARDING_EN } from './en';
import { ONBOARDING_ES, type OnboardingMessages } from './es';

export { ONBOARDING_EN, ONBOARDING_ES, type OnboardingMessages };
export const ONBOARDING: OnboardingMessages = localized<OnboardingMessages>({
  es: ONBOARDING_ES,
  en: ONBOARDING_EN,
});
