/** Copy of the Pomodoro in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { POMODORO_EN } from './en';
import { POMODORO_ES, type PomodoroMessages } from './es';

export { POMODORO_EN, POMODORO_ES, type PomodoroMessages };
export const POMODORO: PomodoroMessages = localized<PomodoroMessages>({
  es: POMODORO_ES,
  en: POMODORO_EN,
});
