/** Copy of the Estadísticas window in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../../../shared/i18n/locale';
import { ESTADISTICAS_EN } from './en';
import { ESTADISTICAS_ES, type EstadisticasMessages } from './es';

export { ESTADISTICAS_EN, ESTADISTICAS_ES, type EstadisticasMessages };
export const ESTADISTICAS: EstadisticasMessages = localized<EstadisticasMessages>({
  es: ESTADISTICAS_ES,
  en: ESTADISTICAS_EN,
});
