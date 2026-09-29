/** Notification copy in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../shared/i18n/locale';
import { NOTIFY_EN } from './en';
import { NOTIFY_ES, type NotifyMessages } from './es';

export { NOTIFY_EN, NOTIFY_ES, type NotifyMessages };
export const NOTIFY: NotifyMessages = localized<NotifyMessages>({ es: NOTIFY_ES, en: NOTIFY_EN });
