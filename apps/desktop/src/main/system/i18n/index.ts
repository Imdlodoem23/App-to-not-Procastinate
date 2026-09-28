/** «Copiar diagnóstico» headers in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../shared/i18n/locale';
import { DIAGNOSTICS_EN } from './en';
import { DIAGNOSTICS_ES, type DiagnosticsMessages } from './es';

export { DIAGNOSTICS_EN, DIAGNOSTICS_ES, type DiagnosticsMessages };
export const DIAGNOSTICS: DiagnosticsMessages = localized<DiagnosticsMessages>({
  es: DIAGNOSTICS_ES,
  en: DIAGNOSTICS_EN,
});
