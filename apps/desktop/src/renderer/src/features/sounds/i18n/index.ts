/** Copy of the concentration sounds in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { SOUNDS_EN } from './en';
import { SOUNDS_ES, type SoundsMessages } from './es';

export { SOUNDS_EN, SOUNDS_ES, type SoundsMessages };
export const SOUNDS: SoundsMessages = localized<SoundsMessages>({ es: SOUNDS_ES, en: SOUNDS_EN });
