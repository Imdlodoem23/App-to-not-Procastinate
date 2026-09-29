/** Reminder copy in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../shared/i18n/locale';
import { REMINDERS_EN } from './en';
import { REMINDERS_ES, type RemindersMessages } from './es';

export { REMINDERS_EN, REMINDERS_ES, type RemindersMessages };
export const REMINDERS: RemindersMessages = localized<RemindersMessages>({
  es: REMINDERS_ES,
  en: REMINDERS_EN,
});
