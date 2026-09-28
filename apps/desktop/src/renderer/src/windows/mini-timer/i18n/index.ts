/** Copy of the mini timer in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { MINI_TIMER_EN } from './en';
import { MINI_TIMER_ES, type MiniTimerMessages } from './es';

export { MINI_TIMER_EN, MINI_TIMER_ES, type MiniTimerMessages };
export const MINI_TIMER: MiniTimerMessages = localized<MiniTimerMessages>({
  es: MINI_TIMER_ES,
  en: MINI_TIMER_EN,
});
