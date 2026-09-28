/** Copy of the OSD window in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { OSD_EN } from './en';
import { OSD_ES, type OsdMessages } from './es';

export { OSD_EN, OSD_ES, type OsdMessages };
export const OSD: OsdMessages = localized<OsdMessages>({ es: OSD_ES, en: OSD_EN });
